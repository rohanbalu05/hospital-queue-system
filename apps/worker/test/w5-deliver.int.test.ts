import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction, writeOutbox } from '@hqms/db';
import { FakeNotificationProvider, NotConfiguredError, TransientProviderError } from '@hqms/providers';
import { createDeliverNotificationHandler, notificationDeps } from '../src/handlers/notifications.js';
import { defaultHandlers } from '../src/handlers/index.js';
import { dispatchOutboxBatch } from '../src/outbox.js';
import { JobRunner } from '../src/runner.js';
import { bookAppointment, fixedClock, getJob, insertJob, makePool, makeWorld, testLog } from './helpers.js';

/** B2 (D-034): the deliver_notification job. The provider is called OUTSIDE any transaction; the outcome is one short tx. */

let pool: Pool;
let pool2: Pool;
const T0 = new Date('2030-03-01T04:00:00Z');

beforeAll(() => {
  pool = makePool(8);
  pool2 = makePool(3);
});
afterAll(async () => {
  await pool.query(`UPDATE jobs SET state = 'cancelled' WHERE job_type = 'deliver_notification' AND state IN ('pending', 'failed')`);
  await Promise.all([pool.end(), pool2.end()]);
});
beforeEach(async () => {
  // jobs left behind by other files must not be claimed by this file's runner
  await pool.query(`UPDATE jobs SET state = 'cancelled' WHERE job_type = 'deliver_notification' AND state IN ('pending', 'failed')`);
});

function runner(provider: FakeNotificationProvider, clock = fixedClock(T0)) {
  const r = new JobRunner({
    pool,
    handlers: { deliver_notification: createDeliverNotificationHandler(notificationDeps({}, { provider })) },
    workerId: 'w5-deliver',
    jobTypes: ['deliver_notification'],
    log: testLog,
    renewEveryMs: 0,
    backoffCapSec: 60,
    clock,
  });
  return { r, clock };
}

async function queuedDelivery(opts: { channel?: 'sms' | 'email'; address?: string; maxAttempts?: number } = {}) {
  const w = await makeWorld(pool);
  const a = await bookAppointment(pool, w, { login: false });
  const channel = opts.channel ?? 'sms';
  const address = opts.address ?? '+91 98765 43210';
  const d = await pool.query(
    `INSERT INTO notification_deliveries (patient_id, channel, address, body, status, session_id)
     VALUES ($1, $2, $3, 'Dr Test is back and seeing patients again.', 'queued', $4) RETURNING id`,
    [a.patientId, channel, address, w.sessionId],
  );
  const deliveryId = d.rows[0].id as string;
  const jobId = await insertJob(pool, {
    type: 'deliver_notification',
    payload: { deliveryId },
    dedupeKey: `deliver_notification:${deliveryId}`,
    maxAttempts: opts.maxAttempts ?? 3,
    runAt: T0,
  });
  return { deliveryId, jobId, address, w };
}
const delivery = async (id: string) => (await pool.query(`SELECT * FROM notification_deliveries WHERE id = $1`, [id])).rows[0];

describe('deliver_notification', () => {
  it('sends through the provider with the delivery id as idempotency key, then marks the row sent', async () => {
    const p = new FakeNotificationProvider();
    const { r } = runner(p);
    const { deliveryId, jobId, address } = await queuedDelivery();
    await r.drain();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]).toMatchObject({ channel: 'sms', to: address, idempotencyKey: deliveryId, body: 'Dr Test is back and seeing patients again.' });
    const row = await delivery(deliveryId);
    expect(row).toMatchObject({ status: 'sent', provider: 'fake', attempts: 1, last_error: null });
    expect(row.provider_message_id).toMatch(/^fake-[0-9a-f]{16}$/);
    expect(row.sent_at).not.toBeNull();
    expect((await getJob(pool, jobId)).state).toBe('succeeded');
  });

  it('an email delivery goes out on the email channel', async () => {
    const p = new FakeNotificationProvider();
    const { deliveryId } = await queuedDelivery({ channel: 'email', address: 'someone@example.org' });
    await runner(p).r.drain();
    expect(p.sent[0]).toMatchObject({ channel: 'email', to: 'someone@example.org' });
    expect((await delivery(deliveryId)).status).toBe('sent');
  });

  it('a delivery that is no longer queued is left alone (no second send after a redelivered job)', async () => {
    const p = new FakeNotificationProvider();
    const { deliveryId, jobId } = await queuedDelivery();
    await pool.query(`UPDATE notification_deliveries SET status = 'sent', sent_at = now(), provider = 'fake', provider_message_id = 'fake-x', attempts = 1 WHERE id = $1`, [deliveryId]);
    await runner(p).r.drain();
    expect(p.calls).toBe(0);
    expect((await getJob(pool, jobId)).state).toBe('succeeded');
    expect((await delivery(deliveryId)).attempts).toBe(1);
  });

  it('a transient failure is retried with the runner backoff and then succeeds', async () => {
    const p = new FakeNotificationProvider();
    p.failNext(1);
    const { r, clock } = runner(p);
    const { deliveryId, jobId } = await queuedDelivery();
    await r.drain();
    let row = await delivery(deliveryId);
    expect(row).toMatchObject({ status: 'queued', attempts: 1 });
    expect(row.last_error).toMatch(/unavailable/);
    expect((await getJob(pool, jobId)).state).toBe('failed'); // waiting for its backoff
    expect(await r.drain()).toBe(0); // not due yet
    clock.advance(10 * 60_000);
    await r.drain();
    row = await delivery(deliveryId);
    expect(row).toMatchObject({ status: 'sent', attempts: 2 });
    expect((await getJob(pool, jobId)).state).toBe('succeeded');
  });

  it('keeps failing: retried until max attempts, then the delivery is marked failed and the job is dead', async () => {
    const p = new FakeNotificationProvider();
    p.failAlways();
    const { r, clock } = runner(p);
    const { deliveryId, jobId } = await queuedDelivery({ maxAttempts: 3 });
    for (let i = 0; i < 3; i += 1) {
      await r.drain();
      clock.advance(10 * 60_000);
    }
    const row = await delivery(deliveryId);
    expect(row).toMatchObject({ status: 'failed', attempts: 3, sent_at: null, provider_message_id: null });
    expect((row.last_error as string).length).toBeLessThanOrEqual(200);
    expect(p.calls).toBe(3);
    expect((await getJob(pool, jobId)).state).toBe('dead');
    // dead means no more attempts
    clock.advance(24 * 3_600_000);
    await r.drain();
    expect(p.calls).toBe(3);
  });

  it('a provider that is not configured fails the delivery at once (no retries)', async () => {
    const p = new FakeNotificationProvider();
    p.failAlways(new NotConfiguredError('sms', 'SMS provider not configured in this build'));
    const { deliveryId, jobId } = await queuedDelivery({ maxAttempts: 5 });
    await runner(p).r.drain();
    expect(await delivery(deliveryId)).toMatchObject({ status: 'failed', attempts: 1 });
    expect((await delivery(deliveryId)).last_error).toMatch(/not configured/);
    expect((await getJob(pool, jobId)).state).toBe('dead');
    expect(p.calls).toBe(1);
  });

  it('the recorded error is short and never contains the address or a long number', async () => {
    const p = new FakeNotificationProvider();
    const address = '+91 98765 43210';
    p.failNext(1, new TransientProviderError(`gateway rejected ${address} / 919876543210 token=sk_live_ABCDEF1234567890 ${'x'.repeat(400)}`));
    const { deliveryId } = await queuedDelivery({ address });
    await runner(p).r.drain();
    const err = (await delivery(deliveryId)).last_error as string;
    expect(err.length).toBeLessThanOrEqual(200);
    expect(err).not.toContain('98765 43210');
    expect(err).not.toContain('919876543210');
  });

  it('calls the provider outside any transaction: no connection is idle in transaction and the row is not locked', async () => {
    const seen: Array<{ idleInTx: number; lockable: boolean }> = [];
    const p = new FakeNotificationProvider({
      onSend: async (m) => {
        const idle = await pool2.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND application_name = 'worker-test' AND state LIKE 'idle in transaction%'`,
        );
        let lockable = true;
        const c = await pool2.connect();
        try {
          await c.query('BEGIN');
          await c.query(`SELECT 1 FROM notification_deliveries WHERE id = $1 FOR UPDATE NOWAIT`, [m.idempotencyKey]);
          await c.query('ROLLBACK');
        } catch {
          lockable = false;
          await c.query('ROLLBACK').catch(() => undefined);
        } finally {
          c.release();
        }
        seen.push({ idleInTx: idle.rows[0].n as number, lockable });
      },
    });
    await queuedDelivery();
    await runner(p).r.drain();
    expect(seen).toEqual([{ idleInTx: 0, lockable: true }]);
  });

  it('a malformed payload is a permanent failure (dead), not a retry loop', async () => {
    const p = new FakeNotificationProvider();
    const jobId = await insertJob(pool, { type: 'deliver_notification', payload: { deliveryId: 'nope' }, maxAttempts: 5, runAt: T0 });
    await runner(p).r.drain();
    expect((await getJob(pool, jobId)).state).toBe('dead');
    expect(p.calls).toBe(0);
  });

  it('a delivery row that no longer exists cancels the job', async () => {
    const p = new FakeNotificationProvider();
    const { deliveryId, jobId } = await queuedDelivery();
    await pool.query(`DELETE FROM notification_deliveries WHERE id = $1`, [deliveryId]);
    await runner(p).r.drain();
    expect((await getJob(pool, jobId)).state).toBe('cancelled');
  });
});

describe('end to end: event -> fan-out -> delivery jobs -> provider', () => {
  it('every queued sms and email row of a SessionResumed event is sent exactly once, and the in-app rows were already sent', async () => {
    await pool.query(`UPDATE outbox_events SET dispatched_at = now() WHERE dispatched_at IS NULL`);
    const w = await makeWorld(pool);
    const a = await bookAppointment(pool, w, { login: true, scheduledAt: new Date('2030-03-01T05:30:00Z') });
    await pool.query(`UPDATE patients SET phone = '+91 90000 11111' WHERE id = $1`, [a.patientId]);
    await pool.query(`INSERT INTO staff_assignments (user_id, doctor_id) VALUES ($1, $2)`, [w.receptionUserId, w.doctorId]);
    const ev = await withTransaction(pool, (tx) =>
      writeOutbox(tx, {
        eventType: 'SessionResumed',
        entityType: 'session',
        entityId: w.sessionId,
        entityVersion: 3,
        sessionId: w.sessionId,
        payload: { queueVersion: 4, status: 'open', pauseUntil: null, update: false, doctorId: w.doctorId },
      }),
    );
    await dispatchOutboxBatch(pool);
    const before = (await pool.query(`SELECT channel, status FROM notification_deliveries WHERE event_id = $1 ORDER BY channel`, [ev.id])).rows;
    expect(before).toEqual([
      { channel: 'email', status: 'queued' },
      { channel: 'in_app', status: 'sent' },
      { channel: 'in_app', status: 'sent' },
      { channel: 'sms', status: 'queued' },
    ]);
    const p = new FakeNotificationProvider();
    await runner(p).r.drain();
    const after = (await pool.query(`SELECT channel, status, provider FROM notification_deliveries WHERE event_id = $1 ORDER BY channel`, [ev.id])).rows;
    expect(after.filter((r) => r.channel !== 'in_app').every((r) => r.status === 'sent' && r.provider === 'fake')).toBe(true);
    expect(p.sent.map((m) => m.channel).sort()).toEqual(['email', 'sms']);
    expect(p.sent.every((m) => m.body.includes('is back and seeing patients'))).toBe(true);
    // a second drain sends nothing more
    await runner(p).r.drain();
    expect(p.calls).toBe(2);
  });

  it('the default handler registry serves deliver_notification (the compose "worker" role needs it)', () => {
    expect(Object.keys(defaultHandlers())).toContain('deliver_notification');
  });
});
