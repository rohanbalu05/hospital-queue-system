import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, createPool, lockDoctor, sqlState, withTransaction } from '../src/index.js';
import { makeFixture, TEST_DB, testUrl } from './helpers.js';

let pool: Pool;
beforeAll(() => {
  pool = createPool(testUrl(TEST_DB), { max: 10 });
});
afterAll(async () => {
  await pool.end();
});

const raise = (tx: { query: (s: string) => Promise<unknown> }, code: string) =>
  tx.query(`DO $$ BEGIN RAISE EXCEPTION 'forced' USING ERRCODE = '${code}'; END $$`);

describe('withTransaction retry', () => {
  it('retries a forced 40001 and succeeds on the third attempt', async () => {
    let calls = 0;
    const result = await withTransaction(pool, async (tx) => {
      calls++;
      if (tx.attempt < 3) await raise(tx, '40001');
      return `ok after ${tx.attempt}`;
    });
    expect(calls).toBe(3);
    expect(result).toBe('ok after 3');
  });

  it('gives up after the bound (3 attempts) with a controlled ConflictError', async () => {
    let calls = 0;
    const err = await withTransaction(pool, async (tx) => {
      calls++;
      await raise(tx, '40001');
    }).catch((e) => e);
    expect(calls).toBe(3);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('CONFLICT');
    expect(err.details).toMatchObject({ sqlstate: '40001', attempts: 3 });
  });

  it('honours a smaller maxAttempts', async () => {
    let calls = 0;
    await withTransaction(pool, async (tx) => {
      calls++;
      await raise(tx, '40P01');
    }, { maxAttempts: 1 }).catch(() => {});
    expect(calls).toBe(1);
  });

  it('does not retry application errors, and rolls back their writes', async () => {
    const f = await makeFixture(pool);
    let calls = 0;
    const err = await withTransaction(pool, async (tx) => {
      calls++;
      await tx.query(`UPDATE doctors SET room = 'CHANGED' WHERE id = $1`, [f.doctorId]);
      throw new Error('boom');
    }).catch((e) => e);
    expect(err.message).toBe('boom');
    expect(calls).toBe(1);
    const room = await pool.query(`SELECT room FROM doctors WHERE id = $1`, [f.doctorId]);
    expect(room.rows[0].room).toBe('OPD 1');
  });

  it('retries a real deadlock (40P01) and both transactions finish', async () => {
    const a = await makeFixture(pool);
    const b = await makeFixture(pool);
    const attempts: Record<string, number> = { x: 0, y: 0 };
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => (release = r));
    const sync = async () => {
      if (++arrived === 2) release();
      await barrier;
    };
    const run = (name: 'x' | 'y', first: string, second: string) =>
      withTransaction(pool, async (tx) => {
        attempts[name]!++;
        await tx.query(`SET LOCAL deadlock_timeout = '50ms'`);
        await tx.query(`SELECT 1 FROM doctors WHERE id = $1 FOR UPDATE`, [first]);
        if (tx.attempt === 1) await sync(); // both hold their first row before asking for the other
        await tx.query(`SELECT 1 FROM doctors WHERE id = $1 FOR UPDATE`, [second]);
        return name;
      });
    const results = await Promise.all([run('x', a.doctorId, b.doctorId), run('y', b.doctorId, a.doctorId)]);
    expect(results.sort()).toEqual(['x', 'y']);
    expect(attempts['x']! + attempts['y']!).toBeGreaterThanOrEqual(3); // at least one was retried
  });

  it('maps lock_timeout (55P03) to a ConflictError without retrying', async () => {
    const f = await makeFixture(pool);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM doctors WHERE id = $1 FOR UPDATE`, [f.doctorId]);
      let calls = 0;
      const err = await withTransaction(
        pool,
        async (tx) => {
          calls++;
          await lockDoctor(tx, f.doctorId);
        },
        { lockTimeoutMs: 150 },
      ).catch((e) => e);
      expect(calls).toBe(1);
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.details).toMatchObject({ sqlstate: '55P03' });
      expect(sqlState(err.cause)).toBe('55P03');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });
});

describe('value conventions', () => {
  it('returns timestamptz as ISO strings, date as YYYY-MM-DD, bigint and numeric as numbers', async () => {
    const res = await pool.query(
      `SELECT '2026-03-01 10:00:00+05:30'::timestamptz AS t, '2026-03-01'::date AS d, 42::bigint AS b, 0.2::numeric(4,3) AS n`,
    );
    expect(res.rows[0]).toEqual({ t: '2026-03-01T04:30:00.000Z', d: '2026-03-01', b: 42, n: 0.2 });
  });
});
