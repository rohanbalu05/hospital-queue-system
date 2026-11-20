/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ApiError,
  ArrivalResult,
  CallNextResult,
  DisplaySnapshot,
  PatientQueueSnapshot,
  QueueVersionNotice,
  SessionAvailability,
  StaffQueueSnapshot,
} from '@hqms/contracts';
import {
  type Client,
  type MadeSession,
  type TestApp,
  at,
  count,
  createTestApp,
  doctorId,
  loginAs,
  makeSession,
  patientId,
} from './helpers.js';

/**
 * B1 (D-032): the doctor availability lifecycle. "Step away" = pause (open or paused -> paused, update allowed),
 * "I'm back" = resume, "unavailable" stays one-way. Availability is carried on every read.
 */

let t: TestApp;
let port: number;
let admin: Client;
let reception: Client;
let reception2: Client;
let patient1: Client;
let patient2: Client;
let doctor: Client; // doctor 8
const doctorNo = 8;
const sockets: http.ClientRequest[] = [];

beforeAll(async () => {
  process.env['SSE_PING_MS'] = '200';
  process.env['SSE_POLL_MS'] = '100';
  t = await createTestApp();
  await t.app.listen(0, '127.0.0.1');
  port = (t.app.getHttpServer().address() as AddressInfo).port;
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  reception2 = await loginAs(t.server, 'reception2@hqms.test'); // doctors 1 and 2 only
  patient1 = await loginAs(t.server, 'patient@hqms.test');
  patient2 = await loginAs(t.server, 'patient2@hqms.test');
  doctor = await loginAs(t.server, `doctor${doctorNo}@hqms.test`);
});
afterAll(async () => {
  for (const r of sockets) r.destroy();
  await t.close();
  delete process.env['SSE_PING_MS'];
  delete process.env['SSE_POLL_MS'];
});
beforeEach(() => t.clock.reset());

const displayGet = () => request(t.server).get('/display/sessions');
const errorCode = (body: unknown): string => ApiError.parse(body).error.code;

async function mk(): Promise<MadeSession> {
  await t.pool.query(
    `UPDATE queue_entries SET state = 'skipped', skipped_at = now() WHERE doctor_id = $1 AND state IN ('called','in_service')`,
    [doctorId(doctorNo)],
  );
  return makeSession(admin, { doctor: doctorNo });
}

async function walkIn(s: MadeSession, p: number, minute: number): Promise<ArrivalResult> {
  t.clock.set(at(s, minute));
  const res = await reception.post(`/sessions/${s.id}/walk-ins`, { patientId: patientId(p) });
  expect(res.status).toBe(201);
  return ArrivalResult.parse(res.body);
}

async function open(s: MadeSession, minute = 1): Promise<void> {
  t.clock.set(at(s, minute));
  expect((await doctor.post(`/sessions/${s.id}/open`, {})).status).toBe(200);
}

const staffSnap = async (s: MadeSession, who: Client = reception) =>
  StaffQueueSnapshot.parse((await who.get(`/sessions/${s.id}/queue`)).body);

const sessionRow = async (id: string) =>
  (await t.pool.query(`SELECT status, paused_at, pause_until, pause_reason, queue_version FROM sessions WHERE id = $1`, [id])).rows[0]!;

const lastEvent = async (id: string, type: string) =>
  (
    await t.pool.query(
      `SELECT payload FROM outbox_events WHERE session_id = $1 AND event_type = $2 ORDER BY position DESC LIMIT 1`,
      [id, type],
    )
  ).rows[0] as { payload: Record<string, unknown> };

describe('B1 step away / I am back', () => {
  it('step away from open: away, expected return and reason for staff; patient and display never see the reason', async () => {
    const s = await mk();
    await walkIn(s, 1, 0);
    await open(s);
    const until = at(s, 31);
    t.clock.set(at(s, 1));
    const res = await doctor.post(`/sessions/${s.id}/pause`, { until: until.toISOString(), reason: 'Ward round call' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paused');

    const staff = await staffSnap(s);
    expect(staff.availability).toMatchObject({
      state: 'away',
      expectedBackAt: until.toISOString(),
      overdue: false,
      reason: 'Ward round call',
      since: at(s, 1).toISOString(),
    });
    const mine = PatientQueueSnapshot.parse((await patient1.get(`/sessions/${s.id}/queue`)).body);
    expect(mine.availability).toMatchObject({ state: 'away', expectedBackAt: until.toISOString(), reason: null });
    expect(mine.doctorName).toMatch(/\S/);
    expect(JSON.stringify(mine)).not.toContain('Ward round call');

    const display = DisplaySnapshot.parse((await displayGet()).body);
    const col = display.columns.find((c) => c.sessionId === s.id)!;
    expect(col.availability).toMatchObject({ state: 'away', reason: null });
    expect(JSON.stringify(display)).not.toContain('Ward round call');
  });

  it('is allowed again while away: updates the expected return, keeps the original paused_at, emits SessionPaused with update:true', async () => {
    const s = await mk();
    await open(s);
    t.clock.set(at(s, 2));
    expect((await doctor.post(`/sessions/${s.id}/pause`, { until: at(s, 12).toISOString(), reason: 'First reason' })).status).toBe(200);
    const first = await sessionRow(s.id);
    t.clock.set(at(s, 5));
    const upd = await reception.post(`/sessions/${s.id}/pause`, { until: at(s, 40).toISOString(), reason: 'Longer than thought' });
    expect(upd.status).toBe(200);
    const after = await sessionRow(s.id);
    expect(after.status).toBe('paused');
    expect(new Date(after.paused_at).toISOString()).toBe(new Date(first.paused_at).toISOString());
    expect(new Date(after.pause_until).toISOString()).toBe(at(s, 40).toISOString());
    expect(after.pause_reason).toBe('Longer than thought');
    expect(Number(after.queue_version)).toBeGreaterThan(Number(first.queue_version));

    const ev = await lastEvent(s.id, 'SessionPaused');
    expect(ev.payload).toEqual({
      queueVersion: Number(after.queue_version),
      status: 'paused',
      pauseUntil: at(s, 40).toISOString(),
      update: true,
      doctorId: doctorId(doctorNo),
    });
    // the first pause was update:false
    const first1 = (
      await t.pool.query(`SELECT payload FROM outbox_events WHERE session_id = $1 AND event_type = 'SessionPaused' ORDER BY position ASC LIMIT 1`, [s.id])
    ).rows[0]!;
    expect(first1.payload.update).toBe(false);
    // the audit row keeps the reason; the outbox never carries free text
    expect(JSON.stringify(ev.payload)).not.toContain('Longer than thought');
    expect(
      await count(t.pool, `SELECT 1 FROM audit_events WHERE entity_id = $1 AND operation = 'session.pause' AND reason = 'Longer than thought'`, [s.id]),
    ).toBe(1);
  });

  it('is refused with 409 DOCTOR_OCCUPIED while a patient is called but not started; allowed while one is in service', async () => {
    const s = await mk();
    const w = await walkIn(s, 1, 0);
    await walkIn(s, 2, 0);
    await open(s);
    t.clock.set(at(s, 2));
    const call = CallNextResult.parse((await doctor.post(`/sessions/${s.id}/call-next`, {})).body);
    expect(call.entry).not.toBeNull();
    const blocked = await doctor.post(`/sessions/${s.id}/pause`, { until: at(s, 20).toISOString() });
    expect(blocked.status).toBe(409);
    expect(errorCode(blocked.body)).toBe('DOCTOR_OCCUPIED');
    expect((await sessionRow(s.id)).status).toBe('open');
    // start: in_service is allowed
    t.clock.set(at(s, 3));
    expect((await doctor.post(`/visits/${call.entry!.visitId}/start`, {})).status).toBe(200);
    expect((await doctor.post(`/sessions/${s.id}/pause`, { until: at(s, 20).toISOString() })).status).toBe(200);
    expect(w.queueEntryId).toBeTruthy();
  });

  it('400 VALIDATION_FAILED when until is not in the future, or is after the session end', async () => {
    const s = await mk();
    await open(s);
    t.clock.set(at(s, 10));
    const past = await doctor.post(`/sessions/${s.id}/pause`, { until: at(s, 10).toISOString() });
    expect(past.status).toBe(400);
    expect(errorCode(past.body)).toBe('VALIDATION_FAILED');
    const late = await doctor.post(`/sessions/${s.id}/pause`, { until: at(s, 241).toISOString() });
    expect(late.status).toBe(400);
    expect(errorCode(late.body)).toBe('VALIDATION_FAILED');
    expect(ApiError.parse(late.body).error.message).toBe(
      'The expected return is after the session ends. Mark the doctor unavailable instead.',
    );
    expect((await sessionRow(s.id)).status).toBe('open');
    // exactly at the end is allowed
    expect((await doctor.post(`/sessions/${s.id}/pause`, { until: at(s, 240).toISOString() })).status).toBe(200);
  });

  it('who may step away: the own doctor, reception in scope and admin; reception of other doctors is 403', async () => {
    const s = await mk();
    await open(s);
    t.clock.set(at(s, 3));
    expect((await reception2.post(`/sessions/${s.id}/pause`, {})).status).toBe(403); // doctors 1 and 2 only
    expect((await patient1.post(`/sessions/${s.id}/pause`, {})).status).toBe(403);
    expect((await admin.post(`/sessions/${s.id}/pause`, { until: at(s, 30).toISOString() })).status).toBe(200);
    expect((await doctor.post(`/sessions/${s.id}/resume`, {})).status).toBe(200);
    expect((await reception.post(`/sessions/${s.id}/pause`, {})).status).toBe(200);
  });

  it('resume: paused -> open, clears the away data, emits SessionResumed with the routing payload; open cannot resume', async () => {
    const s = await mk();
    await open(s);
    t.clock.set(at(s, 3));
    expect((await doctor.post(`/sessions/${s.id}/pause`, { until: at(s, 30).toISOString(), reason: 'Quick break' })).status).toBe(200);
    t.clock.set(at(s, 8));
    expect((await doctor.post(`/sessions/${s.id}/resume`, {})).status).toBe(200);
    const row = await sessionRow(s.id);
    expect(row).toMatchObject({ status: 'open', paused_at: null, pause_until: null, pause_reason: null });
    const ev = await lastEvent(s.id, 'SessionResumed');
    expect(ev.payload).toEqual({
      queueVersion: Number(row.queue_version),
      status: 'open',
      pauseUntil: null,
      update: false,
      doctorId: doctorId(doctorNo),
    });
    expect(errorCode((await doctor.post(`/sessions/${s.id}/resume`, {})).body)).toBe('INVALID_TRANSITION');
    expect((await staffSnap(s)).availability.state).toBe('available');
  });

  it('unavailable stays one-way and its outbox payload carries the doctor id, never the reason', async () => {
    const s = await mk();
    await open(s);
    t.clock.set(at(s, 3));
    expect((await doctor.post(`/sessions/${s.id}/unavailable`, { reason: 'Family emergency' })).status).toBe(200);
    const ev = await lastEvent(s.id, 'SessionUnavailable');
    expect(ev.payload).toMatchObject({ status: 'unavailable', update: false, doctorId: doctorId(doctorNo) });
    expect(JSON.stringify(ev.payload)).not.toContain('Family emergency');
    expect(errorCode((await doctor.post(`/sessions/${s.id}/resume`, {})).body)).toBe('INVALID_TRANSITION');
    expect(errorCode((await doctor.post(`/sessions/${s.id}/pause`, {})).body)).toBe('INVALID_TRANSITION');
    const staff = await staffSnap(s);
    expect(staff.availability).toMatchObject({ state: 'unavailable', reason: 'Family emergency' });
    const mine = await walkInThenPatient(s);
    expect(mine.availability).toMatchObject({ state: 'unavailable', reason: null });
  });

  async function walkInThenPatient(s: MadeSession) {
    // check-in is refused for an unavailable session, so insert the entry the way an earlier arrival would have
    await t.pool.query(`UPDATE sessions SET status = 'open' WHERE id = $1`, [s.id]);
    await walkIn(s, 2, 5);
    await t.pool.query(`UPDATE sessions SET status = 'unavailable' WHERE id = $1`, [s.id]);
    return PatientQueueSnapshot.parse((await patient2.get(`/sessions/${s.id}/queue`)).body);
  }
});

describe('B1 availability on every read', () => {
  it('the display lists an unavailable in-window session; a closed one drops off; the cache fingerprint follows pause_until', async () => {
    const s = await mk();
    await open(s);
    t.clock.set(at(s, 3));
    expect((await doctor.post(`/sessions/${s.id}/pause`, { until: at(s, 20).toISOString() })).status).toBe(200);
    const col = async () => DisplaySnapshot.parse((await displayGet()).body).columns.find((c) => c.sessionId === s.id);
    expect((await col())!.availability.expectedBackAt).toBe(at(s, 20).toISOString());
    // update the expected return only: status and queue_version change, so a cached screen must change too
    expect((await doctor.post(`/sessions/${s.id}/pause`, { until: at(s, 45).toISOString() })).status).toBe(200);
    expect((await col())!.availability.expectedBackAt).toBe(at(s, 45).toISOString());
    expect((await doctor.post(`/sessions/${s.id}/unavailable`, { reason: 'Sent home unwell' })).status).toBe(200);
    const unavailable = (await col())!;
    expect(unavailable.status).toBe('unavailable');
    expect(unavailable.availability).toMatchObject({ state: 'unavailable', reason: null });
    expect(unavailable.nowCalling).toBeNull();
    // closed sessions leave the screen
    expect((await doctor.post(`/sessions/${s.id}/close`, {})).status).toBe(200);
    expect(await col()).toBeUndefined();
  });

  it('available / overdue states follow the clock', async () => {
    const s = await mk();
    await walkIn(s, 1, 0);
    await open(s);
    expect(SessionAvailability.parse((await staffSnap(s)).availability).state).toBe('available');
    t.clock.set(at(s, 3));
    expect((await doctor.post(`/sessions/${s.id}/pause`, { until: at(s, 13).toISOString() })).status).toBe(200);
    t.clock.set(at(s, 14));
    const late = await staffSnap(s);
    expect(late.availability).toMatchObject({ state: 'away', overdue: true });
    const mine = PatientQueueSnapshot.parse((await patient1.get(`/sessions/${s.id}/queue`)).body);
    expect(mine.myEntry!.eta).toMatchObject({ status: 'withheld', note: 'The doctor is away longer than expected' });
  });

  it('the ETA of a waiting patient starts at the expected return', async () => {
    const s = await mk();
    await walkIn(s, 1, 0);
    await open(s);
    t.clock.set(at(s, 2));
    const base = PatientQueueSnapshot.parse((await patient1.get(`/sessions/${s.id}/queue`)).body).myEntry!.eta;
    expect(base.status).toBe('ok');
    expect((await doctor.post(`/sessions/${s.id}/pause`, { until: at(s, 32).toISOString() })).status).toBe(200);
    const away = PatientQueueSnapshot.parse((await patient1.get(`/sessions/${s.id}/queue`)).body).myEntry!.eta;
    expect(away.status).toBe('ok');
    expect(away.lowMinutes!).toBeGreaterThanOrEqual(15); // 30 minutes of absence at the 50% cold-start band
    expect(away.note).toMatch(/known pause/);
  });
});

describe('B1 call-next while away', () => {
  it('away -> call-next 409 -> back -> call-next picks the same candidate it would have picked before; order and pointer are kept', async () => {
    const s = await mk();
    // Two group-A (booked) patients and one walk-in: rotation A,A,W.
    const a1 = await booked(s, 1, 0);
    const a2 = await booked(s, 2, 1);
    const w1 = await walkIn(s, 3, 2);
    await open(s, 3);
    // serve A1 so the pointer has moved on
    t.clock.set(at(s, 4));
    const first = CallNextResult.parse((await doctor.post(`/sessions/${s.id}/call-next`, {})).body);
    expect(first.entry!.id).toBe(a1.queueEntryId);
    t.clock.set(at(s, 5));
    expect((await doctor.post(`/visits/${first.entry!.visitId}/start`, {})).status).toBe(200);
    t.clock.set(at(s, 9));
    expect((await doctor.post(`/visits/${first.entry!.visitId}/complete`, {})).status).toBe(200);

    const before = await staffSnap(s);
    expect(before.waiting.map((e) => e.id)).toEqual([a2.queueEntryId, w1.queueEntryId]);

    t.clock.set(at(s, 10));
    expect((await doctor.post(`/sessions/${s.id}/pause`, { until: at(s, 40).toISOString(), reason: 'Phone call' })).status).toBe(200);
    t.clock.set(at(s, 12));
    const blocked = await doctor.post(`/sessions/${s.id}/call-next`, {});
    expect(blocked.status).toBe(409);
    expect(errorCode(blocked.body)).toBe('SESSION_NOT_CALLABLE');
    const away = await staffSnap(s);
    expect(away.rotationPointer).toBe(before.rotationPointer);
    expect(away.waiting.map((e) => e.id)).toEqual(before.waiting.map((e) => e.id));

    t.clock.set(at(s, 20));
    expect((await doctor.post(`/sessions/${s.id}/resume`, {})).status).toBe(200);
    const back = await staffSnap(s);
    expect(back.rotationPointer).toBe(before.rotationPointer);
    expect(back.waiting.map((e) => e.id)).toEqual(before.waiting.map((e) => e.id));
    t.clock.set(at(s, 21));
    const next = CallNextResult.parse((await doctor.post(`/sessions/${s.id}/call-next`, {})).body);
    expect(next.entry!.id).toBe(a2.queueEntryId); // the second A slot, exactly as before stepping away
    expect(next.decision.reason).toBe('ROTATION');
  });

  async function booked(s: MadeSession, p: number, minute: number): Promise<ArrivalResult> {
    t.clock.reset();
    const b = await reception.post('/appointments', { sessionId: s.id, patientId: patientId(p) });
    expect(b.status).toBe(201);
    t.clock.set(at(s, minute));
    const r = await reception.post(`/appointments/${b.body.id}/check-in`, {});
    expect(r.status).toBe(201);
    return ArrivalResult.parse(r.body);
  }
});

describe('B1 live notices reach every audience', () => {
  function connect(path: string, cookie?: string): Promise<{ events: Array<{ event: string; data: string }>; close(): void }> {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path, headers: cookie ? { Cookie: cookie } : {} }, (res) => {
        const events: Array<{ event: string; data: string }> = [];
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let event = 'message';
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (event !== 'message') events.push({ event, data });
          }
        });
        resolve({ events, close: () => req.destroy() });
      });
      sockets.push(req);
      req.on('error', (e) => {
        if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e);
      });
    });
  }

  const versions = (c: { events: Array<{ event: string; data: string }> }, sessionId: string) =>
    c.events
      .filter((e) => e.event === 'queue')
      .map((e) => QueueVersionNotice.parse(JSON.parse(e.data)))
      .filter((n) => n.sessionId === sessionId);

  async function until(fn: () => boolean, ms = 3000): Promise<void> {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw new Error('timed out waiting for a live notice');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('step away, back and unavailable bump the version: doctor, reception, patient and display streams all get a notice', async () => {
    const s = await mk();
    await walkIn(s, 1, 0);
    await open(s);
    t.clock.set(at(s, 2));
    const streams = {
      doctor: await connect(`/sessions/${s.id}/events`, doctor.cookie),
      reception: await connect(`/sessions/${s.id}/events`, reception.cookie),
      patient: await connect(`/sessions/${s.id}/events`, patient1.cookie),
      display: await connect('/display/events'),
    };
    for (const c of Object.values(streams)) await until(() => versions(c, s.id).length >= 1);
    const base = Object.fromEntries(Object.entries(streams).map(([k, c]) => [k, versions(c, s.id).at(-1)!.queueVersion]));

    const step = async (label: string, run: () => Promise<{ status: number }>) => {
      const marks = Object.fromEntries(Object.entries(streams).map(([k, c]) => [k, versions(c, s.id).at(-1)!.queueVersion]));
      expect((await run()).status, label).toBe(200);
      for (const [k, c] of Object.entries(streams)) {
        await until(() => versions(c, s.id).at(-1)!.queueVersion > marks[k]!);
      }
    };
    await step('step away', () => doctor.post(`/sessions/${s.id}/pause`, { until: at(s, 30).toISOString() }));
    await step('update', () => doctor.post(`/sessions/${s.id}/pause`, { until: at(s, 40).toISOString() }));
    await step('back', () => doctor.post(`/sessions/${s.id}/resume`, {}));
    await step('unavailable', () => doctor.post(`/sessions/${s.id}/unavailable`, { reason: 'Leaving' }));

    // patients and the display learn only "queue.changed", staff see the event type
    expect(versions(streams.patient, s.id).slice(1).every((n) => n.eventType === 'queue.changed')).toBe(true);
    expect(versions(streams.display, s.id).slice(1).every((n) => n.eventType === 'queue.changed')).toBe(true);
    expect(versions(streams.reception, s.id).some((n) => n.eventType === 'SessionPaused')).toBe(true);
    expect(versions(streams.doctor, s.id).at(-1)!.eventType).toBe('SessionUnavailable');
    expect(versions(streams.display, s.id).at(-1)!.queueVersion).toBeGreaterThan(base['display']!);
    for (const c of Object.values(streams)) c.close();
  });
});
