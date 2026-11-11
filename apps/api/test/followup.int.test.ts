/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, Appointment, FollowUpTask } from '@hqms/contracts';
import { capacityInvariant } from '@hqms/db';
import {
  type Client,
  capacityOf,
  count,
  createTestApp,
  doctorId,
  linkPatient,
  loginAs,
  makeSession,
  newPatient,
  newLoginPatient,
  patientId,
  type TestApp,
} from './helpers.js';

let t: TestApp;
let admin: Client;
let reception: Client;
let doctor1: Client;
let doctor2: Client;
let followup: Client; // doctors 1-10
let followup2: Client; // doctors 1-4
let followup3: Client; // doctors 5-8
let patient1: Client;
let patient2: Client;
let P1: string; // isolated patients with logins (the seeded ones are shared across test files)

beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  doctor1 = await loginAs(t.server, 'doctor@hqms.test');
  doctor2 = await loginAs(t.server, 'doctor2@hqms.test');
  followup = await loginAs(t.server, 'followup@hqms.test');
  followup2 = await loginAs(t.server, 'followup2@hqms.test');
  followup3 = await loginAs(t.server, 'followup3@hqms.test');
  const a = await newLoginPatient(t, reception, 'Follow Up One');
  const b = await newLoginPatient(t, reception, 'Follow Up Two');
  patient1 = a.client;
  P1 = a.id;
  patient2 = b.client;
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => t.clock.reset());

const code = (body: unknown): string => ApiError.parse(body).error.code;
const inHours = (h: number): string => new Date(t.clock.now().getTime() + h * 3_600_000).toISOString();

/** A patient linked to doctor 1 (by an appointment) and a task for them created by doctor 1. */
async function taskFor(
  patient: string,
  extra: Record<string, unknown> = {},
  by: Client = doctor1,
): Promise<FollowUpTask> {
  const res = await by.post('/follow-up-tasks', {
    patientId: patient,
    title: 'Call about wound care',
    detail: 'Check dressing, ask about fever',
    dueAt: inHours(24),
    ...extra,
  });
  expect(res.status).toBe(201);
  return FollowUpTask.parse(res.body);
}

describe('FR-11 follow-up tasks: create, scope, ownership', () => {
  it('a doctor creates a task for their patient: audit, FollowUpOpened without clinical text, owner validated', async () => {
    const p = await newPatient(reception, 'Follow Up Patient');
    await linkPatient(admin, reception, p, 1);
    const task = await taskFor(p, { ownerId: undefined });
    expect(task).toMatchObject({ status: 'open', ownerId: null, kind: 'post_visit', overdue: false, version: 1 });
    expect(await count(t.pool, `SELECT 1 FROM audit_events WHERE operation = 'follow_up.create' AND entity_id = $1`, [task.id])).toBe(1);
    const ev = await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'FollowUpOpened' AND entity_id = $1`, [task.id]);
    expect(ev.rows).toHaveLength(1);
    expect(JSON.stringify(ev.rows[0]!.payload)).not.toMatch(/wound|dressing|fever/);

    const owned = await taskFor(p, { ownerId: (await followup2.get('/me')).body.userId });
    expect(owned.ownerName).toBeTruthy();
  });

  it('refuses an owner who is not assigned to the patient doctor, an escalation kind, and out-of-scope patients', async () => {
    const p = await newPatient(reception, 'Follow Up Patient');
    await linkPatient(admin, reception, p, 1);
    const f3 = (await followup3.get('/me')).body.userId as string; // doctors 5-8 only
    const badOwner = await doctor1.post('/follow-up-tasks', { patientId: p, title: 'Call patient', dueAt: inHours(5), ownerId: f3 });
    expect(badOwner.status).toBe(400);
    const kind = await doctor1.post('/follow-up-tasks', { patientId: p, title: 'Call patient', dueAt: inHours(5), kind: 'assistant_escalation' });
    expect(kind.status).toBe(400);
    // Doctor 2 does not care for this patient: 404, as for a patient asking about someone else's record.
    const outside = await doctor2.post('/follow-up-tasks', { patientId: p, title: 'Call patient', dueAt: inHours(5) });
    expect(outside.status).toBe(404);
    expect((await followup3.post('/follow-up-tasks', { patientId: p, title: 'Call patient', dueAt: inHours(5) })).status).toBe(404);
    // Roles
    expect((await reception.post('/follow-up-tasks', { patientId: p, title: 'Call patient', dueAt: inHours(5) })).status).toBe(403);
    expect((await patient1.post('/follow-up-tasks', { patientId: p, title: 'Call patient', dueAt: inHours(5) })).status).toBe(403);
    expect((await followup.post('/follow-up-tasks', { patientId: p, title: 'ab', dueAt: inHours(5) })).status).toBe(400);
  });

  it('Idempotency-Key on create: a replay returns the same task, a changed body is IDEMPOTENCY_KEY_REUSED', async () => {
    const p = await newPatient(reception, 'Follow Up Patient');
    await linkPatient(admin, reception, p, 1);
    const key = randomUUID();
    const body = { patientId: p, title: 'Call about results', dueAt: inHours(48) };
    const a = await doctor1.post('/follow-up-tasks', body, key);
    const b = await doctor1.post('/follow-up-tasks', body, key);
    expect(a.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(b.headers['idempotency-replayed']).toBe('true');
    const c = await doctor1.post('/follow-up-tasks', { ...body, title: 'Something else' }, key);
    expect(c.status).toBe(409);
    expect(code(c.body)).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('lists are scoped: followup sees their doctors patients, others do not; patients use /me/follow-ups without staff notes', async () => {
    const p = P1;
    await linkPatient(admin, reception, p, 1);
    const task = await taskFor(p, { title: 'INTERNAL: check adherence', detail: 'staff-only detail' });
    const mine = await followup.get('/follow-up-tasks?owner=all');
    expect((mine.body as FollowUpTask[]).some((x) => x.id === task.id)).toBe(true);
    const f3 = await followup3.get('/follow-up-tasks?owner=all');
    expect((f3.body as FollowUpTask[]).some((x) => x.id === task.id)).toBe(false);
    expect((await followup3.get(`/follow-up-tasks/${task.id}`)).status).toBe(404);
    expect((await doctor2.get(`/follow-up-tasks/${task.id}`)).status).toBe(404);
    expect((await doctor1.get(`/follow-up-tasks/${task.id}`)).status).toBe(200);
    expect((await patient1.get('/follow-up-tasks')).status).toBe(403);
    expect((await reception.get('/follow-up-tasks')).status).toBe(403);

    const own = await patient1.get('/me/follow-ups');
    expect(own.status).toBe(200);
    const row = (own.body as Array<Record<string, unknown>>).find((x) => x['id'] === task.id)!;
    expect(row).toBeTruthy();
    expect(JSON.stringify(row)).not.toMatch(/INTERNAL|staff-only|ownerName|outcomeNote|detail|title/);
    expect((await patient2.get('/me/follow-ups')).body).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ id: task.id })]),
    );
    expect((await doctor1.get('/me/follow-ups')).status).toBe(403);
  });
});

describe('FR-11 overdue and lifecycle', () => {
  it('FR-11-a: an overdue task stays open and listed until resolved or cancelled', async () => {
    const p = await newPatient(reception, 'Follow Up Patient');
    await linkPatient(admin, reception, p, 1);
    t.clock.set('2041-03-01T06:00:00Z');
    const task = await taskFor(p, { dueAt: '2041-03-01T08:00:00Z' });
    expect(task.overdue).toBe(false);

    t.clock.set('2041-03-03T06:00:00Z'); // two days past due
    const overdue = await doctor1.get(`/follow-up-tasks?owner=all&overdue=true&patientId=${p}`);
    expect((overdue.body as FollowUpTask[]).map((x) => x.id)).toEqual([task.id]);
    expect((overdue.body as FollowUpTask[])[0]).toMatchObject({ status: 'open', overdue: true });
    const notOverdue = await doctor1.get(`/follow-up-tasks?owner=all&overdue=false&patientId=${p}`);
    expect(notOverdue.body).toEqual([]);
    // Nothing closed it: the row in the database is still open.
    expect((await t.pool.query(`SELECT status FROM follow_up_tasks WHERE id = $1`, [task.id])).rows[0]!.status).toBe('open');

    const ack = await followup.post(`/follow-up-tasks/${task.id}/acknowledge`, {});
    expect(ack.body).toMatchObject({ status: 'acknowledged', overdue: true });

    const done = await followup.post(`/follow-up-tasks/${task.id}/resolve`, { disposition: 'advice_given', outcomeNote: 'Rang the patient, advised rest' });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'resolved', disposition: 'advice_given', overdue: false });
    expect((await doctor1.get(`/follow-up-tasks?owner=all&overdue=true&patientId=${p}`)).body).toEqual([]);
    expect((await doctor1.get(`/follow-up-tasks?owner=all&status=resolved&patientId=${p}`)).body).toHaveLength(1);

    // A cancelled one leaves the overdue list too, and the reason is recorded.
    const second = await taskFor(p, { dueAt: '2041-03-01T09:00:00Z' });
    expect((await doctor1.get(`/follow-up-tasks?owner=all&overdue=true&patientId=${p}`)).body).toHaveLength(1);
    const cancelled = await doctor1.post(`/follow-up-tasks/${second.id}/cancel`, { reason: 'Duplicate of an earlier task' });
    expect(cancelled.body).toMatchObject({ status: 'cancelled', outcomeNote: 'Duplicate of an earlier task', overdue: false });
    expect((await doctor1.get(`/follow-up-tasks?owner=all&overdue=true&patientId=${p}`)).body).toEqual([]);
  });

  it('FR-11-b: acknowledging takes ownership of an unowned task; a second acknowledge or a stale version is a 409', async () => {
    const p = await newPatient(reception, 'Follow Up Patient');
    await linkPatient(admin, reception, p, 1);
    const task = await taskFor(p);
    const unassigned = await followup.get(`/follow-up-tasks?owner=unassigned&patientId=${p}`);
    expect((unassigned.body as FollowUpTask[]).map((x) => x.id)).toContain(task.id);

    const stale = await followup.post(`/follow-up-tasks/${task.id}/acknowledge`, { expectedVersion: 5 });
    expect(stale.status).toBe(409);
    expect(code(stale.body)).toBe('CONFLICT');

    const me = (await followup.get('/me')).body.userId as string;
    const ack = await followup.post(`/follow-up-tasks/${task.id}/acknowledge`, { expectedVersion: 1 });
    expect(ack.status).toBe(200);
    expect(FollowUpTask.parse(ack.body)).toMatchObject({ status: 'acknowledged', ownerId: me, version: 2 });
    expect(ack.body.acknowledgedAt).toBeTruthy();
    expect((await followup.get(`/follow-up-tasks?owner=me&patientId=${p}`)).body).toHaveLength(1);
    expect(await count(t.pool, `SELECT 1 FROM outbox_events WHERE event_type = 'FollowUpAcknowledged' AND entity_id = $1`, [task.id])).toBe(1);
    expect(await count(t.pool, `SELECT 1 FROM audit_events WHERE operation = 'follow_up.acknowledge' AND entity_id = $1`, [task.id])).toBe(1);

    const again = await followup.post(`/follow-up-tasks/${task.id}/acknowledge`, {});
    expect(again.status).toBe(409);
    expect(code(again.body)).toBe('INVALID_TRANSITION');
    // Owned by followup: followup2 (same doctors) may not take it over.
    const other = await followup2.post(`/follow-up-tasks/${task.id}/acknowledge`, {});
    expect(other.status).toBe(409); // already acknowledged: transition check comes first
  });

  it('a task owned by someone else cannot be acknowledged by another staff member while open', async () => {
    const p = await newPatient(reception, 'Follow Up Patient');
    await linkPatient(admin, reception, p, 1);
    const f1 = (await followup.get('/me')).body.userId as string;
    const task = await taskFor(p, { ownerId: f1 });
    expect((await followup2.post(`/follow-up-tasks/${task.id}/acknowledge`, {})).status).toBe(403);
    expect((await followup.post(`/follow-up-tasks/${task.id}/acknowledge`, {})).status).toBe(200);
  });

  it('resolve needs a disposition and note; closed tasks cannot be resolved or cancelled again', async () => {
    const p = await newPatient(reception, 'Follow Up Patient');
    await linkPatient(admin, reception, p, 1);
    const task = await taskFor(p);
    expect((await followup.post(`/follow-up-tasks/${task.id}/resolve`, { outcomeNote: 'done and dusted' })).status).toBe(400);
    expect((await followup.post(`/follow-up-tasks/${task.id}/resolve`, { disposition: 'referred', outcomeNote: 'x' })).status).toBe(400);
    // return_booked without an appointment, and an appointment with another disposition
    const noAppt = await followup.post(`/follow-up-tasks/${task.id}/resolve`, { disposition: 'return_booked', outcomeNote: 'Booked a return' });
    expect(noAppt.status).toBe(400);
    const wrongDisp = await followup.post(`/follow-up-tasks/${task.id}/resolve`, { disposition: 'advice_given', outcomeNote: 'Gave advice', returnAppointmentId: randomUUID() });
    expect(wrongDisp.status).toBe(400);
    // An appointment that was NOT booked from this task cannot be claimed as the return
    const other = await linkPatient(admin, reception, p, 1);
    const notLinked = await followup.post(`/follow-up-tasks/${task.id}/resolve`, { disposition: 'return_booked', outcomeNote: 'Booked a return', returnAppointmentId: other.appointmentId });
    expect(notLinked.status).toBe(400);
    expect((await t.pool.query(`SELECT status FROM follow_up_tasks WHERE id = $1`, [task.id])).rows[0]!.status).toBe('open');

    const ok = await followup.post(`/follow-up-tasks/${task.id}/resolve`, { disposition: 'no_action_needed', outcomeNote: 'Patient is well' });
    expect(ok.status).toBe(200);
    expect(ok.body.ownerId).toBeTruthy(); // a closed task always names who closed it
    expect(await count(t.pool, `SELECT 1 FROM outbox_events WHERE event_type = 'FollowUpResolved' AND entity_id = $1`, [task.id])).toBe(1);
    const again = await followup.post(`/follow-up-tasks/${task.id}/resolve`, { disposition: 'no_action_needed', outcomeNote: 'Again' });
    expect(code(again.body)).toBe('INVALID_TRANSITION');
    expect((await followup.post(`/follow-up-tasks/${task.id}/cancel`, { reason: 'too late now' })).status).toBe(409);
  });
});

describe('FR-14-c return booking through normal capacity', () => {
  async function openTask(p: string): Promise<FollowUpTask> {
    await linkPatient(admin, reception, p, 1);
    return taskFor(p, { kind: 'return_visit', title: 'Arrange a review visit' });
  }

  it('books via the normal path, links both ways, consumes ordinary capacity and resolves as return_booked', async () => {
    const p = await newPatient(reception, 'Follow Up Patient');
    const task = await openTask(p);
    const target = await makeSession(admin, { doctor: 1, booked: 3, walkin: 1 });
    const before = await capacityOf(t.pool, target.id);

    const res = await followup.post(`/follow-up-tasks/${task.id}/return-booking`, { sessionId: target.id });
    expect(res.status).toBe(201);
    const appt = Appointment.parse(res.body);
    expect(appt).toMatchObject({ patientId: p, sessionId: target.id, followUpTaskId: task.id, status: 'booked' });
    const after = await capacityOf(t.pool, target.id);
    expect(after.booked_reserved).toBe(before.booked_reserved + 1);
    expect(after.walkin_used).toBe(before.walkin_used);
    expect((await capacityInvariant(t.pool, target.id)).ok).toBe(true);

    const linked = await followup.get(`/follow-up-tasks/${task.id}`);
    expect(linked.body.returnAppointmentId).toBe(appt.id);
    expect(await count(t.pool, `SELECT 1 FROM outbox_events WHERE event_type = 'ReturnAppointmentBooked' AND entity_id = $1`, [appt.id])).toBe(1);
    expect(await count(t.pool, `SELECT 1 FROM outbox_events WHERE event_type = 'AppointmentBooked' AND entity_id = $1`, [appt.id])).toBe(1);
    expect(await count(t.pool, `SELECT 1 FROM audit_events WHERE operation = 'follow_up.return_booking' AND entity_id = $1`, [task.id])).toBe(1);
    // The patient sees the appointment as an ordinary one (staff notes stay off it).
    expect(await count(t.pool, `SELECT 1 FROM jobs WHERE dedupe_key = $1`, [`reservation_release:${appt.id}`])).toBe(1);

    // A second booking for the same task while the first is active is refused (no double places).
    const dup = await followup.post(`/follow-up-tasks/${task.id}/return-booking`, { sessionId: (await makeSession(admin, { doctor: 1 })).id });
    expect(dup.status).toBe(409);

    const resolved = await followup.post(`/follow-up-tasks/${task.id}/resolve`, {
      disposition: 'return_booked',
      outcomeNote: 'Return visit booked for review',
      returnAppointmentId: appt.id,
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ status: 'resolved', disposition: 'return_booked', returnAppointmentId: appt.id });
    // Once resolved, further return bookings are refused.
    expect((await followup.post(`/follow-up-tasks/${task.id}/return-booking`, { sessionId: target.id })).status).toBe(409);
  });

  it('a full session answers CAPACITY_FULL: no bypass, no extra place, no link', async () => {
    const p = await newPatient(reception, 'Follow Up Patient');
    const task = await openTask(p);
    const full = await makeSession(admin, { doctor: 1, booked: 1, walkin: 1 });
    expect((await reception.post('/appointments', { sessionId: full.id, patientId: patientId(21) })).status).toBe(201);
    const before = await capacityOf(t.pool, full.id);

    const res = await followup.post(`/follow-up-tasks/${task.id}/return-booking`, { sessionId: full.id });
    expect(res.status).toBe(409);
    expect(code(res.body)).toBe('CAPACITY_FULL');
    expect(await capacityOf(t.pool, full.id)).toEqual(before);
    expect(await count(t.pool, `SELECT 1 FROM appointments WHERE follow_up_task_id = $1`, [task.id])).toBe(0);
    expect((await followup.get(`/follow-up-tasks/${task.id}`)).body.returnAppointmentId).toBeNull();
    // Doctors cannot bypass either.
    expect(code((await doctor1.post(`/follow-up-tasks/${task.id}/return-booking`, { sessionId: full.id })).body)).toBe('CAPACITY_FULL');
    // Admin too: same capacity guard.
    expect(code((await admin.post(`/follow-up-tasks/${task.id}/return-booking`, { sessionId: full.id })).body)).toBe('CAPACITY_FULL');
  });

  it('requires an Idempotency-Key, replays safely, and respects scope and roles', async () => {
    const p = await newPatient(reception, 'Follow Up Patient');
    const task = await openTask(p);
    const s = await makeSession(admin, { doctor: 1 });
    expect((await followup.post(`/follow-up-tasks/${task.id}/return-booking`, { sessionId: s.id }, null)).status).toBe(400);
    const key = randomUUID();
    const a = await followup.post(`/follow-up-tasks/${task.id}/return-booking`, { sessionId: s.id }, key);
    const b = await followup.post(`/follow-up-tasks/${task.id}/return-booking`, { sessionId: s.id }, key);
    expect(a.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(await count(t.pool, `SELECT 1 FROM appointments WHERE follow_up_task_id = $1`, [task.id])).toBe(1);

    const p2 = await newPatient(reception, 'Follow Up Patient');
    const task2 = await openTask(p2);
    const s2 = await makeSession(admin, { doctor: 1 });
    expect((await reception.post(`/follow-up-tasks/${task2.id}/return-booking`, { sessionId: s2.id })).status).toBe(403);
    expect((await patient1.post(`/follow-up-tasks/${task2.id}/return-booking`, { sessionId: s2.id })).status).toBe(403);
    expect((await followup3.post(`/follow-up-tasks/${task2.id}/return-booking`, { sessionId: s2.id })).status).toBe(404);
    // followup2 handles doctors 1-4 but not doctor 5's sessions
    const s5 = await makeSession(admin, { doctor: 5 });
    expect((await followup2.post(`/follow-up-tasks/${task2.id}/return-booking`, { sessionId: s5.id })).status).toBe(403);
    expect((await followup.post(`/follow-up-tasks/${randomUUID()}/return-booking`, { sessionId: s2.id })).status).toBe(404);
  });

  it('POST /appointments with followUpTaskId: followup books with the same semantics; reception cannot; followup needs the task', async () => {
    const p = await newPatient(reception, 'Follow Up Patient');
    const task = await openTask(p);
    const s = await makeSession(admin, { doctor: 1 });
    const viaAppointments = await followup.post('/appointments', { sessionId: s.id, followUpTaskId: task.id });
    expect(viaAppointments.status).toBe(201);
    expect(viaAppointments.body).toMatchObject({ patientId: p, followUpTaskId: task.id });
    expect((await followup.get(`/follow-up-tasks/${task.id}`)).body.returnAppointmentId).toBe(viaAppointments.body.id);

    const task2 = await openTask(await newPatient(reception, 'Follow Up Patient'));
    expect((await reception.post('/appointments', { sessionId: s.id, patientId: patientId(25), followUpTaskId: task2.id })).status).toBe(403);
    expect((await followup.post('/appointments', { sessionId: s.id, patientId: patientId(25) })).status).toBe(403);
    // patientId that disagrees with the task
    const mismatch = await followup.post('/appointments', { sessionId: s.id, followUpTaskId: task2.id, patientId: patientId(26) });
    expect(mismatch.status).toBe(400);
    // The one-active-appointment rule still applies: p already has an active appointment in s
    const task3 = await taskFor(p, { kind: 'return_visit', title: 'Another review' });
    expect((await followup.post(`/follow-up-tasks/${task3.id}/return-booking`, { sessionId: s.id })).status).toBe(409);
    expect(doctorId(1)).toBeTruthy();
  });
});
