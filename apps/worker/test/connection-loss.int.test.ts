import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseUnavailableError, withTransaction } from '@hqms/db';
import { JobRunner } from '../src/runner.js';
import type { JobHandler } from '../src/types.js';
import { getJob, insertJob, makePool, must, sleep, testLog } from './helpers.js';

/**
 * F1 regression for the worker: Postgres terminates the connection a running handler holds between two
 * statements. The job must fail (and be retried later), the process must not crash, and the loop must keep
 * serving other jobs.
 */

let pool: Pool;
let admin: Pool;
const unhandled: unknown[] = [];
const onUncaught = (e: unknown) => unhandled.push(e);

beforeAll(() => {
  pool = makePool(6);
  admin = makePool(2);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);
});
afterAll(async () => {
  process.off('uncaughtException', onUncaught);
  process.off('unhandledRejection', onUncaught);
  await Promise.all([pool.end(), admin.end()]);
});
beforeEach(async () => {
  await admin.query(`DELETE FROM jobs`);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 10_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out waiting for condition');
    await sleep(25);
  }
}

describe('worker survives a terminated connection', () => {
  it('fails the job with a database-unavailable error, retries it later, and keeps serving other jobs', async () => {
    let errorSeen: unknown;
    let killed = false;
    const handlers: Record<string, JobHandler> = {
      kill_own_connection: async (_job, ctx) => {
        try {
          await withTransaction(ctx.pool, async (tx) => {
            const { rows } = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
            if (!killed) {
              killed = true;
              await admin.query('SELECT pg_terminate_backend($1)', [must(rows[0], 'pid row').pid]);
              await sleep(150); // the socket closes while the handler holds an idle client
            }
            await tx.query('SELECT 1');
          });
        } catch (err) {
          errorSeen = err;
          throw err;
        }
        return undefined;
      },
      ok: async () => undefined,
    };
    const runner = new JobRunner({
      pool,
      workerId: 'conn-loss-worker',
      handlers,
      log: testLog,
      pollMs: 20,
      renewEveryMs: 0,
      backoffCapSec: 1,
    });
    const victim = await insertJob(admin, { type: 'kill_own_connection', dedupeKey: 'victim' });
    runner.start();
    try {
      // attempt 1: the connection dies -> job is failed (not dead), with the error recorded
      const failed = await waitFor(async () => {
        const j = await getJob(admin, victim);
        return j.attempts >= 1 && j.state === 'failed' ? j : undefined;
      });
      expect(errorSeen).toBeInstanceOf(DatabaseUnavailableError);
      expect(String(failed.last_error)).toMatch(/database connection was lost/i);

      // the loop is alive: an unrelated job runs to completion while the victim waits for its retry
      const other = await insertJob(admin, { type: 'ok', dedupeKey: 'other' });
      await waitFor(async () => (await getJob(admin, other)).state === 'succeeded' || undefined);

      // the retry (backoff elapsed, new connection from the pool) succeeds
      const done = await waitFor(async () => {
        const j = await getJob(admin, victim);
        return j.state === 'succeeded' ? j : undefined;
      }, 15_000);
      expect(done.attempts).toBe(2);
      expect(unhandled).toEqual([]);
    } finally {
      await runner.stop(2000);
    }
  });
});
