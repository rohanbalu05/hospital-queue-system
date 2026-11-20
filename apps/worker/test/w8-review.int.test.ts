import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction, writeOutbox, type OutboxInput } from '@hqms/db';
import { dispatchOutboxBatch } from '../src/outbox.js';
import { bookAppointment, makeEntry, makePool, makeWorld, testLog } from './helpers.js';

/** Session-3 review fixes (D-039): shared phone, stale away/back fan-out. */

let pool: Pool;
beforeAll(() => {
  pool = makePool(6);
});
afterAll(async () => {
  await pool.query(`UPDATE jobs SET state = 'cancelled' WHERE job_type = 'deliver_notification' AND state IN ('pending', 'failed')`);
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`UPDATE outbox_events SET dispatched_at = now() WHERE dispatched_at IS NULL`);
});

const emit = (e: OutboxInput) => withTransaction(pool, (tx) => writeOutbox(tx, e));
const BACK_AT = '2030-03-01T05:15:00.000Z';
const LATER_AT = '2030-03-01T05:45:00.000Z';
const APPT_AT = new Date('2030-03-01T05:30:00Z');

const sessionEvent = (
  sessionId: string,
  doctorId: string,
  eventType: 'SessionPaused' | 'SessionResumed' | 'SessionUnavailable',
  status: string,
  pauseUntil: string | null = null,
) =>
  emit({
    eventType,
    entityType: 'session',
    entityId: sessionId,
    entityVersion: 2,
    sessionId,
    payload: { queueVersion: 9, status, pauseUntil, update: false, doctorId },
  });

const setSession = (sessionId: string, status: string, pauseUntil: string | null = null) =>
  pool.query(`UPDATE sessions SET status = $2, pause_until = $3 WHERE id = $1`, [sessionId, status, pauseUntil]);

const notes = async (eventId: string) => (await pool.query(`SELECT * FROM notifications WHERE event_id = $1`, [eventId])).rows;
const deliveries = async (eventId: string) =>
  (await pool.query(`SELECT * FROM notification_deliveries WHERE event_id = $1`, [eventId])).rows;

describe('relatives sharing one phone number (P1)', () => {
  it('each patient gets their own SMS row and deliver job; a replay of the event adds nothing', async () => {
    const w = await makeWorld(pool);
    const a = await bookAppointment(pool, w, { scheduledAt: APPT_AT });
    const b = await bookAppointment(pool, w, { scheduledAt: APPT_AT });
    const phone = '+91 9000000011';
    await pool.query(`UPDATE patients SET phone = $2 WHERE id = ANY($1::uuid[])`, [[a.patientId, b.patientId], phone]);
    await setSession(w.sessionId, 'unavailable');
    const ev = await sessionEvent(w.sessionId, w.doctorId, 'SessionUnavailable', 'unavailable');
    const r = await dispatchOutboxBatch(pool, { log: testLog });
    expect(r.failed).toEqual([]);

    const sms = (await deliveries(ev.id)).filter((d) => d.channel === 'sms');
    expect(sms).toHaveLength(2);
    expect(new Set(sms.map((d) => d.patient_id))).toEqual(new Set([a.patientId, b.patientId]));
    expect(sms.every((d) => d.address === phone)).toBe(true);
    const keys = sms.map((d) => `deliver_notification:${d.id}`);
    const jobs = await pool.query(`SELECT 1 FROM jobs WHERE job_type = 'deliver_notification' AND dedupe_key = ANY($1::text[])`, [keys]);
    expect(jobs.rowCount).toBe(2);

    // replay: un-dispatch the event and dispatch again
    await pool.query(`UPDATE outbox_events SET dispatched_at = NULL WHERE id = $1`, [ev.id]);
    await dispatchOutboxBatch(pool);
    expect((await deliveries(ev.id)).filter((d) => d.channel === 'sms')).toHaveLength(2);
    const again = await pool.query(`SELECT 1 FROM jobs WHERE job_type = 'deliver_notification' AND dedupe_key = ANY($1::text[])`, [keys]);
    expect(again.rowCount).toBe(2);
  });
});

describe('stale away/back fan-out is skipped (P2)', () => {
  const setup = async () => {
    const w = await makeWorld(pool);
    const waiting = await makeEntry(pool, w, { state: 'waiting', login: true });
    await pool.query(`UPDATE patients SET phone = $2 WHERE id = $1`, [waiting.patientId, '+91 9000000022']);
    await pool.query(`INSERT INTO staff_assignments (user_id, doctor_id) VALUES ($1, $2)`, [w.receptionUserId, w.doctorId]);
    return { w, waiting };
  };

  it('a SessionPaused dispatched after the doctor came back sends nothing', async () => {
    const { w } = await setup();
    await setSession(w.sessionId, 'paused', BACK_AT);
    const ev = await sessionEvent(w.sessionId, w.doctorId, 'SessionPaused', 'paused', BACK_AT);
    await setSession(w.sessionId, 'open'); // "I'm back" committed before the worker got to the pause event
    const r = await dispatchOutboxBatch(pool);
    expect(r.failed).toEqual([]);
    expect(await notes(ev.id)).toHaveLength(0);
    expect(await deliveries(ev.id)).toHaveLength(0);
    const stamped = (await pool.query(`SELECT dispatched_at FROM outbox_events WHERE id = $1`, [ev.id])).rows[0];
    expect(stamped.dispatched_at).not.toBeNull();
  });

  it('a SessionPaused whose return time was since changed is skipped; the current one is sent', async () => {
    const { w } = await setup();
    await setSession(w.sessionId, 'paused', BACK_AT);
    const old = await sessionEvent(w.sessionId, w.doctorId, 'SessionPaused', 'paused', BACK_AT);
    await setSession(w.sessionId, 'paused', LATER_AT);
    const current = await sessionEvent(w.sessionId, w.doctorId, 'SessionPaused', 'paused', LATER_AT);
    await dispatchOutboxBatch(pool);
    expect(await notes(old.id)).toHaveLength(0);
    expect((await notes(current.id)).length).toBeGreaterThan(0);
  });

  it('a SessionResumed is skipped when the session is away or unavailable again; sent when open', async () => {
    const { w } = await setup();
    const resumedAway = await sessionEvent(w.sessionId, w.doctorId, 'SessionResumed', 'open');
    await setSession(w.sessionId, 'paused', LATER_AT);
    await dispatchOutboxBatch(pool);
    expect(await notes(resumedAway.id)).toHaveLength(0);

    const resumedUnavail = await sessionEvent(w.sessionId, w.doctorId, 'SessionResumed', 'open');
    await setSession(w.sessionId, 'unavailable');
    await dispatchOutboxBatch(pool);
    expect(await notes(resumedUnavail.id)).toHaveLength(0);

    await setSession(w.sessionId, 'open');
    const ok = await sessionEvent(w.sessionId, w.doctorId, 'SessionResumed', 'open');
    await dispatchOutboxBatch(pool);
    expect((await notes(ok.id)).length).toBeGreaterThan(0);
  });

  it('SessionUnavailable is never skipped, whatever the session status is now', async () => {
    const { w } = await setup();
    const ev = await sessionEvent(w.sessionId, w.doctorId, 'SessionUnavailable', 'unavailable');
    await setSession(w.sessionId, 'open'); // reopened afterwards
    await dispatchOutboxBatch(pool);
    expect((await notes(ev.id)).length).toBeGreaterThan(0);
  });
});
