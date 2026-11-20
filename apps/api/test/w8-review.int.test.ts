/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
/** Session-3 review fixes (D-039): batch idempotency of the affected-move, admin deactivate lock order. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, Appointment, MoveAffectedResult, StaffCredentials } from '@hqms/contracts';
import { type Client, type TestApp, createTestApp, loginAs, makeSession, newPatient } from './helpers.js';

let t: TestApp;
let admin: Client;
let reception: Client;

beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
});
afterAll(async () => {
  await t.close();
});

const code = (b: unknown) => ApiError.parse(b).error.code;

async function book(sessionId: string, patientId: string): Promise<Appointment> {
  const res = await reception.post('/appointments', { sessionId, patientId });
  if (res.status !== 201) throw new Error(`book failed: ${res.status} ${JSON.stringify(res.body)}`);
  return Appointment.parse(res.body);
}

describe('affected move: batch-level idempotency (P2)', () => {
  it('the same key with a different request is refused before any item runs', async () => {
    const S = await makeSession(admin, { doctor: 1 });
    const T1 = await makeSession(admin, { doctor: 2 });
    const T2 = await makeSession(admin, { doctor: 2 });
    const a = await book(S.id, await newPatient(reception, 'Batch A'));
    const b = await book(S.id, await newPatient(reception, 'Batch B'));
    expect((await reception.post(`/sessions/${S.id}/unavailable`, { reason: 'Doctor unwell' })).status).toBe(200);

    const K = `batch-${randomUUID()}`;
    const first = await reception.post(`/sessions/${S.id}/affected/move`, { targetSessionId: T1.id, appointmentIds: [a.id] }, K);
    expect(first.status).toBe(200);
    expect(MoveAffectedResult.parse(first.body)).toMatchObject({ moved: 1 });

    const reuse = await reception.post(
      `/sessions/${S.id}/affected/move`,
      { targetSessionId: T2.id, appointmentIds: [b.id, a.id] },
      K,
    );
    expect(reuse.status).toBe(409);
    expect(code(reuse.body)).toBe('IDEMPOTENCY_KEY_REUSED');
    // B was NOT moved
    const rowB = (await t.pool.query(`SELECT status, session_id FROM appointments WHERE id = $1`, [b.id])).rows[0]!;
    expect(rowB).toMatchObject({ status: 'booked', session_id: S.id });
    const moved = await t.pool.query(`SELECT 1 FROM appointments WHERE session_id = $1`, [T2.id]);
    expect(moved.rowCount).toBe(0);

    // the same request again replays: nothing moves twice
    const again = await reception.post(`/sessions/${S.id}/affected/move`, { targetSessionId: T1.id, appointmentIds: [a.id] }, K);
    expect(again.status).toBe(200);
    expect(MoveAffectedResult.parse(again.body).moved).toBe(1);
    expect((await t.pool.query(`SELECT 1 FROM appointments WHERE session_id = $1`, [T1.id])).rowCount).toBe(1);
  });

  it('item order in the request does not make it a different request; a refused request leaves no record behind', async () => {
    const S = await makeSession(admin, { doctor: 1 });
    const T = await makeSession(admin, { doctor: 2 });
    const a = await book(S.id, await newPatient(reception, 'Batch Order A'));
    const b = await book(S.id, await newPatient(reception, 'Batch Order B'));
    const K = `batch-${randomUUID()}`;
    // the session is still open: refused, and the key is not consumed
    const refused = await reception.post(`/sessions/${S.id}/affected/move`, { targetSessionId: T.id, appointmentIds: [a.id] }, K);
    expect(refused.status).toBe(409);
    expect(code(refused.body)).toBe('INVALID_TRANSITION');
    expect((await reception.post(`/sessions/${S.id}/unavailable`, { reason: 'Doctor unwell' })).status).toBe(200);
    const ok = await reception.post(`/sessions/${S.id}/affected/move`, { targetSessionId: T.id, appointmentIds: [a.id, b.id] }, K);
    expect(ok.status).toBe(200);
    const replay = await reception.post(`/sessions/${S.id}/affected/move`, { targetSessionId: T.id, appointmentIds: [b.id, a.id] }, K);
    expect(replay.status).toBe(200);
    expect(MoveAffectedResult.parse(replay.body).moved).toBe(2);
  });
});

describe('admin deactivate: lock order (P2)', () => {
  const deadlocks = async (): Promise<number> =>
    Number((await t.pool.query(`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`)).rows[0]!.deadlocks);

  async function newAdmin(name: string): Promise<{ id: string; client: Client }> {
    const res = await admin.post('/admin/staff', { displayName: name, email: `w8-${randomUUID().slice(0, 8)}@hqms.test`, role: 'admin' }, null);
    expect(res.status).toBe(201);
    const cred = StaffCredentials.parse(res.body);
    return { id: cred.member.userId, client: await loginAs(t.server, cred.member.email, cred.temporaryPassword) };
  }

  it('two admins deactivating each other in parallel never deadlock or fail with a server error', async () => {
    const before = await deadlocks();
    for (let round = 0; round < 6; round += 1) {
      const [x, y] = [await newAdmin('Admin Race X'), await newAdmin('Admin Race Y')];
      const [r1, r2] = await Promise.all([
        x.client.post(`/admin/staff/${y.id}/deactivate`, { reason: 'Race test' }, null),
        y.client.post(`/admin/staff/${x.id}/deactivate`, { reason: 'Race test' }, null),
      ]);
      for (const r of [r1, r2]) expect([200, 401, 409]).toContain(r.status); // 401: the other won and revoked this session
      expect([r1.status, r2.status]).toContain(200);
    }
    expect(await deadlocks()).toBe(before);
  });
});
