/**
 * T1 / NFR-03: lost-response retries. The same Idempotency-Key fired in parallel must create one
 * appointment and answer every call with the same stored response.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newKey, type ApiClient } from '../support/client.js';
import { recordResult } from '../support/results.js';
import {
  capacityCounts,
  checkGlobalInvariants,
  closePool,
  loginAs,
  makeFutureSession,
  registerPatients,
  sqlRows,
  tally,
} from '../support/world.js';

let admin: ApiClient;
let reception: ApiClient;
let patients: string[];
const record: Record<string, unknown> = {};

beforeAll(async () => {
  admin = await loginAs('admin@hqms.test');
  reception = await loginAs('reception@hqms.test');
  patients = await registerPatients(reception, 8, 'T1 Idem');
}, 60_000);

afterAll(async () => {
  const invariants = await checkGlobalInvariants();
  recordResult('t1Idempotency', { ...record, globalInvariantViolations: invariants.violations });
  await closePool();
});

describe('T1 idempotency under parallel retries', () => {
  it('same key fired 10x in parallel: one appointment, identical responses, at least 9 replays', async () => {
    const rounds = 10;
    const perRound: Array<Record<string, unknown>> = [];
    for (let r = 0; r < rounds; r += 1) {
      const session = await makeFutureSession(admin, { booked: 5 });
      const key = newKey();
      const body = { sessionId: session.id, patientId: patients[0] };
      const results = await Promise.all(Array.from({ length: 10 }, () => reception.post('/appointments', body, key)));
      const t = tally(results);
      const ids = new Set(results.map((x) => x.body.id));
      const replayed = results.filter((x) => x.headers.get('idempotency-replayed') === 'true').length;
      const rows = await sqlRows(`SELECT id FROM appointments WHERE session_id = $1`, [session.id]);
      const counts = await capacityCounts(session.id);
      perRound.push({ round: r + 1, statuses: t.byStatus, distinctIds: ids.size, replayed, appointments: rows.length });

      expect(t.serverErrors).toBe(0);
      expect(results.every((x) => x.status === 201)).toBe(true);
      expect(ids.size).toBe(1);
      expect(replayed).toBeGreaterThanOrEqual(9);
      for (const x of results) expect(x.body).toEqual(results[0]?.body);
      expect(rows).toHaveLength(1);
      expect(counts.booked_reserved).toBe(1);
      expect(counts.booked_allocations).toBe(1);
    }
    record['sameKeyParallel'] = { rounds, requestsPerRound: 10, perRound };
  }, 120_000);

  it('same key with a different body is rejected with 409 IDEMPOTENCY_KEY_REUSED and changes nothing', async () => {
    const session = await makeFutureSession(admin, { booked: 5 });
    const key = newKey();
    const first = await reception.post('/appointments', { sessionId: session.id, patientId: patients[1] }, key);
    expect(first.status).toBe(201);
    const other = await reception.post('/appointments', { sessionId: session.id, patientId: patients[2] }, key);
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const second = await makeFutureSession(admin, { booked: 5 });
    const differentSession = await reception.post(
      '/appointments',
      { sessionId: second.id, patientId: patients[1] },
      key,
    );
    expect(differentSession.status).toBe(409);
    expect(differentSession.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await sqlRows(`SELECT 1 FROM appointments WHERE session_id = $1`, [session.id])).length).toBe(1);
    expect((await sqlRows(`SELECT 1 FROM appointments WHERE session_id = $1`, [second.id])).length).toBe(0);

    // Parallel variant: 5 same-key bodies A and 5 same-key bodies B at once -> exactly one body wins.
    const racedSession = await makeFutureSession(admin, { booked: 5 });
    const rkey = newKey();
    const mixed = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        reception.post('/appointments', { sessionId: racedSession.id, patientId: patients[i % 2 === 0 ? 3 : 4] }, rkey),
      ),
    );
    const t = tally(mixed);
    expect(t.serverErrors).toBe(0);
    expect(Object.keys(t.byStatus).sort()).toEqual(['201', '409']);
    expect(t.byCode['IDEMPOTENCY_KEY_REUSED']).toBe(t.byStatus['409']);
    expect((await sqlRows(`SELECT 1 FROM appointments WHERE session_id = $1`, [racedSession.id])).length).toBe(1);
    record['differentBody'] = { sequentialReuse: 409, parallelMixedBodies: t.byStatus };
  }, 60_000);

  it('the key is scoped to the caller: two staff users using the same key each create their own appointment', async () => {
    const session = await makeFutureSession(admin, { booked: 5, doctor: 1 });
    const key = newKey();
    const [a, b] = await Promise.all([
      reception.post('/appointments', { sessionId: session.id, patientId: patients[5] }, key),
      admin.post('/appointments', { sessionId: session.id, patientId: patients[6] }, key),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);
    expect((await capacityCounts(session.id)).booked_reserved).toBe(2);
    record['keyScopedToActor'] = { statuses: [a.status, b.status] };
  }, 30_000);

  it('a business failure is not stored: after capacity frees up, the same key books successfully', async () => {
    const session = await makeFutureSession(admin, { booked: 1 });
    const holder = await reception.post('/appointments', { sessionId: session.id, patientId: patients[0] });
    expect(holder.status).toBe(201);
    const key = newKey();
    const full = await reception.post('/appointments', { sessionId: session.id, patientId: patients[7] }, key);
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('CAPACITY_FULL');
    const cancel = await reception.post(`/appointments/${holder.body.id}/cancel`, {});
    expect(cancel.status).toBe(200);
    const retry = await reception.post('/appointments', { sessionId: session.id, patientId: patients[7] }, key);
    expect(retry.status).toBe(201);
    expect(retry.headers.get('idempotency-replayed')).toBeNull();
    record['businessFailureNotStored'] = { firstStatus: full.status, retryStatus: retry.status };
  }, 30_000);
});
