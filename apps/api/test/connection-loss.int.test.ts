import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { PoolClient } from '@hqms/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@hqms/contracts';
import { type Client, type TestApp, capacityOf, createTestApp, loginAs, makeSession } from './helpers.js';

/**
 * F1 / F2 regression: Postgres terminates the connection a command holds between two statements.
 * The API must answer 503 SERVICE_UNAVAILABLE (Retry-After: 2), stay alive, and serve the next request;
 * retrying with the same Idempotency-Key must then succeed exactly once.
 */

let t: TestApp;
let admin: Client;
let patient: Client;
let killer: pg.Pool;
const unhandled: unknown[] = [];
const onUncaught = (e: unknown) => unhandled.push(e);

beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t.server, 'admin@hqms.test');
  patient = await loginAs(t.server, 'patient@hqms.test');
  killer = new pg.Pool({ connectionString: process.env['DATABASE_URL'], max: 1 });
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);
});
afterAll(async () => {
  process.off('uncaughtException', onUncaught);
  process.off('unhandledRejection', onUncaught);
  await killer.end();
  await t.close();
});

/** The next checked-out client loses its backend right before its `nth` statement (between two statements). */
function terminateNextCheckoutBefore(nth: number): void {
  const original = t.pool.connect.bind(t.pool) as (cb?: unknown) => Promise<PoolClient>;
  const spy = vi.spyOn(t.pool, 'connect') as unknown as { mockImplementation(f: (cb?: unknown) => unknown): void };
  spy.mockImplementation((cb?: unknown) => {
    // pool.query() calls connect(callback) internally; only the promise form (withTransaction) is patched.
    if (typeof cb === 'function') return original(cb);
    return patch(original());
  });
  const patch = async (checkout: Promise<PoolClient>): Promise<PoolClient> => {
    const client = await checkout;
    vi.restoreAllMocks();
    const query = client.query.bind(client) as (...a: unknown[]) => unknown;
    let n = 0;
    (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
      if (++n === nth) {
        const pid = (client as unknown as { processID: number }).processID;
        await killer.query('SELECT pg_terminate_backend($1)', [pid]);
        await new Promise((r) => setTimeout(r, 150)); // the socket closes while the client is idle
      }
      return query(...args);
    };
    return client;
  };
}

describe('database connection lost under a request', () => {
  it('booking answers 503 SERVICE_UNAVAILABLE + Retry-After, the API survives, and a retry with the same key succeeds once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await makeSession(admin);
    const key = randomUUID();

    terminateNextCheckoutBefore(3);
    const failed = await patient.post('/appointments', { sessionId: s.id }, key);
    expect(failed.status).toBe(503);
    expect(failed.headers['retry-after']).toBe('2');
    const body = ApiError.parse(failed.body);
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(body.error.correlationId).toBeTruthy();
    expect(JSON.stringify(failed.body)).not.toMatch(/terminated|stack|pg_/i);

    // nothing was booked by the failed attempt
    expect((await capacityOf(t.pool, s.id)).booked_reserved).toBe(0);

    // the process is alive and the pool serves the next request
    const health = await patient.get('/health');
    expect(health.status).toBe(200);
    const slots = await patient.get(`/sessions/${s.id}/slots`);
    expect(slots.status).toBe(200);

    // client retry with the same key: exactly one booking
    const retry = await patient.post('/appointments', { sessionId: s.id }, key);
    expect(retry.status).toBe(201);
    const again = await patient.post('/appointments', { sessionId: s.id }, key);
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(retry.body.id);
    expect((await capacityOf(t.pool, s.id)).booked_reserved).toBe(1);

    await new Promise((r) => setTimeout(r, 50));
    expect(unhandled).toEqual([]);
  });

  it('a read request that loses its connection (pool.query) also maps to 503, not 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await makeSession(admin);
    const spy = vi.spyOn(t.pool, 'query') as unknown as {
      mockImplementation(f: (...a: unknown[]) => Promise<unknown>): void;
    };
    spy.mockImplementation(() => {
      vi.restoreAllMocks(); // fail exactly one query
      return Promise.reject(new Error('Connection terminated unexpectedly'));
    });
    const failed = await admin.get(`/sessions/${s.id}`);
    vi.restoreAllMocks();
    expect(failed.status).toBe(503);
    expect(failed.headers['retry-after']).toBe('2');
    expect(ApiError.parse(failed.body).error.code).toBe('SERVICE_UNAVAILABLE');
    expect((await admin.get(`/sessions/${s.id}`)).status).toBe(200);
  });
});
