import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  capacityInvariant,
  ConflictError,
  createPool,
  hashRequest,
  IdempotencyConflictError,
  lockCapacity,
  lockDoctor,
  lockSession,
  reserveBooked,
  writeAudit,
  withTransaction,
} from '../src/index.js';
import { makeFixture, TEST_DB, testUrl, type Fixture } from './helpers.js';

let pool: Pool;
beforeAll(() => {
  pool = createPool(testUrl(TEST_DB), { max: 10 });
});
afterAll(async () => {
  await pool.end();
});

describe('hashRequest', () => {
  it('is stable under key order and ignores undefined members', () => {
    expect(hashRequest({ a: 1, b: { c: [1, 2], d: 'x' } })).toBe(hashRequest({ b: { d: 'x', c: [1, 2] }, a: 1, z: undefined }));
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
    expect(hashRequest([1, 2])).not.toBe(hashRequest([2, 1]));
    expect(hashRequest({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

/** A booking command: lock chain, reserve a place, audit, return a response. */
function bookCommand(f: Fixture, key: string, payload: unknown, counter?: { runs: number }) {
  return withTransaction(
    pool,
    async (tx) => {
      if (counter) counter.runs++;
      await lockDoctor(tx, f.doctorId);
      await lockSession(tx, f.sessionId);
      await lockCapacity(tx, f.sessionId);
      const allocationId = await reserveBooked(tx, f.sessionId);
      await writeAudit(tx, {
        actorId: f.userId,
        actorRole: 'reception',
        operation: 'test.book',
        entityType: 'session',
        entityId: f.sessionId,
        next: { allocationId },
      });
      return { status: 201, body: { allocationId } };
    },
    { idempotency: { actorId: f.userId, operation: 'POST /appointments', key, requestHash: hashRequest(payload) } },
  );
}

describe('idempotency records', () => {
  it('replays the stored response without running the command again', async () => {
    const f = await makeFixture(pool);
    const key = randomUUID();
    const counter = { runs: 0 };
    const first = await bookCommand(f, key, { sessionId: f.sessionId }, counter);
    const second = await bookCommand(f, key, { sessionId: f.sessionId }, counter);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(counter.runs).toBe(1);
    expect(await capacityInvariant(pool, f.sessionId)).toMatchObject({ ok: true, counters: { bookedReserved: 1 } });
    const audits = await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE entity_id = $1`, [f.sessionId]);
    expect(audits.rows[0].n).toBe(1);
  });

  it('same key with a different request hash is IDEMPOTENCY_KEY_REUSED and changes nothing', async () => {
    const f = await makeFixture(pool);
    const key = randomUUID();
    await bookCommand(f, key, { sessionId: f.sessionId, n: 1 });
    const err = await bookCommand(f, key, { sessionId: f.sessionId, n: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(IdempotencyConflictError);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await capacityInvariant(pool, f.sessionId)).counters.bookedReserved).toBe(1);
  });

  it('is scoped to (actor, operation, key): another operation or actor may reuse the key', async () => {
    const f = await makeFixture(pool);
    const key = randomUUID();
    const hash = hashRequest({ x: 1 });
    const run = (actorId: string, operation: string) =>
      withTransaction(pool, async () => ({ status: 200, body: { actorId, operation } }), {
        idempotency: { actorId, operation, key, requestHash: hash },
      });
    const other = await pool.query<{ id: string }>(
      `INSERT INTO users (hospital_id, email, display_name, role) VALUES ($1, $2, 'Other', 'reception') RETURNING id`,
      [f.hospitalId, `o-${randomUUID()}@test.local`],
    );
    const results = await Promise.all([run(f.userId, 'op.a'), run(f.userId, 'op.b'), run(other.rows[0]!.id, 'op.a')]);
    expect(results.every((r) => !r.replayed)).toBe(true);
  });

  it('two concurrent calls with the same key on separate connections produce one effect', async () => {
    const f = await makeFixture(pool, { booked: 10 });
    const key = randomUUID();
    const counter = { runs: 0 };
    const results = await Promise.all(Array.from({ length: 6 }, () => bookCommand(f, key, { sessionId: f.sessionId }, counter)));
    expect(counter.runs).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => JSON.stringify(r.body))).size).toBe(1);
    const inv = await capacityInvariant(pool, f.sessionId);
    expect(inv).toMatchObject({ ok: true, counters: { bookedReserved: 1 } });
    const rec = await pool.query(`SELECT count(*)::int AS n FROM idempotency_records WHERE idem_key = $1`, [key]);
    expect(rec.rows[0].n).toBe(1);
  });

  it('a failed command stores nothing, so the same key can be retried', async () => {
    const f = await makeFixture(pool, { booked: 1 });
    // fill the session so the keyed command fails with CAPACITY_FULL
    await bookCommand(f, randomUUID(), { filler: true });
    const key = randomUUID();
    const err = await bookCommand(f, key, { sessionId: f.sessionId }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('CAPACITY_FULL');
    const stored = await pool.query(`SELECT 1 FROM idempotency_records WHERE idem_key = $1`, [key]);
    expect(stored.rowCount).toBe(0);
  });

  it('retry after a serialization failure reuses the same idempotency identity and stores one record', async () => {
    const f = await makeFixture(pool);
    const key = randomUUID();
    let calls = 0;
    const res = await withTransaction(
      pool,
      async (tx) => {
        calls++;
        if (tx.attempt === 1) await tx.query(`DO $$ BEGIN RAISE EXCEPTION 'forced' USING ERRCODE = '40001'; END $$`);
        return { status: 200, body: { attempt: tx.attempt } };
      },
      { idempotency: { actorId: f.userId, operation: 'op.retry', key, requestHash: hashRequest({}) } },
    );
    expect(calls).toBe(2);
    expect(res.body).toEqual({ attempt: 2 });
    const replay = await withTransaction(pool, async () => ({ status: 500, body: 'must not run' }), {
      idempotency: { actorId: f.userId, operation: 'op.retry', key, requestHash: hashRequest({}) },
    });
    expect(replay).toMatchObject({ replayed: true, status: 200, body: { attempt: 2 } });
  });
});
