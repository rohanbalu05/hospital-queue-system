/**
 * T4 (report Table 5, FR-11, FR-14): owned follow-up tasks and the linked return booking, black box.
 *
 *  1. an overdue task stays open and listed until a documented disposition (FR-11);
 *  2. acknowledging takes ownership; a task owned by someone else cannot be acknowledged by another staff member;
 *  3. a return booking uses normal capacity: a full session answers 409 CAPACITY_FULL (nothing booked, nothing
 *     linked); a session with room consumes exactly one place and links appointment <-> task both ways;
 *  4. resolving with `return_booked` needs the linked appointment and a note; wrong or missing input is refused.
 *
 * Real HTTP against the built API and a real PostgreSQL. No worker is needed (no document job is involved).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newKey, type ApiClient } from '../support/client.js';
import { futureIso, waitFor } from '../support/followup.js';
import { recordResult, T4_RESULTS_FILE } from '../support/results.js';
import {
  book,
  capacityCounts,
  checkGlobalInvariants,
  closePool,
  doctorId,
  loginAs,
  makeFutureSession,
  seededPatientId,
  sqlRows,
} from '../support/world.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

let admin: ApiClient;
let reception: ApiClient;
let doctor: ApiClient;
let followup1: ApiClient; // scope: all doctors
let followup2: ApiClient; // scope: doctors 1..4
let patient3: ApiClient;
let followup1Id: string;
let followup2Id: string;
const P3 = seededPatientId(3);
const P4 = seededPatientId(4);
const record: Record<string, unknown> = {};

const taskBody = (patientId: string, extra: Record<string, unknown> = {}) => ({
  patientId,
  kind: 'post_visit',
  title: 'Call back about the fever plan',
  dueAt: futureIso(24),
  ...extra,
});

async function createTask(client: ApiClient, patientId: string, extra: Record<string, unknown> = {}): Promise<any> {
  const res = await client.post('/follow-up-tasks', taskBody(patientId, extra));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

beforeAll(async () => {
  [admin, reception, doctor, followup1, followup2, patient3] = await Promise.all([
    loginAs('admin@hqms.test'),
    loginAs('reception@hqms.test'),
    loginAs('doctor@hqms.test'),
    loginAs('followup@hqms.test'),
    loginAs('followup2@hqms.test'),
    loginAs('patient3@hqms.test'),
  ]);
  followup1Id = (await followup1.get('/me')).body.userId;
  followup2Id = (await followup2.get('/me')).body.userId;
  expect(followup1Id).toBeTruthy();
  expect(followup2Id).toBeTruthy();
}, 120_000);

afterAll(async () => {
  const invariants = await checkGlobalInvariants();
  recordResult('t4FollowUpTasks', { ...record, globalInvariantViolations: invariants.violations }, T4_RESULTS_FILE);
  await closePool();
});

describe('T4.6 overdue tasks stay open and visible (FR-11)', () => {
  it('a task due in the past is created open, overdue and listed, and is not closed by the passage of time', async () => {
    const t = await createTask(followup1, P3, { title: 'Overdue call back', dueAt: futureIso(-2) });
    expect(t.status).toBe('open');
    expect(t.overdue).toBe(true);
    // D-028: a task always has an owner; a follow-up user who creates one without naming an owner owns it.
    expect(t.ownerId).toBe(followup1Id);

    const all = await followup1.get('/follow-up-tasks?owner=all&overdue=true');
    expect(all.status).toBe(200);
    expect((all.body as any[]).map((x) => x.id)).toContain(t.id);
    const notOverdue = await followup1.get('/follow-up-tasks?owner=all&overdue=false');
    expect((notOverdue.body as any[]).map((x) => x.id)).not.toContain(t.id);
    const mine = await followup1.get('/follow-up-tasks?owner=me&status=open&overdue=true');
    expect((mine.body as any[]).map((x) => x.id)).toContain(t.id);
    const unassigned = await followup1.get('/follow-up-tasks?owner=unassigned&status=open');
    expect(
      (unassigned.body as any[]).map((x) => x.id),
      'an owned task is not in the unassigned list',
    ).not.toContain(t.id);

    // The doctor of the patient sees it too (their scope); reception and the patient do not.
    expect(((await doctor.get('/follow-up-tasks?owner=all')).body as any[]).map((x) => x.id)).toContain(t.id);
    expect((await reception.get('/follow-up-tasks?owner=all')).status).toBe(403);
    expect((await patient3.get('/follow-up-tasks?owner=all')).status).toBe(403);
    record['overdueCreatedPastDue'] = { status: t.status, overdue: t.overdue };
  });

  it('a task that becomes overdue while we watch flips overdue=true but stays open and listed', async () => {
    const t = await createTask(followup1, P3, {
      title: 'Becomes overdue',
      dueAt: new Date(Date.now() + 2500).toISOString(),
    });
    expect(t.overdue).toBe(false);
    const flipped = await waitFor(
      'task to become overdue',
      async () => {
        const g = await followup1.get(`/follow-up-tasks/${t.id}`);
        return g.body.overdue === true ? g.body : null;
      },
      10_000,
      250,
    );
    expect(flipped.status).toBe('open');
    expect(flipped.resolvedAt).toBeNull();
    const list = await followup1.get('/follow-up-tasks?owner=all&overdue=true&status=open');
    expect((list.body as any[]).map((x) => x.id)).toContain(t.id);
    record['overdueFlippedWhileWatching'] = { status: flipped.status, overdue: flipped.overdue };
  });

  it('closes only through a documented disposition or a documented cancellation', async () => {
    const t = await createTask(followup1, P3, { title: 'Needs a disposition', dueAt: futureIso(-1) });
    // no note / no reason -> refused
    expect(
      (await followup1.post(`/follow-up-tasks/${t.id}/resolve`, { disposition: 'advice_given', outcomeNote: '' }))
        .status,
    ).toBe(400);
    expect(
      (await followup1.post(`/follow-up-tasks/${t.id}/resolve`, { disposition: 'nonsense', outcomeNote: 'ok ok' }))
        .status,
    ).toBe(400);
    expect((await followup1.post(`/follow-up-tasks/${t.id}/cancel`, { reason: '' })).status).toBe(400);
    expect((await followup1.get(`/follow-up-tasks/${t.id}`)).body.status).toBe('open');

    const done = await followup1.post(`/follow-up-tasks/${t.id}/resolve`, {
      disposition: 'advice_given',
      outcomeNote: 'Phoned the patient; fever settling.',
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.status).toBe('resolved');
    expect(done.body.disposition).toBe('advice_given');
    expect(done.body.outcomeNote).toContain('fever settling');
    expect(done.body.resolvedAt).toBeTruthy();
    expect(done.body.ownerId, 'the resolver becomes the owner when nobody owned it').toBe(followup1Id);
    expect(done.body.overdue, 'a resolved task is no longer overdue').toBe(false);
    // closed tasks cannot be reopened or re-resolved
    const again = await followup1.post(`/follow-up-tasks/${t.id}/resolve`, {
      disposition: 'no_action_needed',
      outcomeNote: 'again',
    });
    expect(again.status).toBe(409);

    const c = await createTask(followup1, P3, { title: 'To be cancelled', dueAt: futureIso(-1) });
    const cancelled = await followup1.post(`/follow-up-tasks/${c.id}/cancel`, {
      reason: 'Patient already seen in clinic',
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect(cancelled.body.outcomeNote).toBe('Patient already seen in clinic');
    const audit = await sqlRows(`SELECT operation, reason FROM audit_events WHERE entity_id = $1 ORDER BY id`, [c.id]);
    expect(audit.map((a) => a['operation'])).toEqual(['follow_up.create', 'follow_up.cancel']);
    expect(audit[1]?.['reason']).toBe('Patient already seen in clinic');
  });
});

describe('T4.7 acknowledging takes ownership (FR-11)', () => {
  it('a task created without an owner always gets one (D-028): the creating follow-up user, or a default owner for a doctor', async () => {
    const own = await createTask(followup2, P3, { title: 'Created by follow-up user 2' });
    expect(own.ownerId).toBe(followup2Id);
    const byDoctor = await createTask(doctor, P3, { title: 'Created by the doctor, no owner named' });
    expect(byDoctor.ownerId, 'doctor-created task gets a default owner').toBeTruthy();
    expect([followup1Id, followup2Id]).toContain(byDoctor.ownerId);
    const detail = await followup1.get(`/follow-up-tasks/${byDoctor.id}`);
    expect(detail.body.ownerId).toBe(byDoctor.ownerId);
    const unassigned = await followup1.get('/follow-up-tasks?owner=unassigned&status=open');
    const ids = (unassigned.body as any[]).map((x) => x.id);
    expect(ids).not.toContain(own.id);
    expect(ids).not.toContain(byDoctor.id);
    const audit = await sqlRows(`SELECT operation, actor_role FROM audit_events WHERE entity_id = $1 ORDER BY id`, [
      byDoctor.id,
    ]);
    expect(audit.map((a) => a['operation'])).toEqual(['follow_up.create']);
    record['defaultOwner'] = { followUpCreator: 'self', doctorCreator: 'assigned follow-up user' };
  });

  it('a task left without an owner (cleared in the database) is acknowledged by the caller, who becomes its owner', async () => {
    const created = await createTask(followup2, P3, { title: 'Unowned task to acknowledge' });
    // The API no longer produces an unowned task; clear the owner directly to exercise the documented
    // "unowned -> the caller takes it" rule of acknowledge.
    await sqlRows(`UPDATE follow_up_tasks SET owner_id = NULL WHERE id = $1`, [created.id]);
    const t = (await followup2.get(`/follow-up-tasks/${created.id}`)).body;
    expect(t.ownerId).toBeNull();
    const unassigned = await followup1.get('/follow-up-tasks?owner=unassigned&status=open');
    expect((unassigned.body as any[]).map((x) => x.id)).toContain(t.id);
    const stale = await followup2.post(`/follow-up-tasks/${t.id}/acknowledge`, { expectedVersion: t.version + 5 });
    expect(stale.status).toBe(409);
    const ack = await followup2.post(`/follow-up-tasks/${t.id}/acknowledge`, { expectedVersion: t.version });
    expect(ack.status, JSON.stringify(ack.body)).toBe(200);
    expect(ack.body.status).toBe('acknowledged');
    expect(ack.body.ownerId).toBe(followup2Id);
    expect(ack.body.acknowledgedAt).toBeTruthy();
    expect(ack.body.version).toBe(t.version + 1);
    // it is now "mine" for followup2 and not for followup1
    const mine = await followup2.get('/follow-up-tasks?owner=me&status=acknowledged');
    expect((mine.body as any[]).map((x) => x.id)).toContain(t.id);
    const theirs = await followup1.get('/follow-up-tasks?owner=me');
    expect((theirs.body as any[]).map((x) => x.id)).not.toContain(t.id);
    // acknowledging twice is an invalid transition, not a silent success
    expect((await followup2.post(`/follow-up-tasks/${t.id}/acknowledge`, {})).status).toBe(409);
    const audit = await sqlRows(`SELECT actor_id, operation FROM audit_events WHERE entity_id = $1 ORDER BY id`, [
      t.id,
    ]);
    expect(audit.map((a) => a['operation'])).toEqual(['follow_up.create', 'follow_up.acknowledge']);
    expect(audit[1]?.['actor_id']).toBe(followup2Id);
    record['acknowledge'] = { ownerAfter: 'caller', status: ack.body.status };
  });

  it('resolve and cancel need the owner (or admin); an unowned task is taken by the caller (D-028)', async () => {
    const t = await createTask(followup1, P3, { title: 'Owned by follow-up user 1', ownerId: followup1Id });
    const denyResolve = await followup2.post(`/follow-up-tasks/${t.id}/resolve`, {
      disposition: 'advice_given',
      outcomeNote: 'not my task',
    });
    expect(denyResolve.status).toBe(403);
    const denyCancel = await followup2.post(`/follow-up-tasks/${t.id}/cancel`, { reason: 'not my task' });
    expect(denyCancel.status).toBe(403);
    const after = (await followup1.get(`/follow-up-tasks/${t.id}`)).body;
    expect(after.status).toBe('open');
    expect(after.ownerId).toBe(followup1Id);
    // the audit trail has no resolve/cancel row for the refused attempts
    const audit = await sqlRows(`SELECT operation FROM audit_events WHERE entity_id = $1 ORDER BY id`, [t.id]);
    expect(audit.map((a) => a['operation'])).toEqual(['follow_up.create']);
    // admin may act on any task, and the owner stays the owner
    const byAdmin = await admin.post(`/follow-up-tasks/${t.id}/cancel`, { reason: 'Admin closed a duplicate task' });
    expect(byAdmin.status, JSON.stringify(byAdmin.body)).toBe(200);
    expect(byAdmin.body.status).toBe('cancelled');
    expect(byAdmin.body.ownerId).toBe(followup1Id);

    // unowned (cleared in the database): the caller who resolves it takes it
    const u = await createTask(followup1, P3, { title: 'Unowned, resolved by follow-up user 2' });
    await sqlRows(`UPDATE follow_up_tasks SET owner_id = NULL WHERE id = $1`, [u.id]);
    const takes = await followup2.post(`/follow-up-tasks/${u.id}/resolve`, {
      disposition: 'no_action_needed',
      outcomeNote: 'Nothing further needed.',
    });
    expect(takes.status, JSON.stringify(takes.body)).toBe(200);
    expect(takes.body.ownerId).toBe(followup2Id);
    record['resolveCancelOwnerRule'] = { nonOwnerStatus: denyResolve.status, adminStatus: byAdmin.status };
  });

  it('a task owned by someone else cannot be taken over by another follow-up user; its owner can acknowledge it', async () => {
    const t = await createTask(followup2, P3, { title: 'Owned by follow-up user 1', ownerId: followup1Id });
    expect(t.ownerId).toBe(followup1Id);
    const denied = await followup2.post(`/follow-up-tasks/${t.id}/acknowledge`, {});
    expect(denied.status).toBe(403);
    expect((await followup1.get(`/follow-up-tasks/${t.id}`)).body.status).toBe('open');
    const ok = await followup1.post(`/follow-up-tasks/${t.id}/acknowledge`, {});
    expect(ok.status).toBe(200);
    expect(ok.body.ownerId).toBe(followup1Id);
    // an owner who is not a follow-up user of the patient's doctor is refused at creation
    const bad = await followup2.post(
      '/follow-up-tasks',
      taskBody(P3, { ownerId: (await reception.get('/me')).body.userId }),
    );
    expect(bad.status).toBe(400);
  });
});

describe('T4.8 return booking uses normal capacity and links both ways (FR-14)', () => {
  let task: any;
  let fullSession: { id: string };
  let freeSession: { id: string };
  let returnAppt: any;
  const key = newKey();

  it('a return booking into a FULL session is 409 CAPACITY_FULL: nothing booked, nothing linked', async () => {
    task = await createTask(followup1, P3, {
      title: 'Book a return visit',
      kind: 'return_visit',
      ownerId: followup1Id,
    });
    fullSession = await makeFutureSession(admin, { doctor: 1, booked: 1, walkin: 0 });
    const filler = await book(reception, fullSession.id, P4);
    expect(filler.status, JSON.stringify(filler.body)).toBe(201);
    const before = await capacityCounts(fullSession.id);
    expect(before.booked_reserved).toBe(before.booked_capacity);

    const res = await followup1.post(`/follow-up-tasks/${task.id}/return-booking`, { sessionId: fullSession.id });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CAPACITY_FULL');
    expect(await capacityCounts(fullSession.id)).toEqual(before);
    const links = await sqlRows(`SELECT count(*)::int AS n FROM appointments WHERE follow_up_task_id = $1`, [task.id]);
    expect(links[0]?.['n']).toBe(0);
    expect((await followup1.get(`/follow-up-tasks/${task.id}`)).body.returnAppointmentId).toBeNull();
    // the rest of the capacity row is intact: no extra place was created for a return visit
    expect((await capacityCounts(fullSession.id)).booked_allocations).toBe(1);
    record['returnIntoFullSession'] = { status: res.status, code: res.body.error.code };
  });

  it('only staff with the doctor in scope can book a return (patient, reception, out-of-scope follow-up refused)', async () => {
    freeSession = await makeFutureSession(admin, { doctor: 1, booked: 3, walkin: 1 });
    expect(
      (await patient3.post(`/follow-up-tasks/${task.id}/return-booking`, { sessionId: freeSession.id })).status,
    ).toBe(403);
    expect(
      (await reception.post(`/follow-up-tasks/${task.id}/return-booking`, { sessionId: freeSession.id })).status,
    ).toBe(403);
    const otherDoctorSession = await makeFutureSession(admin, { doctor: 5 });
    const outOfScope = await followup2.post(`/follow-up-tasks/${task.id}/return-booking`, {
      sessionId: otherDoctorSession.id,
    });
    expect([403, 404]).toContain(outOfScope.status);
    const noKey = await followup1.request('POST', `/follow-up-tasks/${task.id}/return-booking`, {
      body: { sessionId: freeSession.id },
      key: null,
    });
    expect(noKey.status, 'Idempotency-Key is required').toBe(400);
    expect((await capacityCounts(freeSession.id)).booked_reserved).toBe(0);
    expect((await capacityCounts(otherDoctorSession.id)).booked_reserved).toBe(0);
  });

  it('a session with room: exactly one place consumed, appointment and task linked both ways, replay is idempotent', async () => {
    const before = await capacityCounts(freeSession.id);
    const res = await followup1.post(`/follow-up-tasks/${task.id}/return-booking`, { sessionId: freeSession.id }, key);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    returnAppt = res.body;
    expect(returnAppt.status).toBe('booked');
    expect(returnAppt.patientId).toBe(P3);
    expect(returnAppt.followUpTaskId).toBe(task.id);
    expect(returnAppt.sessionId).toBe(freeSession.id);
    expect(returnAppt.doctorId).toBe(doctorId(1));

    const after = await capacityCounts(freeSession.id);
    expect(after.booked_reserved).toBe(before.booked_reserved + 1);
    expect(after.booked_allocations).toBe(before.booked_allocations + 1);
    expect(after.walkin_used).toBe(before.walkin_used);

    const t = await followup1.get(`/follow-up-tasks/${task.id}`);
    expect(t.body.returnAppointmentId).toBe(returnAppt.id);
    const rows = await sqlRows(
      `SELECT a.follow_up_task_id, a.allocation_id, al.state, al.kind FROM appointments a
         JOIN capacity_allocations al ON al.id = a.allocation_id WHERE a.id = $1`,
      [returnAppt.id],
    );
    expect(rows[0]?.['follow_up_task_id']).toBe(task.id);
    expect(rows[0]?.['state']).toBe('reserved');
    expect(rows[0]?.['kind']).toBe('booked');

    // the same Idempotency-Key replays the stored response and books nothing more
    const replay = await followup1.post(
      `/follow-up-tasks/${task.id}/return-booking`,
      { sessionId: freeSession.id },
      key,
    );
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(returnAppt.id);
    // a different key for the same task is a conflict, not a second appointment
    const second = await followup1.post(`/follow-up-tasks/${task.id}/return-booking`, { sessionId: freeSession.id });
    expect(second.status).toBe(409);
    expect((await capacityCounts(freeSession.id)).booked_reserved).toBe(before.booked_reserved + 1);

    // the patient sees the return appointment in their own list
    const mine = await patient3.get('/appointments');
    expect(mine.status).toBe(200);
    const list = Array.isArray(mine.body) ? mine.body : mine.body.items;
    expect((list as any[]).some((a) => a.id === returnAppt.id)).toBe(true);
    record['returnBooking'] = { bookedReservedDelta: 1, linkedBothWays: true, replayIdempotent: true };
  });

  it('resolves return_booked only with the linked appointment and a note; then the task is closed with both links', async () => {
    // missing appointment id, missing note, an appointment that does not belong to this task
    expect(
      (
        await followup1.post(`/follow-up-tasks/${task.id}/resolve`, {
          disposition: 'return_booked',
          outcomeNote: 'Booked a return visit',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await followup1.post(`/follow-up-tasks/${task.id}/resolve`, {
          disposition: 'return_booked',
          returnAppointmentId: returnAppt.id,
          outcomeNote: '',
        })
      ).status,
    ).toBe(400);
    const foreign = await book(reception, freeSession.id, P4);
    expect(foreign.status).toBe(201);
    expect(
      (
        await followup1.post(`/follow-up-tasks/${task.id}/resolve`, {
          disposition: 'return_booked',
          returnAppointmentId: foreign.body.id,
          outcomeNote: 'wrong appointment',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await followup1.post(`/follow-up-tasks/${task.id}/resolve`, {
          disposition: 'advice_given',
          returnAppointmentId: returnAppt.id,
          outcomeNote: 'mismatched disposition',
        })
      ).status,
    ).toBe(400);
    expect((await followup1.get(`/follow-up-tasks/${task.id}`)).body.status).toBe('open');

    const ack = await followup1.post(`/follow-up-tasks/${task.id}/acknowledge`, {});
    expect(ack.status).toBe(200);
    const done = await followup1.post(`/follow-up-tasks/${task.id}/resolve`, {
      disposition: 'return_booked',
      returnAppointmentId: returnAppt.id,
      outcomeNote: 'Return visit booked for the review.',
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.status).toBe('resolved');
    expect(done.body.disposition).toBe('return_booked');
    expect(done.body.returnAppointmentId).toBe(returnAppt.id);
    expect(done.body.ownerId).toBe(followup1Id);

    const link = await sqlRows(
      `SELECT t.return_appointment_id, a.follow_up_task_id, a.status FROM follow_up_tasks t JOIN appointments a ON a.id = t.return_appointment_id WHERE t.id = $1`,
      [task.id],
    );
    expect(link[0]?.['return_appointment_id']).toBe(returnAppt.id);
    expect(link[0]?.['follow_up_task_id']).toBe(task.id);
    expect(link[0]?.['status']).toBe('booked');

    // the patient's view: status, disposition and the return appointment, but no staff text
    const mine = await patient3.get('/me/follow-ups');
    const row = (mine.body as any[]).find((x) => x.id === task.id);
    expect(row.status).toBe('resolved');
    expect(row.returnAppointmentId).toBe(returnAppt.id);
    expect(Object.keys(row)).not.toContain('outcomeNote');
    // a closed task takes no further return booking
    const closed = await followup1.post(`/follow-up-tasks/${task.id}/return-booking`, { sessionId: freeSession.id });
    expect(closed.status).toBe(409);
    record['resolveReturnBooked'] = { status: done.body.status, disposition: done.body.disposition };
  });
});
