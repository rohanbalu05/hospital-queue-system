/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
/** Session-3 review fixes (D-039): batch idempotency of the affected-move, admin deactivate lock order. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AffectedPatients, ApiError, Appointment, AppointmentAlternatives, MoveAffectedResult, StaffCredentials } from '@hqms/contracts';
import { type Client, type TestApp, createTestApp, doctorId, loginAs, makeSession, newLoginPatient, newPatient } from './helpers.js';

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

describe('GET /sessions/{id}/affected: alternatives limited to the caller scope (P2)', () => {
  it('reception sees only targets of doctors they can move patients to; admin and a wider scope see more', async () => {
    const S = await makeSession(admin, { doctor: 1 });
    const T = await makeSession(admin, { doctor: 2 }); // General Medicine, like doctor 1
    t.clock.set(new Date(`${S.date}T08:00:00+05:30`)); // alternatives look at today and the next 7 days
    expect((await reception.post(`/sessions/${S.id}/unavailable`, { reason: 'Doctor unwell' })).status).toBe(200);

    const mkReception = async (doctors: string[]): Promise<Client> => {
      const res = await admin.post(
        '/admin/staff',
        { displayName: 'Scope Reception', email: `w8-${randomUUID().slice(0, 8)}@hqms.test`, role: 'reception', doctorIds: doctors },
        null,
      );
      expect(res.status).toBe(201);
      const cred = StaffCredentials.parse(res.body);
      return loginAs(t.server, cred.member.email, cred.temporaryPassword);
    };
    const ids = async (c: Client): Promise<string[]> => {
      const res = await c.get(`/sessions/${S.id}/affected`);
      expect(res.status).toBe(200);
      return AffectedPatients.parse(res.body).alternatives.map((a) => a.sessionId);
    };
    const narrow = await mkReception([doctorId(1)]);
    expect(await ids(narrow)).not.toContain(T.id);
    const both = await mkReception([doctorId(1), doctorId(2)]);
    expect(await ids(both)).toContain(T.id);
    expect(await ids(admin)).toContain(T.id);
    t.clock.reset();
  });
});

describe('per-user rate limits on the new reads (P2)', () => {
  let lt: TestApp;
  const old: Record<string, string | undefined> = {};
  beforeAll(async () => {
    for (const [k, v] of Object.entries({ READS_RATE_LIMIT_PER_MIN: '3', UNREAD_COUNT_RATE_LIMIT_PER_MIN: '4' })) {
      old[k] = process.env[k];
      process.env[k] = v;
    }
    lt = await createTestApp();
  });
  afterAll(async () => {
    await lt.close();
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  });

  async function hammer(c: Client, call: (c: Client) => PromiseLike<{ status: number; body: unknown }>, allowed: number) {
    for (let i = 0; i < allowed; i += 1) expect((await call(c)).status).not.toBe(429);
    const over = await call(c);
    expect(over.status).toBe(429);
    expect(code(over.body)).toBe('RATE_LIMITED');
  }

  it('GET /me/visits/today: per patient, and another patient is not affected', async () => {
    const adminL = await loginAs(lt.server, 'admin@hqms.test');
    const rec = await loginAs(lt.server, 'reception@hqms.test');
    const p1 = await newLoginPatient(lt, rec, 'Limit One');
    const p2 = await newLoginPatient(lt, rec, 'Limit Two');
    await hammer(p1.client, (c) => c.get('/me/visits/today'), 3);
    expect((await p2.client.get('/me/visits/today')).status).toBe(200);
    expect(adminL).toBeDefined();
  });

  it('GET /notifications/unread-count (4/min here) and POST /notifications/read-all (3/min here)', async () => {
    const rec = await loginAs(lt.server, 'reception@hqms.test');
    const p = await newLoginPatient(lt, rec, 'Limit Bell');
    await hammer(p.client, (c) => c.get('/notifications/unread-count'), 4);
    await hammer(p.client, (c) => c.post('/notifications/read-all', {}, null), 3);
  });

  it('GET /appointments/{id}/alternatives: per user', async () => {
    const a = await loginAs(lt.server, 'admin@hqms.test');
    const rec = await loginAs(lt.server, 'reception@hqms.test');
    const S = await makeSession(a, { doctor: 1 });
    const p = await newLoginPatient(lt, rec, 'Limit Alt');
    const appt = await rec.post('/appointments', { sessionId: S.id, patientId: p.id });
    expect(appt.status).toBe(201);
    const id = Appointment.parse(appt.body).id;
    await hammer(p.client, (c) => c.get(`/appointments/${id}/alternatives`), 3);
    expect(AppointmentAlternatives.safeParse((await rec.get(`/appointments/${id}/alternatives`)).body).success).toBe(true);
  });
});
