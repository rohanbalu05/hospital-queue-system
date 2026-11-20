/* PR-02: /health reports a dead worker; GET /admin/system shows job/outbox/notification backlog (admin only). */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HealthStatus, SystemStatus } from '@hqms/contracts';
import { createTestApp, loginAs, type Client, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Client;
let reception: Client;
let patient: Client;

beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  patient = await loginAs(t.server, 'patient@hqms.test');
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.pool.query(`DELETE FROM worker_heartbeats`);
});

const beat = (id: string, agoSec: number, opts: { types?: string[]; outbox?: boolean } = {}) =>
  t.pool.query(
    `INSERT INTO worker_heartbeats (worker_id, job_types, dispatch_outbox, started_at, last_seen_at)
     VALUES ($1, $2::text[], $3, now() - interval '1 hour', now() - make_interval(secs => $4))`,
    [id, opts.types ?? [], opts.outbox ?? true, agoSec],
  );

describe('GET /health', () => {
  it('is public and tiny; no heartbeat means degraded + worker down, still HTTP 200', async () => {
    const res = await request(t.server).get('/health');
    expect(res.status).toBe(200);
    expect(HealthStatus.parse(res.body)).toEqual({ status: 'degraded', db: 'up', worker: 'down' });
    expect(Object.keys(res.body).sort()).toEqual(['db', 'status', 'worker']);
  });

  it('a fresh heartbeat means ok / up', async () => {
    await beat('w6-fresh', 5);
    const res = await request(t.server).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up', worker: 'up' });
  });

  it('only stale heartbeats (older than WORKER_STALE_SEC = 60) mean down; any one fresh worker is enough', async () => {
    await beat('w6-old', 120);
    expect((await request(t.server).get('/health')).body).toEqual({ status: 'degraded', db: 'up', worker: 'down' });
    await beat('w6-new', 10);
    expect((await request(t.server).get('/health')).body).toEqual({ status: 'ok', db: 'up', worker: 'up' });
  });
});

describe('GET /admin/system', () => {
  it('is admin only', async () => {
    expect((await request(t.server).get('/admin/system')).status).toBe(401);
    expect((await reception.get('/admin/system')).status).toBe(403);
    expect((await patient.get('/admin/system')).status).toBe(403);
    expect((await admin.get('/admin/system')).status).toBe(200);
  });

  it('reports workers, overdue jobs, dead jobs, undispatched outbox and notification delivery state', async () => {
    const read = async () => SystemStatus.parse((await admin.get('/admin/system')).body);
    await beat('w6-sys-1', 3, { types: ['ocr_document'], outbox: false });
    await beat('w6-sys-2', 300);
    const before = await read();

    await t.pool.query(
      `INSERT INTO jobs (job_type, state, run_at, attempts, finished_at) VALUES
         ('w6_type', 'pending', now() - interval '10 minutes', 0, NULL),
         ('w6_type', 'failed',  now() - interval '5 minutes', 1, NULL),
         ('w6_type', 'pending', now() - interval '10 seconds', 0, NULL),      -- not overdue yet (< 60 s)
         ('w6_type', 'pending', now() + interval '10 minutes', 0, NULL),      -- future
         ('w6_type', 'running', now() - interval '1 minute', 1, NULL),
         ('w6_type', 'dead',    now() - interval '1 hour', 5, now() - interval '1 hour'),
         ('w6_type', 'dead',    now() - interval '3 days', 5, now() - interval '3 days')`,
    );
    const after = await read();
    expect(after.jobs.overdue - before.jobs.overdue).toBe(2);
    expect(after.jobs.running - before.jobs.running).toBe(1);
    expect(after.jobs.deadLast24h - before.jobs.deadLast24h).toBe(1);
    expect(after.jobs.oldestOverdueSeconds).toBeGreaterThanOrEqual(599);
    const mine = after.jobs.byType.find((b) => b.jobType === 'w6_type');
    expect(mine).toEqual({ jobType: 'w6_type', overdue: 2, dead24h: 1 });

    // workers
    expect(after.worker.status).toBe('up');
    const ids = after.worker.instances.map((i) => i.workerId);
    expect(ids).toEqual(expect.arrayContaining(['w6-sys-1', 'w6-sys-2']));
    const one = after.worker.instances.find((i) => i.workerId === 'w6-sys-1');
    expect(one).toMatchObject({ jobTypes: ['ocr_document'], dispatchOutbox: false, up: true });
    expect(after.worker.instances.find((i) => i.workerId === 'w6-sys-2')?.up).toBe(false);

    // outbox
    const ob = await read();
    await t.pool.query(
      `INSERT INTO outbox_events (event_type, entity_type, entity_id, entity_version, occurred_at)
       VALUES ('W6Probe', 'probe', gen_random_uuid(), 1, now() - interval '7 minutes')`,
    );
    const ob2 = await read();
    expect(ob2.outbox.undispatched - ob.outbox.undispatched).toBe(1);
    expect(ob2.outbox.oldestSeconds).toBeGreaterThanOrEqual(419);
    await t.pool.query(`UPDATE outbox_events SET dispatched_at = now() WHERE event_type = 'W6Probe'`);

    // notifications
    const n0 = await read();
    const ev = (
      await t.pool.query(
        `INSERT INTO outbox_events (event_type, entity_type, entity_id, entity_version, dispatched_at)
         VALUES ('W6Probe2', 'probe', gen_random_uuid(), 1, now()) RETURNING id`,
      )
    ).rows[0].id as string;
    const patientId = (await t.pool.query(`SELECT id FROM patients LIMIT 1`)).rows[0].id as string;
    await t.pool.query(
      `INSERT INTO notification_deliveries (event_id, patient_id, channel, address, body, status, created_at) VALUES
         ($1, $2, 'sms', '+910000000001', 'x', 'queued', now()),
         ($1, $2, 'sms', '+910000000002', 'x', 'failed', now() - interval '1 hour'),
         ($1, $2, 'sms', '+910000000003', 'x', 'failed', now() - interval '3 days')`,
      [ev, patientId],
    );
    const n1 = await read();
    expect(n1.notifications.queued - n0.notifications.queued).toBe(1);
    expect(n1.notifications.failedLast24h - n0.notifications.failedLast24h).toBe(1);
  });

  it('shows worker down when nothing has beaten recently', async () => {
    await beat('w6-stale-only', 400);
    const s = SystemStatus.parse((await admin.get('/admin/system')).body);
    expect(s.worker.status).toBe('down');
    expect(s.worker.lastSeenAt).not.toBeNull();
  });
});
