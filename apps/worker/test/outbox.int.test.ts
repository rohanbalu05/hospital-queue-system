import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction, writeOutbox, type OutboxInput } from '@hqms/db';
import { dispatchOutboxBatch, OutboxDispatcher, renderNotification } from '../src/outbox.js';
import { bookAppointment, makeEntry, makePool, makeWorld, testLog, type World } from './helpers.js';

let pool: Pool;
let pool2: Pool;
let w: World;

beforeAll(() => {
  pool = makePool(8);
  pool2 = makePool(4);
});
afterAll(async () => {
  await Promise.all([pool.end(), pool2.end()]);
});
beforeEach(async () => {
  // Other test files leave undispatched events behind; start each test with a clean outbox.
  await pool.query(`UPDATE outbox_events SET dispatched_at = now() WHERE dispatched_at IS NULL`);
  w = await makeWorld(pool);
});

const emit = (e: OutboxInput) => withTransaction(pool, (tx) => writeOutbox(tx, e));
const notificationsFor = async (eventId: string) =>
  (await pool.query(`SELECT * FROM notifications WHERE event_id = $1`, [eventId])).rows;
const pending = async () =>
  Number((await pool.query(`SELECT count(*) AS n FROM outbox_events WHERE dispatched_at IS NULL`)).rows[0].n);

describe('outbox dispatcher', () => {
  it('creates a plain-text notification for a called patient (token + room, no clinical text)', async () => {
    const e = await makeEntry(pool, w, { login: true });
    const ev = await emit({
      eventType: 'QueuePatientCalled',
      entityType: 'queue_entry',
      entityId: e.entryId,
      entityVersion: 2,
      sessionId: w.sessionId,
      patientId: e.patientId,
      payload: { queueVersion: 7, token: e.token },
    });
    const r = await dispatchOutboxBatch(pool);
    expect(r.dispatched).toBe(1);
    expect(r.notifications).toBe(1);
    const n = await notificationsFor(ev.id);
    expect(n).toHaveLength(1);
    expect(n[0].recipient_user_id).toBe(e.userId);
    expect(n[0].kind).toBe('QueuePatientCalled');
    expect(n[0].body).toBe(`Your token ${e.token} has been called. Please go to ${w.room}.`);
    expect(n[0].read_at).toBeNull();
    const row = (await pool.query(`SELECT dispatched_at FROM outbox_events WHERE id = $1`, [ev.id])).rows[0];
    expect(row.dispatched_at).not.toBeNull();
  });

  it('renders every patient-facing event type without patient names or clinical text', async () => {
    const e = await makeEntry(pool, w, { login: true });
    const a = await bookAppointment(pool, w, { login: true, scheduledAt: new Date('2030-03-01T04:50:00Z') });
    const events: OutboxInput[] = [
      {
        eventType: 'AppointmentBooked',
        entityType: 'appointment',
        entityId: a.appointmentId,
        entityVersion: 1,
        sessionId: w.sessionId,
        patientId: a.patientId,
      },
      {
        eventType: 'AppointmentRescheduled',
        entityType: 'appointment',
        entityId: a.appointmentId,
        entityVersion: 2,
        sessionId: w.sessionId,
        patientId: a.patientId,
      },
      {
        eventType: 'AppointmentCancelled',
        entityType: 'appointment',
        entityId: a.appointmentId,
        entityVersion: 3,
        sessionId: w.sessionId,
        patientId: a.patientId,
      },
      {
        eventType: 'ReservationReleased',
        entityType: 'appointment',
        entityId: a.appointmentId,
        entityVersion: 4,
        sessionId: w.sessionId,
        patientId: a.patientId,
      },
      {
        eventType: 'QueuePatientSkipped',
        entityType: 'queue_entry',
        entityId: e.entryId,
        entityVersion: 2,
        sessionId: w.sessionId,
        patientId: e.patientId,
        payload: { token: e.token },
      },
    ];
    const ids: string[] = [];
    for (const ev of events) ids.push((await emit(ev)).id);
    await dispatchOutboxBatch(pool);
    const rows = (
      await pool.query(`SELECT kind, body FROM notifications WHERE event_id = ANY($1::uuid[]) ORDER BY kind`, [ids])
    ).rows;
    expect(rows).toHaveLength(5);
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r.body as string]));
    expect(byKind['AppointmentBooked']).toMatch(/^Your appointment with Dr Test .+ on 1 Mar, 10:20 am is confirmed\.$/); // 04:50Z = 10:20 IST
    expect(byKind['AppointmentCancelled']).toContain('cancelled');
    expect(byKind['AppointmentRescheduled']).toContain('moved to');
    expect(byKind['ReservationReleased']).toContain('released');
    expect(byKind['QueuePatientSkipped']).toContain(e.token);
    for (const body of Object.values(byKind)) expect(body).not.toMatch(/Patient Secret/);
  });

  it('skips patients without a login and non-patient events, but still marks them dispatched', async () => {
    const noLogin = await makeEntry(pool, w, { state: 'waiting', login: false });
    const ev1 = await emit({
      eventType: 'QueuePatientCalled',
      entityType: 'queue_entry',
      entityId: noLogin.entryId,
      entityVersion: 1,
      sessionId: w.sessionId,
      patientId: noLogin.patientId,
      payload: { token: noLogin.token },
    });
    const ev2 = await emit({
      eventType: 'SessionPaused',
      entityType: 'session',
      entityId: w.sessionId,
      entityVersion: 2,
      sessionId: w.sessionId,
    });
    const r = await dispatchOutboxBatch(pool);
    expect(r.dispatched).toBe(2);
    expect(r.notifications).toBe(0);
    expect(await notificationsFor(ev1.id)).toHaveLength(0);
    expect(await notificationsFor(ev2.id)).toHaveLength(0);
    expect(await pending()).toBe(0);
  });

  it('resolves the patient from the entity when the event carries no patient id', async () => {
    const e = await makeEntry(pool, w, { login: true });
    const ev = await emit({
      eventType: 'QueuePatientSkipped',
      entityType: 'queue_entry',
      entityId: e.entryId,
      entityVersion: 2,
      sessionId: w.sessionId,
    });
    await dispatchOutboxBatch(pool);
    expect(await notificationsFor(ev.id)).toHaveLength(1);
  });

  it('two dispatchers running concurrently produce exactly one notification per event', async () => {
    const eventIds: string[] = [];
    for (let i = 0; i < 30; i++) {
      const e = await makeEntry(pool, w, { state: 'waiting', login: true });
      eventIds.push(
        (
          await emit({
            eventType: 'QueuePatientCalled',
            entityType: 'queue_entry',
            entityId: e.entryId,
            entityVersion: 1,
            sessionId: w.sessionId,
            patientId: e.patientId,
            payload: { token: e.token },
          })
        ).id,
      );
    }
    const a = new OutboxDispatcher({ pool, batch: 4, log: testLog });
    const b = new OutboxDispatcher({ pool: pool2, batch: 4, log: testLog });
    const [ra, rb] = await Promise.all([a.drain(), b.drain()]);
    expect(ra.dispatched + rb.dispatched).toBe(30);
    expect(ra.notifications + rb.notifications).toBe(30);
    const n = await pool.query(
      `SELECT event_id, count(*)::int AS c FROM notifications WHERE event_id = ANY($1::uuid[]) GROUP BY event_id`,
      [eventIds],
    );
    expect(n.rows).toHaveLength(30);
    expect(n.rows.every((r) => r.c === 1)).toBe(true);
    expect(await pending()).toBe(0);
  });

  it('redelivery is safe: re-running an already notified event inserts nothing new (ON CONFLICT)', async () => {
    const e = await makeEntry(pool, w, { login: true });
    const ev = await emit({
      eventType: 'QueuePatientCalled',
      entityType: 'queue_entry',
      entityId: e.entryId,
      entityVersion: 1,
      sessionId: w.sessionId,
      patientId: e.patientId,
      payload: { token: e.token },
    });
    await dispatchOutboxBatch(pool);
    await pool.query(`UPDATE outbox_events SET dispatched_at = NULL WHERE id = $1`, [ev.id]); // crash-before-ack simulation
    const again = await dispatchOutboxBatch(pool);
    expect(again.dispatched).toBe(1);
    expect(again.notifications).toBe(0);
    expect(await notificationsFor(ev.id)).toHaveLength(1);
  });

  it('a failing event does not block or roll back the others; it stays undispatched', async () => {
    const good = await makeEntry(pool, w, { login: true });
    const bad = await makeEntry(pool, w, { state: 'waiting', login: true });
    const goodEv = await emit({
      eventType: 'QueuePatientCalled',
      entityType: 'queue_entry',
      entityId: good.entryId,
      entityVersion: 1,
      sessionId: w.sessionId,
      patientId: good.patientId,
      payload: { token: good.token },
    });
    const badEv = await emit({
      eventType: 'QueuePatientCalled',
      entityType: 'queue_entry',
      entityId: bad.entryId,
      entityVersion: 1,
      sessionId: w.sessionId,
      patientId: bad.patientId,
      payload: { token: bad.token },
    });
    const d = new OutboxDispatcher({
      pool,
      log: testLog,
      render: async (tx, ev) => {
        if (ev.id === badEv.id) {
          await tx.query(`SELECT * FROM table_that_does_not_exist`); // poisons the statement, savepoint must absorb it
        }
        return renderNotification(tx, ev);
      },
    });
    const r = await d.drain();
    expect(r.dispatched).toBe(1);
    expect(await notificationsFor(goodEv.id)).toHaveLength(1);
    expect(await notificationsFor(badEv.id)).toHaveLength(0);
    expect(await pending()).toBe(1); // visible, retried later
    // Cooling down: an immediate second drain does not hammer the poison event.
    expect((await d.drain()).dispatched).toBe(0);
  });
});
