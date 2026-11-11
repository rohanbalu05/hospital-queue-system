import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capacityInvariant, enqueueJob, withTransaction } from '@hqms/db';
import { defaultHandlers, handleCallTimeout, handleReservationRelease } from '../src/handlers/index.js';
import { JobRunner } from '../src/runner.js';
import { systemClock, type JobContext, type JobRow } from '../src/types.js';
import {
  bookAppointment,
  fixedClock,
  getJob,
  insertJob,
  makeEntry,
  makePool,
  makeWorld,
  must,
  testLog,
  type World,
} from './helpers.js';

let pool: Pool;
let pool2: Pool;

beforeAll(() => {
  pool = makePool(8);
  pool2 = makePool(4);
});
afterAll(async () => {
  await Promise.all([pool.end(), pool2.end()]);
});
beforeEach(async () => {
  await pool.query(`DELETE FROM jobs`);
});

const NOW = new Date('2030-03-01T09:00:00.000Z');

function fakeJob(type: string, payload: Record<string, unknown>): JobRow {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    jobType: type,
    payload,
    dedupeKey: null,
    state: 'running',
    runAt: NOW,
    attempts: 1,
    maxAttempts: 5,
    leaseOwner: 'test',
    leaseExpiresAt: null,
    lastError: null,
  };
}

const ctxAt = (now: Date, p: Pool = pool): JobContext => ({
  pool: p,
  now: () => now,
  log: testLog,
  signal: new AbortController().signal,
});

const queueVersion = async (sessionId: string) =>
  Number((await pool.query(`SELECT queue_version FROM sessions WHERE id = $1`, [sessionId])).rows[0].queue_version);
const entry = async (id: string) => (await pool.query(`SELECT * FROM queue_entries WHERE id = $1`, [id])).rows[0];
const count = async (sql: string, params: unknown[]) => Number((await pool.query(sql, params)).rows[0].n);

describe('call_timeout (CALLED -> SKIPPED after 2 minutes)', () => {
  let w: World;
  const calledAt = new Date('2030-03-01T08:58:00.000Z');
  const payload = (entryId: string, at = calledAt) => ({ queueEntryId: entryId, calledAt: at.toISOString() });

  beforeEach(async () => {
    w = await makeWorld(pool);
  });

  it('before 120 s it defers until exactly called_at + 120 s and changes nothing', async () => {
    const e = await makeEntry(pool, w, { calledAt });
    const before = await queueVersion(w.sessionId);
    const early = new Date(calledAt.getTime() + 119_000);
    const res = await handleCallTimeout(fakeJob('call_timeout', payload(e.entryId)), ctxAt(early));
    expect(res).toEqual({ retryAt: new Date(calledAt.getTime() + 120_000) });
    expect((await entry(e.entryId)).state).toBe('called');
    expect(await queueVersion(w.sessionId)).toBe(before);
    expect(await count(`SELECT count(*) AS n FROM audit_events WHERE entity_id = $1`, [e.entryId])).toBe(0);
  });

  it('after 120 s it skips the entry, audits as system, emits the event, bumps queue_version and frees the doctor', async () => {
    const e = await makeEntry(pool, w, { calledAt, login: true });
    const before = await queueVersion(w.sessionId);
    const due = new Date(calledAt.getTime() + 120_000);

    // While the entry is called the doctor is occupied (partial unique index).
    const other = await makeEntry(pool, w, { state: 'waiting' });
    await expect(
      pool.query(`UPDATE queue_entries SET state = 'called', called_at = now() WHERE id = $1`, [other.entryId]),
    ).rejects.toMatchObject({ code: '23505' });

    const res = await handleCallTimeout(fakeJob('call_timeout', payload(e.entryId)), ctxAt(due));
    expect(res).toBeUndefined();

    const row = await entry(e.entryId);
    expect(row.state).toBe('skipped');
    expect(new Date(row.skipped_at).toISOString()).toBe(due.toISOString());
    expect(row.version).toBe(2);
    expect(row.call_count).toBe(1); // call history preserved

    expect(await queueVersion(w.sessionId)).toBe(before + 1);

    const audit = (await pool.query(`SELECT * FROM audit_events WHERE entity_id = $1`, [e.entryId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_id: null,
      actor_role: 'system',
      operation: 'queue.call_timeout',
      entity_type: 'queue_entry',
      reason: 'No answer within 2 minutes',
      policy_version: 1,
    });
    expect(audit[0].previous).toMatchObject({ state: 'called' });
    expect(audit[0].next).toMatchObject({ state: 'skipped' });

    const out = (await pool.query(`SELECT * FROM outbox_events WHERE entity_id = $1`, [e.entryId])).rows;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      event_type: 'QueuePatientSkipped',
      entity_type: 'queue_entry',
      session_id: w.sessionId,
      patient_id: e.patientId,
      entity_version: 2,
    });
    expect(out[0].payload).toEqual({ queueVersion: before + 1, token: e.token });

    // Doctor released: someone else can now be called.
    await expect(
      pool.query(`UPDATE queue_entries SET state = 'called', called_at = now(), call_count = 1 WHERE id = $1`, [
        other.entryId,
      ]),
    ).resolves.toBeTruthy();
  });

  it('is a no-op when the consultation already started', async () => {
    const e = await makeEntry(pool, w, { state: 'in_service', calledAt });
    const before = await queueVersion(w.sessionId);
    const res = await handleCallTimeout(
      fakeJob('call_timeout', payload(e.entryId)),
      ctxAt(new Date(calledAt.getTime() + 600_000)),
    );
    expect(res).toBeUndefined();
    expect((await entry(e.entryId)).state).toBe('in_service');
    expect(await queueVersion(w.sessionId)).toBe(before);
    expect(await count(`SELECT count(*) AS n FROM audit_events WHERE entity_id = $1`, [e.entryId])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM outbox_events WHERE entity_id = $1`, [e.entryId])).toBe(0);
  });

  it('ignores a stale job for an earlier call of the same entry (called_at differs)', async () => {
    const e = await makeEntry(pool, w, { calledAt });
    const staleCall = new Date(calledAt.getTime() - 30 * 60_000);
    const res = await handleCallTimeout(
      fakeJob('call_timeout', payload(e.entryId, staleCall)),
      ctxAt(new Date(calledAt.getTime() + 600_000)),
    );
    expect(res).toBeUndefined();
    expect((await entry(e.entryId)).state).toBe('called');
  });

  it('running the same job twice, even concurrently from two pools, has exactly one effect', async () => {
    const e = await makeEntry(pool, w, { calledAt });
    const before = await queueVersion(w.sessionId);
    const due = new Date(calledAt.getTime() + 121_000);
    const job = fakeJob('call_timeout', payload(e.entryId));
    await Promise.all([handleCallTimeout(job, ctxAt(due, pool)), handleCallTimeout(job, ctxAt(due, pool2))]);
    await handleCallTimeout(job, ctxAt(due));
    expect(await queueVersion(w.sessionId)).toBe(before + 1);
    expect((await entry(e.entryId)).version).toBe(2);
    expect(await count(`SELECT count(*) AS n FROM audit_events WHERE entity_id = $1`, [e.entryId])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM outbox_events WHERE entity_id = $1`, [e.entryId])).toBe(1);
  });

  it('a missing entry cancels the job instead of failing', async () => {
    const res = await handleCallTimeout(
      fakeJob('call_timeout', payload('11111111-1111-4111-8111-111111111111')),
      ctxAt(NOW),
    );
    expect(res).toEqual({ cancelled: true, reason: 'queue entry not found' });
  });

  it('end to end through the runner: enqueued with a stable dedupe key, deferred, then skipped once due', async () => {
    const e = await makeEntry(pool, w, { calledAt });
    const dedupeKey = `call_timeout:${e.entryId}:1`;
    const enqueue = () =>
      withTransaction(pool, (tx) =>
        enqueueJob(tx, {
          jobType: 'call_timeout',
          payload: payload(e.entryId),
          runAt: new Date(calledAt.getTime() + 120_000),
          dedupeKey,
        }),
      );
    const id = await enqueue();
    expect(id).not.toBeNull();
    expect(await enqueue()).toBeNull(); // duplicate enqueue is a no-op

    const clock = fixedClock(new Date(calledAt.getTime() + 60_000));
    const runner = new JobRunner({
      pool,
      workerId: 'timer-test',
      handlers: defaultHandlers(),
      clock,
      log: testLog,
      renewEveryMs: 0,
    });
    expect(await runner.drain()).toBe(0); // run_at is in the future
    clock.set(new Date(calledAt.getTime() + 120_000));
    expect(await runner.drain()).toBe(1);
    expect((await entry(e.entryId)).state).toBe('skipped');
    const job = await getJob(pool, must(id));
    expect(job.state).toBe('succeeded');
    expect(job.attempts).toBe(1);
  });

  it('a job that fires early (clock skew) is deferred without burning attempts', async () => {
    const e = await makeEntry(pool, w, { calledAt });
    const id = await insertJob(pool, {
      type: 'call_timeout',
      payload: payload(e.entryId),
      runAt: new Date(calledAt.getTime() + 30_000),
    });
    const clock = fixedClock(new Date(calledAt.getTime() + 60_000));
    const runner = new JobRunner({
      pool,
      workerId: 'timer-test',
      handlers: defaultHandlers(),
      clock,
      log: testLog,
      renewEveryMs: 0,
    });
    await runner.drain();
    const job = await getJob(pool, id);
    expect(job.state).toBe('pending');
    expect(job.attempts).toBe(0);
    expect(new Date(job.run_at).toISOString()).toBe(new Date(calledAt.getTime() + 120_000).toISOString());
    expect((await entry(e.entryId)).state).toBe('called');
  });

  it('bad payload goes straight to dead with a visible error', async () => {
    const id = await insertJob(pool, { type: 'call_timeout', payload: { queueEntryId: 'nope' } });
    const runner = new JobRunner({
      pool,
      workerId: 'timer-test',
      handlers: defaultHandlers(),
      log: testLog,
      renewEveryMs: 0,
    });
    await runner.drain();
    const job = await getJob(pool, id);
    expect(job.state).toBe('dead');
    expect(job.last_error).toContain('queueEntryId must be a uuid');
  });
});

describe('reservation_release (missed reservation after the 15-minute grace)', () => {
  let w: World;
  const scheduledAt = new Date('2030-03-01T09:00:00.000Z');
  beforeEach(async () => {
    w = await makeWorld(pool, { startsAt: scheduledAt });
  });

  const appt = async (id: string) => (await pool.query(`SELECT * FROM appointments WHERE id = $1`, [id])).rows[0];
  const caps = async () =>
    (await pool.query(`SELECT booked_reserved FROM session_capacity WHERE session_id = $1`, [w.sessionId])).rows[0]
      .booked_reserved as number;

  it('defers until scheduled_at + 15 min', async () => {
    const a = await bookAppointment(pool, w, { scheduledAt });
    const res = await handleReservationRelease(
      fakeJob('reservation_release', { appointmentId: a.appointmentId }),
      ctxAt(new Date(scheduledAt.getTime() + 14 * 60_000 + 59_000)),
    );
    expect(res).toEqual({ retryAt: new Date(scheduledAt.getTime() + 15 * 60_000) });
    expect((await appt(a.appointmentId)).status).toBe('booked');
    expect(await caps()).toBe(1);
  });

  it('after grace: marks missed, releases the place, audits as system, emits ReservationReleased', async () => {
    const a = await bookAppointment(pool, w, { scheduledAt });
    const b = await bookAppointment(pool, w, { scheduledAt });
    expect(await caps()).toBe(2);
    const due = new Date(scheduledAt.getTime() + 15 * 60_000);

    const res = await handleReservationRelease(
      fakeJob('reservation_release', { appointmentId: a.appointmentId }),
      ctxAt(due),
    );
    expect(res).toBeUndefined();

    expect((await appt(a.appointmentId)).status).toBe('missed');
    expect((await appt(a.appointmentId)).version).toBe(2);
    expect((await appt(b.appointmentId)).status).toBe('booked'); // others untouched
    expect(await caps()).toBe(1); // counter decreased
    expect(
      (await pool.query(`SELECT state FROM capacity_allocations WHERE id = $1`, [a.allocationId])).rows[0].state,
    ).toBe('released');
    const inv = await withTransaction(pool, (tx) => capacityInvariant(tx, w.sessionId));
    expect(inv.ok).toBe(true);

    const audit = (await pool.query(`SELECT * FROM audit_events WHERE entity_id = $1`, [a.appointmentId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_id: null,
      actor_role: 'system',
      operation: 'appointment.reservation_release',
      entity_type: 'appointment',
    });
    const out = (await pool.query(`SELECT * FROM outbox_events WHERE entity_id = $1`, [a.appointmentId])).rows;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      event_type: 'ReservationReleased',
      patient_id: a.patientId,
      session_id: w.sessionId,
      payload: { reason: 'timer' },
    });
  });

  it('is a no-op when the patient checked in (consumed allocation never reopens)', async () => {
    const a = await bookAppointment(pool, w, { scheduledAt });
    await pool.query(`UPDATE appointments SET status = 'checked_in', version = version + 1 WHERE id = $1`, [
      a.appointmentId,
    ]);
    await pool.query(`UPDATE capacity_allocations SET state = 'consumed' WHERE id = $1`, [a.allocationId]);
    const res = await handleReservationRelease(
      fakeJob('reservation_release', { appointmentId: a.appointmentId }),
      ctxAt(new Date(scheduledAt.getTime() + 3_600_000)),
    );
    expect(res).toBeUndefined();
    expect((await appt(a.appointmentId)).status).toBe('checked_in');
    expect(await caps()).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM audit_events WHERE entity_id = $1`, [a.appointmentId])).toBe(0);
  });

  it('is a no-op for a cancelled appointment', async () => {
    const a = await bookAppointment(pool, w, { scheduledAt });
    await pool.query(`UPDATE appointments SET status = 'cancelled' WHERE id = $1`, [a.appointmentId]);
    await pool.query(`UPDATE capacity_allocations SET state = 'released' WHERE id = $1`, [a.allocationId]);
    await pool.query(`UPDATE session_capacity SET booked_reserved = booked_reserved - 1 WHERE session_id = $1`, [
      w.sessionId,
    ]);
    await handleReservationRelease(
      fakeJob('reservation_release', { appointmentId: a.appointmentId }),
      ctxAt(new Date(scheduledAt.getTime() + 3_600_000)),
    );
    expect(await caps()).toBe(0); // no double decrement
    expect((await appt(a.appointmentId)).status).toBe('cancelled');
  });

  it('running the same job twice, concurrently, releases exactly once', async () => {
    const a = await bookAppointment(pool, w, { scheduledAt });
    const due = new Date(scheduledAt.getTime() + 20 * 60_000);
    const job = fakeJob('reservation_release', { appointmentId: a.appointmentId });
    await Promise.all([
      handleReservationRelease(job, ctxAt(due, pool)),
      handleReservationRelease(job, ctxAt(due, pool2)),
    ]);
    await handleReservationRelease(job, ctxAt(due));
    expect(await caps()).toBe(0);
    expect((await appt(a.appointmentId)).version).toBe(2);
    expect(await count(`SELECT count(*) AS n FROM audit_events WHERE entity_id = $1`, [a.appointmentId])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM outbox_events WHERE entity_id = $1`, [a.appointmentId])).toBe(1);
  });

  it('end to end through the runner with a system-clock job', async () => {
    const past = new Date(Date.now() - 3_600_000);
    const w2 = await makeWorld(pool, { startsAt: past });
    const a = await bookAppointment(pool, w2, { scheduledAt: past });
    const id = await insertJob(pool, { type: 'reservation_release', payload: { appointmentId: a.appointmentId } });
    const runner = new JobRunner({
      pool,
      workerId: 'timer-test',
      handlers: defaultHandlers(),
      clock: systemClock,
      log: testLog,
      renewEveryMs: 0,
    });
    await runner.drain();
    expect((await getJob(pool, id)).state).toBe('succeeded');
    expect((await appt(a.appointmentId)).status).toBe('missed');
  });
});

describe('W3 stubs', () => {
  it('ocr_document and reconcile_uploads are deferred an hour without burning attempts', async () => {
    const clock = fixedClock(new Date('2030-06-01T10:00:00Z'));
    const ocr = await insertJob(pool, {
      type: 'ocr_document',
      payload: { documentId: '22222222-2222-4222-8222-222222222222' },
      runAt: new Date('2030-06-01T09:00:00Z'),
    });
    const rec = await insertJob(pool, { type: 'reconcile_uploads', runAt: new Date('2030-06-01T09:00:00Z') });
    const runner = new JobRunner({
      pool,
      workerId: 'stub-test',
      handlers: defaultHandlers(),
      clock,
      log: testLog,
      renewEveryMs: 0,
    });
    await runner.drain();
    for (const id of [ocr, rec]) {
      const j = await getJob(pool, id);
      expect(j.state).toBe('pending');
      expect(j.attempts).toBe(0);
      expect(new Date(j.run_at).toISOString()).toBe('2030-06-01T11:00:00.000Z');
    }
  });
});
