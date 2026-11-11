/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ApiError,
  ArrivalResult,
  CallNextResult,
  DisplaySnapshot,
  PatientQueueSnapshot,
  QueueDecision,
  QueueEntry,
  StaffQueueSnapshot,
  AuditEvent,
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

let t: TestApp;
let admin: Client;
let reception: Client;
let reception2: Client;
let patientLogin: Record<number, Client>;
const doctors = new Map<number, Client>();

beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  reception2 = await loginAs(t.server, 'reception2@hqms.test'); // doctors 1 and 2 only
  patientLogin = {
    1: await loginAs(t.server, 'patient@hqms.test'),
    2: await loginAs(t.server, 'patient2@hqms.test'),
    3: await loginAs(t.server, 'patient3@hqms.test'),
  };
  for (let n = 1; n <= 9; n += 1) {
    doctors.set(n, await loginAs(t.server, n === 1 ? 'doctor@hqms.test' : `doctor${n}@hqms.test`));
  }
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => t.clock.reset());

const doc = (n: number): Client => doctors.get(n)!;

/** A fresh session for doctor `n`; any call left over from an earlier test is cleared first (test-only SQL). */
async function mk(n: number): Promise<MadeSession> {
  await t.pool.query(
    `UPDATE queue_entries SET state = 'skipped', skipped_at = now() WHERE doctor_id = $1 AND state IN ('called','in_service')`,
    [doctorId(n)],
  );
  return makeSession(admin, { doctor: n });
}
const errorCode = (body: unknown): string => ApiError.parse(body).error.code;

/** Book the next free slot for patient `p`, then check in `minute` minutes after 09:00. */
async function bookAndCheckIn(s: MadeSession, p: number, minute: number): Promise<ArrivalResult> {
  t.clock.reset();
  const booked = await reception.post('/appointments', { sessionId: s.id, patientId: patientId(p) });
  expect(booked.status).toBe(201);
  t.clock.set(at(s, minute));
  const res = await reception.post(`/appointments/${booked.body.id}/check-in`, {});
  expect(res.status).toBe(201);
  return ArrivalResult.parse(res.body);
}

async function walkIn(s: MadeSession, p: number, minute: number): Promise<ArrivalResult> {
  t.clock.set(at(s, minute));
  const res = await reception.post(`/sessions/${s.id}/walk-ins`, { patientId: patientId(p) });
  expect(res.status).toBe(201);
  return ArrivalResult.parse(res.body);
}

async function callNext(s: MadeSession, who: Client, minute?: number) {
  if (minute !== undefined) t.clock.set(at(s, minute));
  return who.post(`/sessions/${s.id}/call-next`, {});
}

/** Call, then start at +1 and complete at +1+duration minutes. Returns the call result. */
async function serve(s: MadeSession, who: Client, minute: number, durationMin = 3): Promise<CallNextResult> {
  const res = await callNext(s, who, minute);
  expect(res.status).toBe(200);
  const called = CallNextResult.parse(res.body);
  const entry = called.entry!;
  t.clock.set(at(s, minute + 1));
  expect((await who.post(`/visits/${entry.visitId}/start`, {})).status).toBe(200);
  t.clock.set(at(s, minute + 1 + durationMin));
  expect((await who.post(`/visits/${entry.visitId}/complete`, {})).status).toBe(200);
  return called;
}

async function queueVersion(sessionId: string): Promise<number> {
  const r = await t.pool.query(`SELECT queue_version FROM sessions WHERE id = $1`, [sessionId]);
  return r.rows[0]!.queue_version as number;
}

describe('FR-06 call-next: Table 8 end to end over HTTP', () => {
  it('A1, A2, W1 -> A1; doctor priority P1 -> P1 (pointer kept); A2; W1; then only W2 -> W2', async () => {
    const s = await mk(1);
    const d = doc(1);
    const a1 = await bookAndCheckIn(s, 1, -5); // 09:00 slot, eligible 08:55
    const a2 = await bookAndCheckIn(s, 2, -2); // 09:20 slot, eligible 09:10
    const w1 = await walkIn(s, 3, 2);

    const c1 = await serve(s, d, 12);
    expect(c1.entry!.id).toBe(a1.queueEntryId);
    expect(c1.decision).toMatchObject({
      reason: 'ROTATION',
      rotationSlot: 0,
      pointerBefore: 0,
      pointerAfter: 1,
      policyVersion: 1,
    });
    expect(c1.decision.explanation).toBe('Called by rotation: 1st appointment of A, A, W');

    const p1 = await walkIn(s, 4, 17);
    t.clock.set(at(s, 17));
    const prio = await d.post(`/queue-entries/${p1.queueEntryId}/priority`, { priorityClass: 1, reason: 'Chest pain on arrival' });
    expect(prio.status).toBe(200);
    expect(QueueEntry.parse(prio.body)).toMatchObject({ priorityClass: 1, priorityReason: 'Chest pain on arrival' });

    const c2 = await serve(s, d, 18);
    expect(c2.entry!.id).toBe(p1.queueEntryId);
    expect(c2.decision).toMatchObject({ reason: 'CLINICAL_PRIORITY', rotationSlot: null, pointerBefore: 1, pointerAfter: 1 });

    const c3 = await serve(s, d, 30);
    expect(c3.entry!.id).toBe(a2.queueEntryId);
    expect(c3.decision).toMatchObject({ reason: 'ROTATION', rotationSlot: 1, pointerBefore: 1, pointerAfter: 2 });

    const c4 = await serve(s, d, 42);
    expect(c4.entry!.id).toBe(w1.queueEntryId);
    expect(c4.decision).toMatchObject({ reason: 'ROTATION', rotationSlot: 2, pointerBefore: 2, pointerAfter: 0 });

    const w2 = await walkIn(s, 5, 47);
    const c5 = await serve(s, d, 54);
    expect(c5.entry!.id).toBe(w2.queueEntryId);
    expect(c5.decision).toMatchObject({ reason: 'ROTATION', rotationSlot: 2, pointerBefore: 0, pointerAfter: 0 });

    // The decision log, oldest first, is the golden trace.
    const log = await d.get(`/sessions/${s.id}/decisions`);
    expect(log.status).toBe(200);
    const rows = (log.body as unknown[]).map((r) => QueueDecision.parse(r)).reverse();
    expect(rows.map((r) => r.reason)).toEqual(['ROTATION', 'CLINICAL_PRIORITY', 'ROTATION', 'ROTATION', 'ROTATION']);
    expect(rows.map((r) => r.pointerAfter)).toEqual([1, 1, 2, 0, 0]);
    expect(rows.every((r) => r.policyVersion === 1 && r.decidedBy === c1.decision.decidedBy)).toBe(true);
    expect(rows.map((r) => r.token)).toEqual(['A-001', 'W-002', 'A-002', 'W-001', 'W-003']);
    const stored = await t.pool.query(`SELECT candidates FROM queue_decisions WHERE id = $1`, [c1.decision.id]);
    expect((stored.rows[0]!.candidates as unknown[]).length).toBe(3); // A1, A2, W1 were eligible
    const ptr = await t.pool.query(`SELECT rotation_pointer FROM sessions WHERE id = $1`, [s.id]);
    expect(ptr.rows[0]!.rotation_pointer).toBe(0);
  });

  it('writes audit (actor, policy version, reason), an outbox event and a call_timeout job in the call transaction', async () => {
    const s = await mk(2);
    const w = await walkIn(s, 6, 0);
    const res = await callNext(s, doc(2), 5);
    expect(res.status).toBe(200);
    const audit = await t.pool.query(
      `SELECT actor_role, reason, policy_version, previous, next FROM audit_events
        WHERE operation = 'queue.call_next' AND entity_id = $1`,
      [w.queueEntryId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_role: 'doctor', policy_version: 1 });
    expect(audit.rows[0]!.reason).toBe(res.body.decision.explanation);
    expect(audit.rows[0]!.next).toMatchObject({ state: 'called', token: w.token, reason: 'ROTATION' });
    const ev = await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'QueuePatientCalled' AND entity_id = $1`, [
      w.queueEntryId,
    ]);
    expect(ev.rows[0]!.payload).toMatchObject({ token: w.token, room: 'OPD 2' });
    const job = await t.pool.query(`SELECT payload, run_at, dedupe_key FROM jobs WHERE dedupe_key = $1`, [
      `call_timeout:${w.queueEntryId}:1`,
    ]);
    expect(job.rows).toHaveLength(1);
    expect(new Date(job.rows[0]!.run_at).getTime()).toBe(at(s, 5).getTime() + 120_000);
    expect(job.rows[0]!.payload).toMatchObject({ queueEntryId: w.queueEntryId, calledAt: at(s, 5).toISOString() });
    expect(res.body.decision.queueVersion).toBe(await queueVersion(s.id));
  });

  it('first call opens a scheduled session; NO_ALLOCATION is recorded as a decision and returns entry null', async () => {
    const s = await mk(2);
    const res = await callNext(s, doc(2), 10); // nobody waiting
    expect(res.status).toBe(200);
    const body = CallNextResult.parse(res.body);
    expect(body.entry).toBeNull();
    expect(body.decision).toMatchObject({ reason: 'NO_ALLOCATION', queueEntryId: null, token: null });
    const status = await t.pool.query(`SELECT status FROM sessions WHERE id = $1`, [s.id]);
    expect(status.rows[0]!.status).toBe('open');
    expect(await count(t.pool, `SELECT 1 FROM queue_decisions WHERE session_id = $1`, [s.id])).toBe(1);
  });

  it('requires an Idempotency-Key; a replay returns the same decision and calls nobody twice', async () => {
    const s = await mk(2);
    await walkIn(s, 7, 0);
    await walkIn(s, 8, 1);
    t.clock.set(at(s, 5));
    const missing = await doc(2).post(`/sessions/${s.id}/call-next`, {}, null);
    expect(missing.status).toBe(400);
    const key = randomUUID();
    const first = await doc(2).post(`/sessions/${s.id}/call-next`, {}, key);
    const again = await doc(2).post(`/sessions/${s.id}/call-next`, {}, key);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.body.decision.id).toBe(first.body.decision.id);
    expect(await count(t.pool, `SELECT 1 FROM queue_entries WHERE session_id = $1 AND state = 'called'`, [s.id])).toBe(1);
    expect(await count(t.pool, `SELECT 1 FROM queue_decisions WHERE session_id = $1`, [s.id])).toBe(1);
  });

  it('authorization: patient 403; reception outside the assignment 403; doctor of another doctor 403', async () => {
    const s = await mk(5);
    expect((await patientLogin[1]!.post(`/sessions/${s.id}/call-next`, {})).status).toBe(403);
    expect((await reception2.post(`/sessions/${s.id}/call-next`, {})).status).toBe(403); // reception2: doctors 1-2
    expect((await doc(1).post(`/sessions/${s.id}/call-next`, {})).status).toBe(403);
    const unknown = await doc(5).post(`/sessions/${randomUUID()}/call-next`, {});
    expect(unknown.status).toBe(404);
  });
});

describe('FR-07 non-preemptive: one active allocation per doctor', () => {
  it('DOCTOR_OCCUPIED while a patient is called or in service, with the active token in the details', async () => {
    const s = await mk(2);
    const w1 = await walkIn(s, 9, 0);
    await walkIn(s, 10, 1);
    const first = await callNext(s, doc(2), 5);
    expect(first.status).toBe(200);
    const blocked = await callNext(s, doc(2), 6);
    expect(blocked.status).toBe(409);
    expect(ApiError.parse(blocked.body).error).toMatchObject({ code: 'DOCTOR_OCCUPIED', details: { token: w1.token, state: 'called' } });

    t.clock.set(at(s, 7));
    expect((await doc(2).post(`/visits/${w1.visitId}/start`, {})).status).toBe(200);
    expect(errorCode((await callNext(s, doc(2), 8)).body)).toBe('DOCTOR_OCCUPIED');
    // Reception for that doctor is refused the same way.
    expect(errorCode((await reception.post(`/sessions/${s.id}/call-next`, {})).body)).toBe('DOCTOR_OCCUPIED');
  });

  it('FR-07: overlapping sessions of one doctor share the allocation', async () => {
    const s1 = await mk(3);
    // Second session of the same doctor, 11:00-15:00, overlapping the first (09:00-13:00).
    const startsAt = `${s1.date}T11:00:00+05:30`;
    const created = await admin.post(
      '/sessions',
      { doctorId: doctorId(3), sessionDate: s1.date, label: 'afternoon', startsAt, endsAt: `${s1.date}T15:00:00+05:30` },
      null,
    );
    expect(created.status).toBe(201);
    const s2: MadeSession = { id: created.body.id as string, date: s1.date, startsAt: new Date(startsAt).toISOString() };

    const w1 = await walkIn(s1, 11, 0);
    await walkIn(s2, 12, 125); // 11:05
    expect((await callNext(s1, doc(3), 130)).status).toBe(200); // calls W1 in session 1
    const blocked = await callNext(s2, doc(3), 131);
    expect(blocked.status).toBe(409);
    expect(ApiError.parse(blocked.body).error).toMatchObject({ code: 'DOCTOR_OCCUPIED', details: { token: w1.token, sessionId: s1.id } });

    // The staff snapshot of session 2 shows the active entry from session 1.
    const snap = StaffQueueSnapshot.parse((await doc(3).get(`/sessions/${s2.id}/queue`)).body);
    expect(snap.active?.sessionId).toBe(s1.id);
    expect(snap.waiting).toHaveLength(1);
  });

  it('20 concurrent call-next across both sessions: exactly one call, the rest DOCTOR_OCCUPIED, never two active rows', async () => {
    const s1 = await mk(4);
    const startsAt = `${s1.date}T11:00:00+05:30`;
    const created = await admin.post(
      '/sessions',
      { doctorId: doctorId(4), sessionDate: s1.date, label: 'afternoon', startsAt, endsAt: `${s1.date}T15:00:00+05:30` },
      null,
    );
    const s2: MadeSession = { id: created.body.id as string, date: s1.date, startsAt: new Date(startsAt).toISOString() };
    await walkIn(s1, 13, 0);
    await walkIn(s1, 14, 1);
    await walkIn(s2, 15, 121);
    await walkIn(s2, 16, 122);
    t.clock.set(at(s1, 150));

    const calls = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? s1 : s2)).map((s) => doc(4).post(`/sessions/${s.id}/call-next`, {})),
    );
    const codes = calls.map((r) => r.status);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(19);
    for (const r of calls.filter((x) => x.status === 409)) expect(errorCode(r.body)).toBe('DOCTOR_OCCUPIED');
    const winner = calls.find((r) => r.status === 200)!;
    expect(CallNextResult.parse(winner.body).entry).not.toBeNull();
    expect(
      await count(t.pool, `SELECT 1 FROM queue_entries WHERE doctor_id = $1 AND state IN ('called','in_service')`, [doctorId(4)]),
    ).toBe(1);
  });
});

describe('FR-08 session controls, skip, re-entry', () => {
  it('pause -> call-next SESSION_NOT_CALLABLE -> resume -> call works (FR-08-a)', async () => {
    const s = await mk(6);
    await walkIn(s, 18, 0);
    t.clock.set(at(s, 1));
    expect((await doc(6).post(`/sessions/${s.id}/open`, {})).status).toBe(200);
    expect((await doc(6).post(`/sessions/${s.id}/pause`, {})).status).toBe(200);
    const blocked = await callNext(s, doc(6), 3);
    expect(blocked.status).toBe(409);
    expect(errorCode(blocked.body)).toBe('SESSION_NOT_CALLABLE');
    expect((await doc(6).post(`/sessions/${s.id}/pause`, {})).status).toBe(409); // already paused
    expect(errorCode((await doc(6).post(`/sessions/${s.id}/open`, {})).body)).toBe('INVALID_TRANSITION');
    expect((await doc(6).post(`/sessions/${s.id}/resume`, {})).status).toBe(200);
    expect((await callNext(s, doc(6), 4)).status).toBe(200);
    expect(await count(t.pool, `SELECT 1 FROM audit_events WHERE entity_id = $1 AND operation LIKE 'session.%'`, [s.id])).toBeGreaterThanOrEqual(4);
  });

  it('FR-08-d: unavailable keeps waiting patients in the session (no reassignment) and blocks calls; ETA is withheld', async () => {
    const s = await mk(6);
    const w = await walkIn(s, 19, 0);
    t.clock.set(at(s, 1));
    expect((await doc(6).post(`/sessions/${s.id}/unavailable`, { reason: 'Doctor called to surgery' })).status).toBe(200);
    expect(await count(t.pool, `SELECT 1 FROM queue_entries WHERE session_id = $1 AND state = 'waiting'`, [s.id])).toBe(1);
    expect(errorCode((await callNext(s, doc(6), 3)).body)).toBe('SESSION_NOT_CALLABLE');
    const snap = StaffQueueSnapshot.parse((await reception.get(`/sessions/${s.id}/queue`)).body);
    expect(snap.status).toBe('unavailable');
    expect(snap.waiting.map((e) => e.id)).toEqual([w.queueEntryId]);
    // Close keeps them visible too.
    expect((await doc(6).post(`/sessions/${s.id}/close`, {})).status).toBe(200);
    expect(StaffQueueSnapshot.parse((await reception.get(`/sessions/${s.id}/queue`)).body).waiting).toHaveLength(1);
    expect(await count(t.pool, `SELECT 1 FROM outbox_events WHERE event_type = 'SessionUnavailable' AND session_id = $1`, [s.id])).toBe(1);
  });

  it('FR-08-b: skip then re-entry reuses the SAME queue entry with fresh eligibility and the call history kept', async () => {
    const s = await mk(7);
    const w = await walkIn(s, 20, 0);
    const called = CallNextResult.parse((await callNext(s, doc(7), 5)).body);
    const calledEntry = called.entry!;
    expect(calledEntry).toMatchObject({ state: 'called', callCount: 1 });

    t.clock.set(at(s, 6));
    const skipped = await reception.post(`/queue-entries/${w.queueEntryId}/skip`, { expectedVersion: calledEntry.version, reason: 'Not in the waiting area' });
    expect(skipped.status).toBe(200);
    expect(QueueEntry.parse(skipped.body).state).toBe('skipped');
    expect(await count(t.pool, `SELECT 1 FROM jobs WHERE dedupe_key = $1 AND state = 'cancelled'`, [`call_timeout:${w.queueEntryId}:1`])).toBe(1);
    // The doctor is free again.
    const before = await t.pool.query(`SELECT eligible_at, called_at, call_count FROM queue_entries WHERE id = $1`, [w.queueEntryId]);

    t.clock.set(at(s, 20));
    const back = await reception.post(`/queue-entries/${w.queueEntryId}/re-enter`, {});
    expect(back.status).toBe(200);
    const entry = QueueEntry.parse(back.body);
    expect(entry).toMatchObject({ id: w.queueEntryId, state: 'waiting', callCount: 1, token: w.token });
    const after = await t.pool.query(`SELECT eligible_at, called_at, call_count, skipped_at FROM queue_entries WHERE id = $1`, [w.queueEntryId]);
    expect(new Date(after.rows[0]!.eligible_at).getTime()).toBeGreaterThan(new Date(before.rows[0]!.eligible_at).getTime());
    expect(new Date(after.rows[0]!.eligible_at).getTime()).toBe(at(s, 20).getTime());
    expect(after.rows[0]!.call_count).toBe(1);
    expect(new Date(after.rows[0]!.called_at).getTime()).toBe(at(s, 5).getTime());
    expect(after.rows[0]!.skipped_at).not.toBeNull();
    expect(await count(t.pool, `SELECT 1 FROM queue_entries WHERE visit_id = $1`, [w.visitId])).toBe(1);
    expect(await count(t.pool, `SELECT 1 FROM audit_events WHERE operation = 'queue.re_enter' AND entity_id = $1`, [w.queueEntryId])).toBe(1);

    // A second call increments call_count on the same row; the old call_timeout job is not reused (new dedupe key).
    const second = CallNextResult.parse((await callNext(s, doc(7), 21)).body);
    expect(second.entry).toMatchObject({ id: w.queueEntryId, callCount: 2 });
    expect(await count(t.pool, `SELECT 1 FROM jobs WHERE dedupe_key = $1`, [`call_timeout:${w.queueEntryId}:2`])).toBe(1);
    // A re-entry of an entry that is not skipped/absent is an invalid transition.
    expect(errorCode((await reception.post(`/queue-entries/${w.queueEntryId}/re-enter`, {})).body)).toBe('INVALID_TRANSITION');
  });

  it('absent: a waiting patient is parked and not called; re-entry puts them back; stale versions are 409', async () => {
    const s = await mk(7);
    const w1 = await walkIn(s, 21, 0);
    const w2 = await walkIn(s, 22, 1);
    t.clock.set(at(s, 3));
    const stale = await reception.post(`/queue-entries/${w1.queueEntryId}/absent`, { expectedVersion: 99 });
    expect(stale.status).toBe(409);
    expect(errorCode(stale.body)).toBe('CONFLICT');
    expect((await reception.post(`/queue-entries/${w1.queueEntryId}/absent`, { expectedVersion: 1 })).status).toBe(200);
    const called = CallNextResult.parse((await callNext(s, doc(7), 4)).body);
    expect(called.entry!.id).toBe(w2.queueEntryId);
    const snap = StaffQueueSnapshot.parse((await reception.get(`/sessions/${s.id}/queue`)).body);
    expect(snap.skipped.map((e) => e.id)).toEqual([w1.queueEntryId]);
    expect(snap.skipped[0]!.state).toBe('absent');
  });

  it('late re-entry of a group-A patient needs reception review; admitLate converts to walk-in ordering', async () => {
    const s = await mk(7);
    const a = await bookAndCheckIn(s, 23, 0); // slot 09:00, on time
    const called = CallNextResult.parse((await callNext(s, doc(7), 1)).body);
    t.clock.set(at(s, 3));
    expect((await doc(7).post(`/queue-entries/${a.queueEntryId}/skip`, { expectedVersion: called.entry!.version })).status).toBe(200);

    t.clock.set(at(s, 40)); // 40 minutes after the slot: past the 15 minute grace
    const refused = await reception.post(`/queue-entries/${a.queueEntryId}/re-enter`, {});
    expect(refused.status).toBe(409);
    expect(errorCode(refused.body)).toBe('LATE_ARRIVAL_REQUIRES_REVIEW');
    const admitted = await reception.post(`/queue-entries/${a.queueEntryId}/re-enter`, { admitLate: true });
    expect(admitted.status).toBe(200);
    expect(QueueEntry.parse(admitted.body)).toMatchObject({ group: 'W', state: 'waiting', id: a.queueEntryId });
    // Capacity is untouched: the patient keeps the place consumed at first check-in.
    const cap = await t.pool.query(`SELECT booked_reserved, walkin_used FROM session_capacity WHERE session_id = $1`, [s.id]);
    expect(cap.rows[0]).toMatchObject({ booked_reserved: 1, walkin_used: 0 });
  });
});

describe('FR-08 consultation, EWMA and aging', () => {
  it('start and complete move entry, visit and appointment; invalid and stale commands are controlled 409s', async () => {
    const s = await mk(8);
    const a = await bookAndCheckIn(s, 24, -3);
    // Starting before the patient is called is an invalid transition.
    t.clock.set(at(s, 0));
    expect(errorCode((await doc(8).post(`/visits/${a.visitId}/start`, {})).body)).toBe('INVALID_TRANSITION');
    const called = CallNextResult.parse((await callNext(s, doc(8), 1)).body);
    // Wrong doctor / reception cannot start.
    expect((await doc(7).post(`/visits/${a.visitId}/start`, {})).status).toBe(403);
    expect((await reception.post(`/visits/${a.visitId}/start`, {})).status).toBe(403);
    // Stale entry version.
    const stale = await doc(8).post(`/visits/${a.visitId}/start`, { expectedVersion: called.entry!.version + 5 });
    expect(stale.status).toBe(409);
    expect(errorCode(stale.body)).toBe('CONFLICT');
    t.clock.set(at(s, 2));
    const started = await doc(8).post(`/visits/${a.visitId}/start`, { expectedVersion: called.entry!.version });
    expect(started.status).toBe(200);
    expect(QueueEntry.parse(started.body).state).toBe('in_service');
    expect(errorCode((await doc(8).post(`/visits/${a.visitId}/start`, {})).body)).toBe('INVALID_TRANSITION');
    // Complete before it is allowed? It is in service now, so it works; completing twice is invalid.
    t.clock.set(at(s, 9));
    const done = await doc(8).post(`/visits/${a.visitId}/complete`, {});
    expect(done.status).toBe(200);
    expect(QueueEntry.parse(done.body).state).toBe('completed');
    expect(errorCode((await doc(8).post(`/visits/${a.visitId}/complete`, {})).body)).toBe('INVALID_TRANSITION');

    const visit = await t.pool.query(`SELECT status, started_at, completed_at FROM visits WHERE id = $1`, [a.visitId]);
    expect(visit.rows[0]).toMatchObject({ status: 'completed' });
    expect(new Date(visit.rows[0]!.started_at).getTime()).toBe(at(s, 2).getTime());
    expect(new Date(visit.rows[0]!.completed_at).getTime()).toBe(at(s, 9).getTime());
    const appt = await t.pool.query(`SELECT status FROM appointments WHERE id = (SELECT appointment_id FROM visits WHERE id = $1)`, [a.visitId]);
    expect(appt.rows[0]!.status).toBe('completed');
    const alloc = await t.pool.query(
      `SELECT state FROM capacity_allocations WHERE id = (SELECT allocation_id FROM visits WHERE id = $1)`,
      [a.visitId],
    );
    expect(alloc.rows[0]!.state).toBe('consumed');
    expect(await count(t.pool, `SELECT 1 FROM outbox_events WHERE entity_id = $1 AND event_type IN ('ConsultationStarted','ConsultationCompleted')`, [a.visitId])).toBe(2);
    // The doctor is free: the next call is allowed.
    expect(await count(t.pool, `SELECT 1 FROM queue_entries WHERE doctor_id = $1 AND state IN ('called','in_service')`, [doctorId(8)])).toBe(0);
  });

  it('FR-10: completing a consultation updates the doctor EWMA (12 -> 0.2 d + 9.6)', async () => {
    const s = await mk(9);
    await walkIn(s, 25, 0);
    await walkIn(s, 26, 1);
    expect(await count(t.pool, `SELECT 1 FROM service_estimates WHERE doctor_id = $1`, [doctorId(9)])).toBe(0);
    await serve(s, doc(9), 2, 10); // 10 minutes
    const est = await t.pool.query(`SELECT mean_minutes, samples FROM service_estimates WHERE doctor_id = $1`, [doctorId(9)]);
    expect(est.rows[0]!.samples).toBe(1);
    expect(est.rows[0]!.mean_minutes).toBeCloseTo(0.2 * 10 + 9.6, 3);
    await serve(s, doc(9), 20, 20); // 20 minutes: 0.2*20 + 0.8*11.6
    const est2 = await t.pool.query(`SELECT mean_minutes, samples FROM service_estimates WHERE doctor_id = $1`, [doctorId(9)]);
    expect(est2.rows[0]!.samples).toBe(2);
    expect(est2.rows[0]!.mean_minutes).toBeCloseTo(0.2 * 20 + 0.8 * 11.6, 3);
  });

  it('aging: an entry waiting 45 minutes is called with reason AGING and the pointer unchanged', async () => {
    const s = await mk(8);
    const w = await walkIn(s, 27, 0); // eligible 09:00
    await bookAndCheckIn(s, 28, 10); // group A, eligible 09:10; rotation pointer 0 would pick it
    const res = await callNext(s, doc(8), 46);
    expect(res.status).toBe(200);
    const body = CallNextResult.parse(res.body);
    expect(body.entry!.id).toBe(w.queueEntryId);
    expect(body.decision).toMatchObject({ reason: 'AGING', rotationSlot: null, pointerBefore: 0, pointerAfter: 0 });
    expect(body.decision.explanation).toMatch(/Aging: waited 46 min/);
    const ptr = await t.pool.query(`SELECT rotation_pointer FROM sessions WHERE id = $1`, [s.id]);
    expect(ptr.rows[0]!.rotation_pointer).toBe(0);
  });
});

describe('FR-15 clinical priority', () => {
  it('only the doctor can set priority (reception 403, other doctor 403); it is audited with reason and policy version; non-preemptive', async () => {
    const s = await mk(5);
    const w1 = await walkIn(s, 29, 0);
    const w2 = await walkIn(s, 30, 1);
    const active = CallNextResult.parse((await callNext(s, doc(5), 3)).body);
    expect(active.entry!.id).toBe(w1.queueEntryId);

    const body = { priorityClass: 2, reason: 'Elderly, breathless' };
    expect((await reception.post(`/queue-entries/${w2.queueEntryId}/priority`, body)).status).toBe(403);
    expect((await admin.post(`/queue-entries/${w2.queueEntryId}/priority`, body)).status).toBe(403);
    expect((await doc(1).post(`/queue-entries/${w2.queueEntryId}/priority`, body)).status).toBe(403);
    expect((await patientLogin[1]!.post(`/queue-entries/${w2.queueEntryId}/priority`, body)).status).toBe(403);
    expect((await doc(5).post(`/queue-entries/${w2.queueEntryId}/priority`, { priorityClass: 2, reason: 'x' })).status).toBe(400);

    t.clock.set(at(s, 4));
    const set = await doc(5).post(`/queue-entries/${w2.queueEntryId}/priority`, body);
    expect(set.status).toBe(200);
    // Non-preemptive: the active entry is untouched and the doctor stays occupied.
    const still = await t.pool.query(`SELECT state, version FROM queue_entries WHERE id = $1`, [w1.queueEntryId]);
    expect(still.rows[0]).toMatchObject({ state: 'called', version: active.entry!.version });
    expect(errorCode((await callNext(s, doc(5), 5)).body)).toBe('DOCTOR_OCCUPIED');

    const audit = await t.pool.query(
      `SELECT actor_role, actor_id, reason, policy_version, previous, next FROM audit_events
        WHERE operation = 'queue.priority' AND entity_id = $1`,
      [w2.queueEntryId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_role: 'doctor', reason: 'Elderly, breathless', policy_version: 1 });
    expect(audit.rows[0]!.actor_id).not.toBeNull();
    expect(audit.rows[0]!.next).toMatchObject({ priorityClass: 2 });
    expect(await count(t.pool, `SELECT 1 FROM outbox_events WHERE event_type = 'QueuePriorityChanged' AND entity_id = $1`, [w2.queueEntryId])).toBe(1);
    const row = await t.pool.query(`SELECT priority_class, priority_set_by FROM queue_entries WHERE id = $1`, [w2.queueEntryId]);
    expect(row.rows[0]!.priority_class).toBe(2);
    expect(row.rows[0]!.priority_set_by).not.toBeNull();

    // Clearing needs a reason too and removes the class.
    const cleared = await doc(5).post(`/queue-entries/${w2.queueEntryId}/priority`, { priorityClass: null, reason: 'Re-assessed, stable' });
    expect(cleared.status).toBe(200);
    expect(QueueEntry.parse(cleared.body).priorityClass).toBeNull();
    // The class cannot be set on a completed patient.
    t.clock.set(at(s, 6));
    await doc(5).post(`/visits/${w1.visitId}/start`, {});
    t.clock.set(at(s, 8));
    await doc(5).post(`/visits/${w1.visitId}/complete`, {});
    const late = await doc(5).post(`/queue-entries/${w1.queueEntryId}/priority`, body);
    expect(late.status).toBe(409);
  });
});

describe('FR-09 / FR-10 snapshots, display and audit reads', () => {
  it('staff snapshot: projected policy order, positions, active entry, capacity; queueVersion equals the session row', async () => {
    const s = await mk(1);
    await walkIn(s, 31, 0);
    const a = await bookAndCheckIn(s, 32, 5);
    await walkIn(s, 33, 6);
    await walkIn(s, 34, 7);
    await callNext(s, doc(1), 10); // calls the appointment (pointer 0 -> A)
    t.clock.set(at(s, 11));
    const res = await reception.get(`/sessions/${s.id}/queue`);
    expect(res.status).toBe(200);
    const snap = StaffQueueSnapshot.parse(res.body);
    expect(snap.queueVersion).toBe(await queueVersion(s.id));
    expect(snap.rotation).toEqual(['A', 'A', 'W']);
    expect(snap.rotationPointer).toBe(1);
    expect(snap.active?.id).toBe(a.queueEntryId);
    expect(snap.waiting.map((e) => e.token)).toEqual(['W-001', 'W-002', 'W-003']);
    expect(snap.waiting.map((e) => e.projectedPosition)).toEqual([1, 2, 3]);
    expect(snap.waiting[0]!.waitingMinutes).toBe(11);
    expect(snap.lastDecision?.reason).toBe('ROTATION');
    expect(snap.capacity).toMatchObject({ bookedReserved: 1, walkinUsed: 3 });
    expect(snap.completedCount).toBe(0);
    // reception2 covers doctor 1; a session id that does not exist is 404 for a patient.
    expect((await reception2.get(`/sessions/${s.id}/queue`)).status).toBe(200);
    expect((await patientLogin[1]!.get(`/sessions/${randomUUID()}/queue`)).status).toBe(404);
  });

  it('patient snapshot shows only the patient own entry, an ETA with computedAt, and the token being called', async () => {
    const s = await mk(3);
    const w1 = await walkIn(s, 1, 0); // Ramesh Kumar (login patient@)
    const w2 = await walkIn(s, 2, 1); // Sunita Devi (login patient2@)
    await callNext(s, doc(3), 3); // calls W-001
    t.clock.set(at(s, 4));
    const mine = await patientLogin[2]!.get(`/sessions/${s.id}/queue`);
    expect(mine.status).toBe(200);
    const snap = PatientQueueSnapshot.parse(mine.body);
    expect(snap.myEntry).toMatchObject({ queueEntryId: w2.queueEntryId, token: 'W-002', state: 'waiting', position: 1 });
    expect(snap.nowCalling).toBe(w1.token);
    expect(snap.myEntry!.eta.status).toBe('ok');
    expect(snap.myEntry!.eta.computedAt).toBe(at(s, 4).toISOString());
    expect(snap.myEntry!.eta.uncertainty).toBe('cold_start');
    expect(snap.queueVersion).toBe(await queueVersion(s.id));
    const text = JSON.stringify(mine.body);
    for (const leak of ['Ramesh Kumar', 'Sunita Devi', patientId(1), patientId(2), w1.queueEntryId, w1.visitId]) {
      expect(text).not.toContain(leak);
    }
    expect(Object.keys(mine.body).sort()).toEqual(['capturedAt', 'myEntry', 'nowCalling', 'queueVersion', 'sessionId', 'status', 'view']);
    // patient 3 has a login but no entry in this session -> 404 (nothing disclosed)
    expect((await patientLogin[3]!.get(`/sessions/${s.id}/queue`)).status).toBe(404);
  });

  it('FR-10-a: the ETA is withheld while the session is paused with an unknown duration, and shown for a known pause', async () => {
    const s = await mk(6);
    await walkIn(s, 1, 0);
    t.clock.set(at(s, 1));
    expect((await doc(6).post(`/sessions/${s.id}/open`, {})).status).toBe(200);
    expect((await doc(6).post(`/sessions/${s.id}/pause`, {})).status).toBe(200);
    t.clock.set(at(s, 2));
    const snap = PatientQueueSnapshot.parse((await patientLogin[1]!.get(`/sessions/${s.id}/queue`)).body);
    expect(snap.status).toBe('paused');
    expect(snap.myEntry!.eta).toMatchObject({ status: 'withheld', lowMinutes: null, highMinutes: null, uncertainty: null });
    expect(snap.myEntry!.eta.computedAt).toBe(at(s, 2).toISOString());

    expect((await doc(6).post(`/sessions/${s.id}/resume`, {})).status).toBe(200);
    const until = at(s, 12).toISOString();
    expect((await doc(6).post(`/sessions/${s.id}/pause`, { until })).status).toBe(200);
    const known = PatientQueueSnapshot.parse((await patientLogin[1]!.get(`/sessions/${s.id}/queue`)).body);
    expect(known.myEntry!.eta.status).toBe('ok');
    expect(known.myEntry!.eta.note).toMatch(/known pause/);
    // A pause end in the past is rejected.
    expect((await doc(6).post(`/sessions/${s.id}/resume`, {})).status).toBe(200);
    expect((await doc(6).post(`/sessions/${s.id}/pause`, { until: at(s, 0).toISOString() })).status).toBe(400);
  });

  it('the public display lists tokens and doctor/room only: no names, no ids of patients, nothing clinical', async () => {
    const s = await mk(1);
    for (let p = 1; p <= 5; p += 1) await walkIn(s, p, p - 1);
    await callNext(s, doc(1), 6);
    t.clock.set(at(s, 7));
    const anon = await request(t.server).get(`/display/sessions?date=${s.date}`);
    expect(anon.status).toBe(200);
    const snap = DisplaySnapshot.parse(anon.body);
    expect(snap.columns).toHaveLength(1);
    expect(snap.columns[0]).toMatchObject({
      sessionId: s.id,
      doctorLabel: 'Dr. Hegde · General Medicine',
      room: 'OPD 1',
      status: 'open',
      nowCalling: 'W-001',
      next: ['W-002', 'W-003', 'W-004'],
    });
    const names = await t.pool.query<{ full_name: string; id: string }>(`SELECT full_name, id FROM patients`);
    const text = JSON.stringify(anon.body);
    for (const p of names.rows) {
      expect(text).not.toContain(p.full_name);
      expect(text).not.toContain(p.id);
    }
    // Entry ids and visit ids stay private as well.
    const ids = await t.pool.query<{ id: string; visit_id: string }>(`SELECT id, visit_id FROM queue_entries WHERE session_id = $1`, [s.id]);
    for (const r of ids.rows) {
      expect(text).not.toContain(r.id);
      expect(text).not.toContain(r.visit_id);
    }
  });

  it('FR-15: GET /audit is admin only and filterable; GET /sessions/:id/decisions needs staff scope', async () => {
    const s = await mk(2);
    const w = await walkIn(s, 6, 0);
    await callNext(s, doc(2), 2);
    expect((await doc(2).get('/audit')).status).toBe(403);
    expect((await reception.get('/audit')).status).toBe(403);
    const res = await admin.get(`/audit?entityType=queue_entry&entityId=${w.queueEntryId}`);
    expect(res.status).toBe(200);
    const rows = (res.body as unknown[]).map((r) => AuditEvent.parse(r));
    expect(rows.map((r) => r.operation)).toContain('queue.call_next');
    const callRow = rows.find((r) => r.operation === 'queue.call_next')!;
    expect(callRow).toMatchObject({ actorRole: 'doctor', policyVersion: 1 });
    expect(callRow.actorId).not.toBeNull();
    expect(callRow.reason).toMatch(/rotation/i);
    expect((await admin.get(`/audit?limit=1000`)).status).toBe(400);
    expect((await admin.get(`/audit?from=${new Date(Date.now() + 86_400_000).toISOString()}`)).body).toEqual([]);

    expect((await reception.get(`/sessions/${s.id}/decisions`)).status).toBe(200);
    expect((await reception2.get(`/sessions/${s.id}/decisions`)).status).toBe(200);
    expect((await patientLogin[1]!.get(`/sessions/${s.id}/decisions`)).status).toBe(403);
    expect((await doc(1).get(`/sessions/${s.id}/decisions`)).status).toBe(403);
  });
});
