/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
/* PR-30: admin-only reopen of an "unavailable" session, before it ends. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@hqms/contracts';
import { type Client, type MadeSession, type TestApp, at, createTestApp, loginAs, makeSession, patientId } from './helpers.js';

let t: TestApp;
let admin: Client;
let reception: Client;
let doctor: Client; // doctor 1
let patient: Client;

beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  doctor = await loginAs(t.server, 'doctor@hqms.test');
  patient = await loginAs(t.server, 'patient@hqms.test');
});
afterAll(() => t.close());
beforeEach(() => t.clock.reset());

const code = (body: unknown) => ApiError.parse(body).error.code;

async function unavailableSession(): Promise<MadeSession> {
  const s = await makeSession(admin, { doctor: 1 });
  t.clock.set(at(s, 10));
  expect((await doctor.post(`/sessions/${s.id}/unavailable`, { reason: 'Called to theatre' })).status).toBe(200);
  return s;
}

describe('POST /sessions/{id}/reopen (PR-30)', () => {
  it('admin only', async () => {
    const s = await unavailableSession();
    const body = { reason: 'Marked by mistake' };
    expect((await doctor.post(`/sessions/${s.id}/reopen`, body)).status).toBe(403);
    expect((await reception.post(`/sessions/${s.id}/reopen`, body)).status).toBe(403);
    expect((await patient.post(`/sessions/${s.id}/reopen`, body)).status).toBe(403);
  });

  it('requires a reason', async () => {
    const s = await unavailableSession();
    expect((await admin.post(`/sessions/${s.id}/reopen`, {})).status).toBe(400);
    expect((await admin.post(`/sessions/${s.id}/reopen`, { reason: 'x' })).status).toBe(400);
  });

  it('unavailable -> open: audited with reason, queue version bumped, SessionResumed (reopened) in the outbox', async () => {
    const s = await unavailableSession();
    const qv = (await t.pool.query(`SELECT queue_version FROM sessions WHERE id = $1`, [s.id])).rows[0]!.queue_version as number;
    t.clock.set(at(s, 20));
    const res = await admin.post(`/sessions/${s.id}/reopen`, { reason: 'Doctor is back after all' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: s.id, status: 'open', availability: { state: 'available' } });

    const row = (await t.pool.query(`SELECT status, paused_at, pause_until, pause_reason, queue_version FROM sessions WHERE id = $1`, [s.id])).rows[0]!;
    expect(row).toMatchObject({ status: 'open', paused_at: null, pause_until: null, pause_reason: null });
    expect(row.queue_version).toBe(qv + 1);

    const audit = await t.pool.query(
      `SELECT actor_role, reason, previous, next FROM audit_events WHERE operation = 'session.reopen' AND entity_id = $1`,
      [s.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_role: 'admin', reason: 'Doctor is back after all' });
    expect(audit.rows[0]!.previous).toMatchObject({ status: 'unavailable' });
    expect(audit.rows[0]!.next).toMatchObject({ status: 'open', queueVersion: qv + 1 });

    const ev = await t.pool.query(
      `SELECT payload FROM outbox_events WHERE event_type = 'SessionResumed' AND session_id = $1 ORDER BY position DESC LIMIT 1`,
      [s.id],
    );
    expect(ev.rows[0]!.payload).toEqual({
      queueVersion: qv + 1,
      status: 'open',
      pauseUntil: null,
      update: false,
      doctorId: expect.any(String),
      reopened: true,
    });
    expect(JSON.stringify(ev.rows[0]!.payload)).not.toContain('Doctor is back');
  });

  it('booking works again after reopen', async () => {
    const s = await unavailableSession();
    t.clock.set(at(s, -30));
    expect((await reception.post('/appointments', { sessionId: s.id, patientId: patientId(1) })).status).toBe(409);
    t.clock.set(at(s, 20));
    expect((await admin.post(`/sessions/${s.id}/reopen`, { reason: 'Mistake' })).status).toBe(200);
    expect((await reception.post('/appointments', { sessionId: s.id, patientId: patientId(1) })).status).toBe(201);
  });

  it('refuses after the session has ended, and from any state other than unavailable (409)', async () => {
    const s = await unavailableSession();
    t.clock.set(new Date(new Date(s.startsAt).getTime() + 4 * 3_600_000 + 60_000));
    const late = await admin.post(`/sessions/${s.id}/reopen`, { reason: 'Too late' });
    expect(late.status).toBe(409);
    expect(code(late.body)).toBe('INVALID_TRANSITION');

    const open = await makeSession(admin, { doctor: 2 });
    const r = await admin.post(`/sessions/${open.id}/reopen`, { reason: 'Not unavailable' });
    expect(r.status).toBe(409);
    expect(code(r.body)).toBe('INVALID_TRANSITION');
    expect((await admin.post(`/sessions/${randomUUID()}/reopen`, { reason: 'Nothing here' })).status).toBe(404);
  });

  it('an Idempotency-Key replay returns the same response and writes one audit row', async () => {
    const s = await unavailableSession();
    t.clock.set(at(s, 20));
    const key = randomUUID();
    const a = await admin.post(`/sessions/${s.id}/reopen`, { reason: 'Replay me' }, key);
    const b = await admin.post(`/sessions/${s.id}/reopen`, { reason: 'Replay me' }, key);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    const n = await t.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE operation = 'session.reopen' AND entity_id = $1`, [s.id]);
    expect(n.rows[0]!.n).toBe(1);
  });
});
