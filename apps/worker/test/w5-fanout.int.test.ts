import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOTIFICATION_LINKS } from '@hqms/contracts';
import { withTransaction, writeOutbox, type OutboxInput } from '@hqms/db';
import { dispatchOutboxBatch } from '../src/outbox.js';
import { bookAppointment, makeEntry, makePool, makeWorld, type World } from './helpers.js';

/**
 * B2 (D-034): one SessionPaused / SessionResumed / SessionUnavailable event fans out to many recipients:
 * checked-in patients, booked patients who have not arrived, and the doctor's reception staff. Patients also get
 * SMS and email delivery rows (queued, with a deliver_notification job in the same transaction).
 */

let pool: Pool;

beforeAll(() => {
  pool = makePool(8);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`UPDATE outbox_events SET dispatched_at = now() WHERE dispatched_at IS NULL`);
});

const emit = (e: OutboxInput) => withTransaction(pool, (tx) => writeOutbox(tx, e));
// 05:15 UTC = 10:45 IST, 05:45 UTC = 11:15 IST; the booked appointment is at 11:00 IST (05:30 UTC)
const BACK_AT = '2030-03-01T05:15:00.000Z';
const LATER_AT = '2030-03-01T05:45:00.000Z';
const APPT_AT = new Date('2030-03-01T05:30:00Z');

interface Scene {
  w: World;
  doctorName: string;
  department: string;
  other: World;
  receptionId: string;
  /** reception assigned to ANOTHER doctor */
  strangerReceptionId: string;
  cin: { patientId: string; userId: string; phone: string; email: string; token: string };
  cinNoLogin: { patientId: string; phone: string; token: string };
  skipped: { userId: string };
  absent: { userId: string };
  done: { userId: string };
  booked: { patientId: string; userId: string; phone: string; email: string; appointmentId: string };
  bookedNoPhone: { userId: string };
  bookedCancelled: { userId: string };
  silent: { patientId: string };
}

const phoneOf = () => `+91 9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

async function setPhone(patientId: string, phone: string | null): Promise<void> {
  await pool.query(`UPDATE patients SET phone = $2 WHERE id = $1`, [patientId, phone]);
}
const emailOf = async (userId: string): Promise<string> =>
  (await pool.query(`SELECT email FROM users WHERE id = $1`, [userId])).rows[0].email as string;

async function scene(): Promise<Scene> {
  const w = await makeWorld(pool);
  const other = await makeWorld(pool);
  const info = (await pool.query(`SELECT full_name, department FROM doctors WHERE id = $1`, [w.doctorId])).rows[0];
  // the world's reception user works for the doctor; a second one works for somebody else
  await pool.query(`INSERT INTO staff_assignments (user_id, doctor_id) VALUES ($1, $2)`, [w.receptionUserId, w.doctorId]);
  await pool.query(`INSERT INTO staff_assignments (user_id, doctor_id) VALUES ($1, $2)`, [other.receptionUserId, other.doctorId]);

  const cin1 = await makeEntry(pool, w, { state: 'waiting', login: true });
  const cinPhone = phoneOf();
  await setPhone(cin1.patientId, cinPhone);
  const cin2 = await makeEntry(pool, w, { state: 'waiting', login: false });
  const cinNoLoginPhone = phoneOf();
  await setPhone(cin2.patientId, cinNoLoginPhone);
  // skipped and absent patients still hold their place: they are notified too
  const sk = await makeEntry(pool, w, { state: 'waiting', login: true });
  await pool.query(`UPDATE queue_entries SET state = 'skipped', skipped_at = now() WHERE id = $1`, [sk.entryId]);
  const ab = await makeEntry(pool, w, { state: 'waiting', login: true });
  await pool.query(`UPDATE queue_entries SET state = 'absent' WHERE id = $1`, [ab.entryId]);
  // a finished consultation is not affected
  const dn = await makeEntry(pool, w, { state: 'waiting', login: true });
  await pool.query(`UPDATE queue_entries SET state = 'completed' WHERE id = $1`, [dn.entryId]);
  await pool.query(`UPDATE visits SET status = 'completed' WHERE id = $1`, [dn.visitId]);

  const b1 = await bookAppointment(pool, w, { scheduledAt: APPT_AT, login: true });
  const bookedPhone = phoneOf();
  await setPhone(b1.patientId, bookedPhone);
  const b2 = await bookAppointment(pool, w, { scheduledAt: APPT_AT, login: true });
  const b3 = await bookAppointment(pool, w, { scheduledAt: APPT_AT, login: true });
  await pool.query(`UPDATE appointments SET status = 'cancelled' WHERE id = $1`, [b3.appointmentId]);
  const silent = await bookAppointment(pool, w, { scheduledAt: APPT_AT, login: false }); // no login, no phone
  const strangerReceptionId = other.receptionUserId;

  return {
    w,
    doctorName: info.full_name as string,
    department: info.department as string,
    other,
    receptionId: w.receptionUserId,
    strangerReceptionId,
    cin: { patientId: cin1.patientId, userId: cin1.userId!, phone: cinPhone, email: await emailOf(cin1.userId!), token: cin1.token },
    cinNoLogin: { patientId: cin2.patientId, phone: cinNoLoginPhone, token: cin2.token },
    skipped: { userId: sk.userId! },
    absent: { userId: ab.userId! },
    done: { userId: dn.userId! },
    booked: { patientId: b1.patientId, userId: b1.userId!, phone: bookedPhone, email: await emailOf(b1.userId!), appointmentId: b1.appointmentId },
    bookedNoPhone: { userId: b2.userId! },
    bookedCancelled: { userId: b3.userId! },
    silent: { patientId: silent.patientId },
  };
}

const sessionEvent = (
  sc: Scene,
  eventType: 'SessionPaused' | 'SessionResumed' | 'SessionUnavailable',
  payload: { pauseUntil?: string | null; update?: boolean } = {},
  status = eventType === 'SessionPaused' ? 'paused' : eventType === 'SessionResumed' ? 'open' : 'unavailable',
) =>
  emit({
    eventType,
    entityType: 'session',
    entityId: sc.w.sessionId,
    entityVersion: 2,
    sessionId: sc.w.sessionId,
    payload: { queueVersion: 9, status, pauseUntil: payload.pauseUntil ?? null, update: payload.update ?? false, doctorId: sc.w.doctorId },
  });

const noteFor = async (eventId: string, userId: string) =>
  (await pool.query(`SELECT * FROM notifications WHERE event_id = $1 AND recipient_user_id = $2`, [eventId, userId])).rows[0];
const deliveries = async (eventId: string) =>
  (await pool.query(`SELECT * FROM notification_deliveries WHERE event_id = $1 ORDER BY channel, address`, [eventId])).rows;
const jobsFor = async (deliveryIds: string[]) =>
  (await pool.query(`SELECT * FROM jobs WHERE job_type = 'deliver_notification' AND dedupe_key = ANY($1::text[])`, [deliveryIds.map((d) => `deliver_notification:${d}`)])).rows;

describe('SessionPaused (step away): who is told, over which channel, with which words', () => {
  it('fans out to checked-in patients, booked patients who have not arrived and the doctor\'s reception; nobody else', async () => {
    const sc = await scene();
    const ev = await sessionEvent(sc, 'SessionPaused', { pauseUntil: BACK_AT });
    const r = await dispatchOutboxBatch(pool);
    expect(r.failed).toEqual([]);
    const all = (await pool.query(`SELECT recipient_user_id FROM notifications WHERE event_id = $1`, [ev.id])).rows.map((x) => x.recipient_user_id as string);
    expect(new Set(all)).toEqual(
      new Set([sc.cin.userId, sc.skipped.userId, sc.absent.userId, sc.booked.userId, sc.bookedNoPhone.userId, sc.receptionId]),
    );
    expect(all).toHaveLength(6); // one each
    for (const none of [sc.done.userId, sc.bookedCancelled.userId, sc.strangerReceptionId]) {
      expect(await noteFor(ev.id, none)).toBeUndefined();
    }
    // the event is stamped dispatched
    expect((await pool.query(`SELECT dispatched_at FROM outbox_events WHERE id = $1`, [ev.id])).rows[0].dispatched_at).not.toBeNull();
    expect(r.notifications).toBe(6);
  });

  it('checked-in patient: wording with the IST return time, warning severity, link to the visit; in-app + sms + email deliveries', async () => {
    const sc = await scene();
    const ev = await sessionEvent(sc, 'SessionPaused', { pauseUntil: BACK_AT });
    await dispatchOutboxBatch(pool);
    const n = await noteFor(ev.id, sc.cin.userId);
    expect(n.body).toBe(
      `${sc.doctorName} has stepped away and is expected back about 10:45 am. Your place in the queue is kept; your estimated wait now includes this break.`,
    );
    expect(n).toMatchObject({ kind: 'SessionPaused', severity: 'warning', link: NOTIFICATION_LINKS.patientVisit(sc.w.sessionId), read_at: null });

    const rows = (await deliveries(ev.id)).filter((d) => d.patient_id === sc.cin.patientId);
    expect(rows.map((d) => d.channel).sort()).toEqual(['email', 'in_app', 'sms']);
    const inApp = rows.find((d) => d.channel === 'in_app');
    expect(inApp).toMatchObject({ status: 'sent', notification_id: n.id, recipient_user_id: sc.cin.userId, body: n.body, session_id: sc.w.sessionId });
    expect(inApp.sent_at).not.toBeNull();
    const sms = rows.find((d) => d.channel === 'sms');
    expect(sms).toMatchObject({ status: 'queued', address: sc.cin.phone, body: n.body, attempts: 0, sent_at: null });
    const email = rows.find((d) => d.channel === 'email');
    expect(email).toMatchObject({ status: 'queued', address: sc.cin.email, body: n.body });
    // one durable job per queued row, created in the same transaction with a stable dedupe key
    const jobs = await jobsFor([sms.id, email.id]);
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.state === 'pending')).toBe(true);
    expect(jobs.map((j) => j.payload.deliveryId).sort()).toEqual([sms.id, email.id].sort());
    // an in-app row never gets a job
    expect(await jobsFor([inApp.id])).toHaveLength(0);
  });

  it('booked patient who has not arrived: "running behind", the appointment time, link to Today', async () => {
    const sc = await scene();
    const ev = await sessionEvent(sc, 'SessionPaused', { pauseUntil: BACK_AT });
    await dispatchOutboxBatch(pool);
    const n = await noteFor(ev.id, sc.booked.userId);
    expect(n.body).toBe(
      `${sc.doctorName} is running behind: stepped away, expected back about 10:45 am. Your 11:00 am appointment stands; you may be seen a little later.`,
    );
    expect(n).toMatchObject({ severity: 'warning', link: NOTIFICATION_LINKS.patientToday() });
    const ch = (await deliveries(ev.id)).filter((d) => d.patient_id === sc.booked.patientId).map((d) => d.channel).sort();
    expect(ch).toEqual(['email', 'in_app', 'sms']);
  });

  it('reception of the doctor: counts, in-app only, link to the session board; reception of another doctor gets nothing', async () => {
    const sc = await scene();
    const ev = await sessionEvent(sc, 'SessionPaused', { pauseUntil: BACK_AT });
    await dispatchOutboxBatch(pool);
    const n = await noteFor(ev.id, sc.receptionId);
    // waiting: cin + cinNoLogin (skipped, absent and completed are not "waiting"); booked not arrived: 3 booked rows (b1, b2, silent)
    expect(n.body).toBe(`${sc.doctorName} stepped away (back about 10:45 am). 2 waiting, 3 booked not arrived.`);
    expect(n).toMatchObject({ severity: 'warning', link: NOTIFICATION_LINKS.receptionSession(sc.w.sessionId) });
    const rows = (await deliveries(ev.id)).filter((d) => d.recipient_user_id === sc.receptionId);
    expect(rows.map((d) => d.channel)).toEqual(['in_app']);
    expect(await noteFor(ev.id, sc.strangerReceptionId)).toBeUndefined();
    expect((await deliveries(ev.id)).some((d) => d.recipient_user_id === sc.strangerReceptionId)).toBe(false);
  });

  it('a patient without a login gets SMS only (no in-app notification); a patient with neither gets nothing', async () => {
    const sc = await scene();
    const ev = await sessionEvent(sc, 'SessionPaused', { pauseUntil: BACK_AT });
    await dispatchOutboxBatch(pool);
    const rows = (await deliveries(ev.id)).filter((d) => d.patient_id === sc.cinNoLogin.patientId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'sms', status: 'queued', address: sc.cinNoLogin.phone, recipient_user_id: null, notification_id: null });
    expect(rows[0].body).toContain('has stepped away and is expected back about 10:45 am');
    expect((await deliveries(ev.id)).some((d) => d.patient_id === sc.silent.patientId)).toBe(false);
    // a patient with a login but no phone: in-app (and email), no sms
    const noPhone = (await deliveries(ev.id)).filter((d) => d.recipient_user_id === sc.bookedNoPhone.userId).map((d) => d.channel).sort();
    expect(noPhone).toEqual(['email', 'in_app']);
  });

  it('no return time given: the notice says so and promises to tell the patient when the doctor is back', async () => {
    const sc = await scene();
    const ev = await sessionEvent(sc, 'SessionPaused', {});
    await dispatchOutboxBatch(pool);
    expect((await noteFor(ev.id, sc.cin.userId)).body).toBe(
      `${sc.doctorName} has stepped away. Your place in the queue is kept. We will tell you when the doctor is back.`,
    );
    expect((await noteFor(ev.id, sc.booked.userId)).body).toBe(
      `${sc.doctorName} is running behind: stepped away, no return time given. Your 11:00 am appointment stands; you may be seen a little later.`,
    );
    expect((await noteFor(ev.id, sc.receptionId)).body).toBe(`${sc.doctorName} stepped away (no return time given). 2 waiting, 3 booked not arrived.`);
  });

  it('an update while away starts with "Update:" and gives the new time', async () => {
    const sc = await scene();
    const ev = await sessionEvent(sc, 'SessionPaused', { pauseUntil: LATER_AT, update: true });
    await dispatchOutboxBatch(pool);
    const checked = (await noteFor(ev.id, sc.cin.userId)).body as string;
    expect(checked.startsWith('Update: ')).toBe(true);
    expect(checked).toContain('11:15 am');
    expect(checked).toContain('Your place in the queue is kept');
    const booked = (await noteFor(ev.id, sc.booked.userId)).body as string;
    expect(booked.startsWith('Update: ')).toBe(true);
    expect(booked).toContain('11:15 am');
    expect(booked).toContain('Your 11:00 am appointment stands');
    expect(((await noteFor(ev.id, sc.receptionId)).body as string).startsWith('Update: ')).toBe(true);
  });
});

describe('SessionResumed (I am back)', () => {
  it('tells checked-in, booked and reception; info severity; the same links as for away', async () => {
    const sc = await scene();
    const ev = await sessionEvent(sc, 'SessionResumed');
    await dispatchOutboxBatch(pool);
    const c = await noteFor(ev.id, sc.cin.userId);
    expect(c).toMatchObject({
      body: `${sc.doctorName} is back and seeing patients again. Your place in the queue is unchanged.`,
      severity: 'info',
      link: NOTIFICATION_LINKS.patientVisit(sc.w.sessionId),
      kind: 'SessionResumed',
    });
    const b = await noteFor(ev.id, sc.booked.userId);
    expect(b).toMatchObject({
      body: `${sc.doctorName} is back and seeing patients. Your 11:00 am appointment stands.`,
      severity: 'info',
      link: NOTIFICATION_LINKS.patientToday(),
    });
    const r = await noteFor(ev.id, sc.receptionId);
    expect(r).toMatchObject({ body: `${sc.doctorName} is back.`, severity: 'info', link: NOTIFICATION_LINKS.receptionSession(sc.w.sessionId) });
    expect(await noteFor(ev.id, sc.strangerReceptionId)).toBeUndefined();
    // sms and email are queued for patients here as well
    expect((await deliveries(ev.id)).filter((d) => d.channel === 'sms' && d.status === 'queued').length).toBe(3);
  });
});

describe('SessionUnavailable', () => {
  it('urgent; booked patients are told to rebook or cancel (link opens the rebook panel), checked-in patients to see reception', async () => {
    const sc = await scene();
    const ev = await sessionEvent(sc, 'SessionUnavailable');
    await dispatchOutboxBatch(pool);
    const b = await noteFor(ev.id, sc.booked.userId);
    expect(b.body).toBe(
      `${sc.doctorName} is not available for the rest of today's morning session. Please rebook with another ${sc.department} doctor or cancel your 11:00 am appointment.`,
    );
    expect(b).toMatchObject({ severity: 'urgent', link: NOTIFICATION_LINKS.patientRebook(sc.booked.appointmentId), kind: 'SessionUnavailable' });
    const c = await noteFor(ev.id, sc.cin.userId);
    expect(c.body).toBe(`${sc.doctorName} is not available for the rest of this session. Please see reception: they will move you to another doctor.`);
    expect(c).toMatchObject({ severity: 'urgent', link: NOTIFICATION_LINKS.patientVisit(sc.w.sessionId) });
    // 4 checked-in (cin, cinNoLogin, skipped, absent) + 3 booked not arrived
    const r = await noteFor(ev.id, sc.receptionId);
    expect(r.body).toBe(
      `${sc.doctorName} is unavailable for the rest of the session. 7 patients are affected: open the session board to move them.`,
    );
    expect(r).toMatchObject({ severity: 'urgent', link: NOTIFICATION_LINKS.receptionSession(sc.w.sessionId) });
  });

  it('the wording never carries the free-text reason (it is not even in the event)', async () => {
    const sc = await scene();
    await pool.query(`UPDATE sessions SET pause_reason = 'Secret family emergency' WHERE id = $1`, [sc.w.sessionId]);
    const ev = await sessionEvent(sc, 'SessionUnavailable');
    await dispatchOutboxBatch(pool);
    const bodies = (await pool.query(`SELECT body FROM notifications WHERE event_id = $1`, [ev.id])).rows.map((x) => x.body as string);
    const sent = (await deliveries(ev.id)).map((d) => d.body as string);
    for (const body of [...bodies, ...sent]) expect(body).not.toMatch(/Secret|family|emergency/i);
  });
});

describe('idempotency under redelivery', () => {
  it('dispatching the same event again creates no second notification, delivery or job', async () => {
    const sc = await scene();
    const ev = await sessionEvent(sc, 'SessionPaused', { pauseUntil: BACK_AT });
    await dispatchOutboxBatch(pool);
    const count = async () => ({
      notes: Number((await pool.query(`SELECT count(*) AS n FROM notifications WHERE event_id = $1`, [ev.id])).rows[0].n),
      deliveries: Number((await pool.query(`SELECT count(*) AS n FROM notification_deliveries WHERE event_id = $1`, [ev.id])).rows[0].n),
      jobs: Number(
        (await pool.query(`SELECT count(*) AS n FROM jobs WHERE job_type = 'deliver_notification' AND payload->>'deliveryId' = ANY(SELECT id::text FROM notification_deliveries WHERE event_id = $1)`, [ev.id])).rows[0].n,
      ),
    });
    const first = await count();
    // 6 in-app + 3 sms (cin, cin without login, booked) + 5 email (every recipient with a login except reception)
    expect(first).toEqual({ notes: 6, deliveries: 14, jobs: 8 });
    await pool.query(`UPDATE outbox_events SET dispatched_at = NULL WHERE id = $1`, [ev.id]);
    const again = await dispatchOutboxBatch(pool);
    expect(again.dispatched).toBe(1);
    expect(again.notifications).toBe(0);
    expect(await count()).toEqual(first);
  });
});

describe('QueuePatientTransferred', () => {
  it('tells the moved patient the new doctor, room and token; warning; link to the new visit; in-app + sms (no email)', async () => {
    const sc = await scene();
    const target = await makeWorld(pool);
    const moved = await makeEntry(pool, target, { state: 'waiting', login: true });
    const phone = phoneOf();
    await setPhone(moved.patientId, phone);
    const targetDoctor = (await pool.query(`SELECT full_name FROM doctors WHERE id = $1`, [target.doctorId])).rows[0].full_name as string;
    const ev = await emit({
      eventType: 'QueuePatientTransferred',
      entityType: 'queue_entry',
      entityId: moved.entryId,
      entityVersion: 1,
      sessionId: target.sessionId,
      patientId: moved.patientId,
      payload: { queueVersion: 3, fromSessionId: sc.w.sessionId },
    });
    await dispatchOutboxBatch(pool);
    const n = await noteFor(ev.id, moved.userId!);
    expect(n.body).toBe(`You have been moved to ${targetDoctor} in ${target.room}. Your new token is ${moved.token}.`);
    expect(n).toMatchObject({ severity: 'warning', link: NOTIFICATION_LINKS.patientVisit(target.sessionId), kind: 'QueuePatientTransferred' });
    const rows = await deliveries(ev.id);
    expect(rows.map((d) => d.channel).sort()).toEqual(['in_app', 'sms']);
    expect(rows.find((d) => d.channel === 'sms')).toMatchObject({ address: phone, status: 'queued' });
  });

  it('a transferred patient without a login still gets the SMS', async () => {
    const target = await makeWorld(pool);
    const moved = await makeEntry(pool, target, { state: 'waiting', login: false });
    const phone = phoneOf();
    await setPhone(moved.patientId, phone);
    const ev = await emit({
      eventType: 'QueuePatientTransferred',
      entityType: 'queue_entry',
      entityId: moved.entryId,
      entityVersion: 1,
      sessionId: target.sessionId,
      patientId: moved.patientId,
      payload: { queueVersion: 3 },
    });
    const r = await dispatchOutboxBatch(pool);
    expect(r.failed).toEqual([]);
    const rows = await deliveries(ev.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'sms', address: phone, recipient_user_id: null, patient_id: moved.patientId });
  });
});

describe('existing single-recipient events are unchanged', () => {
  it('QueuePatientCalled still yields one in-app notification with the old wording, info severity and no outbound delivery', async () => {
    const w = await makeWorld(pool);
    const e = await makeEntry(pool, w, { login: true });
    await setPhone(e.patientId, phoneOf());
    const ev = await emit({
      eventType: 'QueuePatientCalled',
      entityType: 'queue_entry',
      entityId: e.entryId,
      entityVersion: 2,
      sessionId: w.sessionId,
      patientId: e.patientId,
      payload: { queueVersion: 7, token: e.token },
    });
    await dispatchOutboxBatch(pool);
    const n = await noteFor(ev.id, e.userId!);
    expect(n.body).toBe(`Your token ${e.token} has been called. Please go to ${w.room}.`);
    expect(n).toMatchObject({ severity: 'info', link: null });
    expect((await deliveries(ev.id)).map((d) => d.channel)).toEqual(['in_app']); // logged, never SMS
  });

  it('a poisoned fan-out event does not block the others in the batch', async () => {
    const sc = await scene();
    const bad = await emit({
      eventType: 'SessionPaused',
      entityType: 'session',
      entityId: randomUUID(), // no such session: renders nothing, must not throw or stall
      payload: { queueVersion: 1, status: 'paused', pauseUntil: null, update: false, doctorId: sc.w.doctorId },
    });
    const good = await sessionEvent(sc, 'SessionResumed');
    const r = await dispatchOutboxBatch(pool);
    expect(r.failed).toEqual([]);
    expect(await noteFor(good.id, sc.cin.userId)).toBeDefined();
    expect((await pool.query(`SELECT dispatched_at FROM outbox_events WHERE id = $1`, [bad.id])).rows[0].dispatched_at).not.toBeNull();
  });
});
