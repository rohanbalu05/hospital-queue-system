/* PR-02: workers write a heartbeat row so /health and the admin panel can tell a dead worker from an idle one. */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Heartbeat } from '../src/heartbeat.js';
import { WorkerService } from '../src/service.js';
import { makePool, must, sleep, testLog, testUrl } from './helpers.js';

let pool: Pool;
beforeAll(() => {
  pool = makePool(4);
});
afterAll(async () => {
  await pool.end();
});

const row = async (id: string) =>
  (await pool.query(`SELECT * FROM worker_heartbeats WHERE worker_id = $1`, [id])).rows[0];

describe('Heartbeat', () => {
  it('upserts at start, refreshes on an interval, and deletes its own row on a clean stop', async () => {
    const hb = new Heartbeat({
      pool,
      workerId: 'w6-hb-a',
      jobTypes: ['call_timeout'],
      dispatchOutbox: true,
      intervalMs: 40,
      log: testLog,
    });
    await hb.start();
    const first = must(await row('w6-hb-a'), 'row after start');
    expect(first.job_types).toEqual(['call_timeout']);
    expect(first.dispatch_outbox).toBe(true);
    await sleep(150);
    const later = must(await row('w6-hb-a'), 'row later');
    expect(new Date(later.last_seen_at).getTime()).toBeGreaterThan(new Date(first.last_seen_at).getTime());
    expect(new Date(later.started_at).getTime()).toBe(new Date(first.started_at).getTime());
    await hb.stop();
    expect(await row('w6-hb-a')).toBeUndefined();
  });

  it('an empty job-type list means every type, and a stale row of the same id is taken over', async () => {
    await pool.query(
      `INSERT INTO worker_heartbeats (worker_id, job_types, dispatch_outbox, started_at, last_seen_at)
       VALUES ('w6-hb-b', ARRAY['x'], false, now() - interval '1 hour', now() - interval '1 hour')`,
    );
    const hb = new Heartbeat({ pool, workerId: 'w6-hb-b', jobTypes: null, dispatchOutbox: false, intervalMs: 1000, log: testLog });
    await hb.start();
    const r = must(await row('w6-hb-b'));
    expect(r.job_types).toEqual([]);
    expect(Date.now() - new Date(r.last_seen_at).getTime()).toBeLessThan(5000);
    await hb.stop();
  });

  it('a failing heartbeat write never throws out of the timer', async () => {
    const broken = { query: () => Promise.reject(new Error('db down')) } as unknown as Pool;
    const hb = new Heartbeat({ pool: broken, workerId: 'w6-hb-c', jobTypes: null, dispatchOutbox: true, intervalMs: 20, log: testLog });
    await hb.start(); // start() swallows the first failure too (logged); the loop retries
    await sleep(80);
    await hb.stop();
  });
});

describe('WorkerService', () => {
  it('writes its heartbeat on start and removes it on stop', async () => {
    const config = {
      ...loadConfig({ DATABASE_URL: testUrl(), WORKER_ID: 'w6-svc', WORKER_JOB_TYPES: 'never_a_real_type', WORKER_DISPATCH_OUTBOX: 'false' }),
      heartbeatSec: 1,
    };
    const svc = new WorkerService(config, testLog);
    svc.start();
    for (let i = 0; i < 100 && !(await row('w6-svc')); i++) await sleep(20);
    const r = must(await row('w6-svc'), 'service heartbeat');
    expect(r.job_types).toEqual(['never_a_real_type']);
    expect(r.dispatch_outbox).toBe(false);
    await svc.stop();
    expect(await row('w6-svc')).toBeUndefined();
  });
});
