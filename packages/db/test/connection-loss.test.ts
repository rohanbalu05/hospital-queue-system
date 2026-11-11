import pg from 'pg';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool, DatabaseUnavailableError, isConnectionError, withTransaction } from '../src/index.js';
import { must, TEST_DB, testUrl } from './helpers.js';

/**
 * F1 regression: Postgres terminates a connection that withTransaction has checked out (between two
 * statements). Before the fix pg emitted an unhandled 'error' event and the process died.
 */

let pool: Pool;
let admin: Pool;
const unhandled: unknown[] = [];
const onUncaught = (e: unknown) => unhandled.push(e);

beforeAll(() => {
  pool = createPool(testUrl(TEST_DB), { max: 4, applicationName: 'hqms-conn-loss-test' });
  admin = new pg.Pool({ connectionString: testUrl(TEST_DB), max: 1, application_name: 'hqms-conn-loss-admin' });
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);
});
afterAll(async () => {
  process.off('uncaughtException', onUncaught);
  process.off('unhandledRejection', onUncaught);
  await pool.end();
  await admin.end();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function terminate(pid: number): Promise<void> {
  const r = await admin.query<{ ok: boolean }>('SELECT pg_terminate_backend($1) AS ok', [pid]);
  expect(r.rows[0]?.ok).toBe(true);
}

describe('connection loss inside withTransaction', () => {
  it('rejects with DatabaseUnavailableError, does not crash, and the pool keeps working', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = await withTransaction(pool, async (tx) => {
      const { rows } = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await terminate(must(rows[0], 'pid row').pid);
      await new Promise((r) => setTimeout(r, 100)); // let the socket close: the 'error' event fires while idle in fn
      await tx.query('SELECT 1');
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DatabaseUnavailableError);
    expect((err as DatabaseUnavailableError).status).toBe(503);
    expect((err as DatabaseUnavailableError).code).toBe('SERVICE_UNAVAILABLE');
    expect((err as DatabaseUnavailableError).outcomeUnknown).toBe(false);

    // the pool is healthy and did not keep the dead client
    for (let i = 0; i < 6; i++) {
      const ok = await withTransaction(pool, async (tx) => (await tx.query('SELECT 42 AS n')).rows[0]);
      expect(ok).toEqual({ n: 42 });
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(unhandled).toEqual([]);
  });

  it('survives a terminate that lands while the transaction is idle between statements (no query in flight)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let pid = 0;
    const err = await withTransaction(pool, async (tx) => {
      pid = must((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0], 'pid row').pid;
      await tx.query(`SELECT 1`);
      await terminate(pid);
      await new Promise((r) => setTimeout(r, 200)); // nothing is running on the client when the error arrives
      await tx.query(`SELECT 2`);
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DatabaseUnavailableError);
    const stillThere = await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid]);
    expect(stillThere.rowCount).toBe(0);
    expect(unhandled).toEqual([]);
    expect(await withTransaction(pool, async (tx) => (await tx.query('SELECT 1 AS one')).rowCount)).toBe(1);
  });

  it('is not retried: fn runs exactly once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    await withTransaction(pool, async (tx) => {
      calls++;
      const { rows } = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await terminate(must(rows[0], 'pid row').pid);
      await tx.query('SELECT 1');
    }).catch(() => {});
    expect(calls).toBe(1);
  });

  it('a lost connection mid-transaction rolls the work back (nothing half-committed)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await pool.query('CREATE TABLE IF NOT EXISTS conn_loss_probe (id int PRIMARY KEY)');
    await pool.query('DELETE FROM conn_loss_probe');
    await withTransaction(pool, async (tx) => {
      await tx.query('INSERT INTO conn_loss_probe VALUES (1)');
      const { rows } = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await terminate(must(rows[0], 'pid row').pid);
      await tx.query('INSERT INTO conn_loss_probe VALUES (2)');
    }).catch(() => {});
    expect((await pool.query('SELECT count(*)::int AS n FROM conn_loss_probe')).rows[0]).toEqual({ n: 0 });
    await pool.query('DROP TABLE conn_loss_probe');
  });

  it('works with a pool that was not built by createPool (listener attached at checkout)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = new pg.Pool({ connectionString: testUrl(TEST_DB), max: 2 });
    try {
      const err = await withTransaction(raw, async (tx) => {
        const { rows } = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        await terminate(must(rows[0], 'pid row').pid);
        await new Promise((r) => setTimeout(r, 100));
        await tx.query('SELECT 1');
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DatabaseUnavailableError);
      expect(await withTransaction(raw, async (tx) => (await tx.query('SELECT 1 AS one')).rowCount)).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      await raw.end();
    }
  });
});

describe('pool connect failure', () => {
  it('maps a refused connection to DatabaseUnavailableError', async () => {
    const dead = createPool('postgres://postgres:postgres@127.0.0.1:1/none', { max: 1 });
    try {
      const err = await withTransaction(dead, async () => 1).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DatabaseUnavailableError);
    } finally {
      await dead.end();
    }
  });
});

describe('isConnectionError', () => {
  it.each([
    [Object.assign(new Error('terminating connection'), { code: '57P01' }), true],
    [Object.assign(new Error('x'), { code: '57P02' }), true],
    [Object.assign(new Error('x'), { code: '57P03' }), true],
    [Object.assign(new Error('x'), { code: '08006' }), true],
    [Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), true],
    [new Error('Connection terminated unexpectedly'), true],
    [Object.assign(new Error('database "x" is not currently accepting connections'), { code: '55000' }), true],
    [Object.assign(new Error('cannot change sequence'), { code: '55000' }), false],
    [new Error('Client has encountered a connection error and is not queryable'), true],
    [Object.assign(new Error('dup'), { code: '23505' }), false],
    [Object.assign(new Error('serialization'), { code: '40001' }), false],
    [new Error('boom'), false],
    ['nope', false],
  ])('%s -> %s', (err, expected) => {
    expect(isConnectionError(err)).toBe(expected);
  });
});
