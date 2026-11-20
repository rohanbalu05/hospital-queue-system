/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
/* PR-14 / PR-38 / PR-32: patient-visible replies, staff task context (MRN, phone, doctor), urgent ordering, doctor-created tasks. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ArrivalResult, CallNextResult, FollowUpTask, PatientFollowUp } from '@hqms/contracts';
import {
  type Client,
  type TestApp,
  at,
  createTestApp,
  linkPatient,
  loginAs,
  makeSession,
  newLoginPatient,
  newPatient,
} from './helpers.js';

let t: TestApp;
let admin: Client;
let reception: Client;
let doctor1: Client;
let doctor2: Client;
let followup: Client; // doctors 1-10
let F1: string;

beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  doctor1 = await loginAs(t.server, 'doctor@hqms.test');
  doctor2 = await loginAs(t.server, 'doctor2@hqms.test');
  followup = await loginAs(t.server, 'followup@hqms.test');
  F1 = (await followup.get('/me')).body.userId as string;
});
afterAll(() => t.close());
beforeEach(() => t.clock.reset());

const inHours = (h: number): string => new Date(t.clock.now().getTime() + h * 3_600_000).toISOString();

async function taskFor(patient: string, extra: Record<string, unknown> = {}, by: Client = doctor1): Promise<FollowUpTask> {
  const res = await by.post('/follow-up-tasks', {
    patientId: patient,
    title: 'Call about wound care',
    dueAt: inHours(24),
    ownerId: F1,
    ...extra,
  });
  expect(res.status).toBe(201);
  return FollowUpTask.parse(res.body);
}

describe('PR-14 patient-visible reply on resolve', () => {
  it('advice_given and referred need a patientReply (400); other dispositions do not', async () => {
    const { id: p } = await newLoginPatient(t, reception, 'Reply Needed');
    await linkPatient(admin, reception, p, 1);
    const resolve = (id: string, body: Record<string, unknown>) =>
      followup.post(`/follow-up-tasks/${id}/resolve`, { outcomeNote: 'Spoke to the patient', ...body });

    const a = await taskFor(p);
    expect((await resolve(a.id, { disposition: 'advice_given' })).status).toBe(400);
    expect((await resolve(a.id, { disposition: 'referred' })).status).toBe(400);
    expect((await resolve(a.id, { disposition: 'advice_given', patientReply: '  ' })).status).toBe(400);
    expect((await resolve(a.id, { disposition: 'advice_given', patientReply: 'ok' })).status).toBe(400); // too short
    expect((await resolve(a.id, { disposition: 'no_action_needed' })).status).toBe(200);

    const b = await taskFor(p);
    expect((await resolve(b.id, { disposition: 'unreachable' })).status).toBe(200);
    const c = await taskFor(p);
    const withReply = await resolve(c.id, { disposition: 'no_action_needed', patientReply: 'No action is needed. See you at your visit.' });
    expect(withReply.status).toBe(200); // optional for the others
  });

  it('stores the reply and time; staff and the patient read it; the outcome note stays staff-only', async () => {
    const { id: p, client: patient } = await newLoginPatient(t, reception, 'Reply Reader');
    await linkPatient(admin, reception, p, 1);
    const task = await taskFor(p, { title: 'INTERNAL: check adherence' });

    const before = (await patient.get('/me/follow-ups')).body as PatientFollowUp[];
    expect(before.find((x) => x.id === task.id)).toMatchObject({ status: 'open', urgent: false });
    expect(before.find((x) => x.id === task.id)!.reply ?? null).toBeNull();

    t.clock.set(new Date(Date.now() + 60_000));
    const res = await followup.post(`/follow-up-tasks/${task.id}/resolve`, {
      disposition: 'advice_given',
      outcomeNote: 'STAFF NOTE: spoke at 3pm, patient anxious',
      patientReply: '  Please keep taking the tablet and come on Monday.  ',
    });
    expect(res.status).toBe(200);
    expect(FollowUpTask.parse(res.body)).toMatchObject({ patientReply: 'Please keep taking the tablet and come on Monday.' });

    const row = (await t.pool.query(`SELECT patient_reply, patient_reply_at FROM follow_up_tasks WHERE id = $1`, [task.id])).rows[0]!;
    expect(row.patient_reply).toBe('Please keep taking the tablet and come on Monday.');
    expect(new Date(row.patient_reply_at as string).getTime()).toBe(t.clock.now().getTime());

    const mine = PatientFollowUp.array().parse((await patient.get('/me/follow-ups')).body);
    const seen = mine.find((x) => x.id === task.id)!;
    expect(seen).toMatchObject({
      status: 'resolved',
      reply: 'Please keep taking the tablet and come on Monday.',
      repliedAt: t.clock.now().toISOString(),
      urgent: false,
    });
    expect(JSON.stringify(seen)).not.toMatch(/STAFF NOTE|INTERNAL/);

    const detail = FollowUpTask.parse((await followup.get(`/follow-up-tasks/${task.id}`)).body);
    expect(detail.patientReply).toBe('Please keep taking the tablet and come on Monday.');
    const listed = (await followup.get(`/follow-up-tasks?owner=all&patientId=${p}`)).body as FollowUpTask[];
    expect(listed.find((x) => x.id === task.id)!.patientReply).toBe('Please keep taking the tablet and come on Monday.');
  });

  it('the reply text is not in the audit row or the outbox event (the notification only says a reply is waiting)', async () => {
    const { id: p } = await newLoginPatient(t, reception, 'Reply Private');
    await linkPatient(admin, reception, p, 1);
    const task = await taskFor(p);
    await followup.post(`/follow-up-tasks/${task.id}/resolve`, {
      disposition: 'referred',
      outcomeNote: 'Referred to cardiology',
      patientReply: 'SECRETREPLY please see the cardiology clinic',
    });
    const audit = await t.pool.query(`SELECT previous, next, reason FROM audit_events WHERE operation = 'follow_up.resolve' AND entity_id = $1`, [task.id]);
    expect(JSON.stringify(audit.rows)).not.toContain('SECRETREPLY');
    const ev = await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'FollowUpResolved' AND entity_id = $1`, [task.id]);
    expect(JSON.stringify(ev.rows)).not.toContain('SECRETREPLY');
    expect(ev.rows[0]!.payload).toMatchObject({ disposition: 'referred', hasReply: true });
  });

  it('another patient never sees the reply', async () => {
    const a = await newLoginPatient(t, reception, 'Reply Owner');
    const b = await newLoginPatient(t, reception, 'Reply Stranger');
    await linkPatient(admin, reception, a.id, 1);
    const task = await taskFor(a.id);
    await followup.post(`/follow-up-tasks/${task.id}/resolve`, { disposition: 'advice_given', outcomeNote: 'Advised', patientReply: 'Rest and fluids for two days.' });
    expect(JSON.stringify((await b.client.get('/me/follow-ups')).body)).not.toContain('Rest and fluids');
  });
});

describe('PR-38 staff task context', () => {
  it('reads add MRN, phone, urgent, and the patient reply; the doctor is the most recent appointment doctor in the reader scope', async () => {
    const reg = await reception.post('/patients', { fullName: 'Context Patient', phone: '+91 98765 43210', confirmNew: true }, null);
    const p = reg.body.id as string;
    const mrn = reg.body.mrn as string;
    await linkPatient(admin, reception, p, 1); // earlier session
    await linkPatient(admin, reception, p, 2); // later session: the most recent appointment

    const task = await taskFor(p, { ownerId: undefined }, admin);
    const asAdmin = FollowUpTask.parse((await admin.get(`/follow-up-tasks/${task.id}`)).body);
    expect(asAdmin).toMatchObject({ patientMrn: mrn, patientPhone: '+91 98765 43210', urgent: false, patientReply: null });
    expect(asAdmin.doctorName).toMatch(/Narayan/); // doctor 2, the most recent

    // Doctor 1 only sees their own side of the patient: the doctor shown is theirs.
    const asDoctor1 = FollowUpTask.parse((await doctor1.get(`/follow-up-tasks/${task.id}`)).body);
    expect(asDoctor1.doctorName).toMatch(/Hegde/);
    const listed = (await doctor1.get(`/follow-up-tasks?owner=all&patientId=${p}`)).body as FollowUpTask[];
    expect(listed.find((x) => x.id === task.id)).toMatchObject({ patientMrn: mrn, patientPhone: '+91 98765 43210' });
    expect(listed.find((x) => x.id === task.id)!.doctorName).toMatch(/Hegde/);
  });

  it('the doctor of the source visit wins; a patient without phone gets null', async () => {
    const p = await newPatient(reception, 'No Phone Patient');
    const session = await makeSession(admin, { doctor: 1 });
    t.clock.set(at(session, 0));
    const arrival = ArrivalResult.parse((await reception.post(`/sessions/${session.id}/walk-ins`, { patientId: p })).body);
    // doctor 2 also has an appointment with this patient, later than the visit
    await linkPatient(admin, reception, p, 2);
    t.clock.set(at(session, 1));
    const task = await taskFor(p, { sourceVisitId: arrival.visitId });
    const read = FollowUpTask.parse((await admin.get(`/follow-up-tasks/${task.id}`)).body);
    expect(read.doctorName).toMatch(/Hegde/);
    expect(read.patientPhone).toBeNull();
    expect(read.sourceVisit?.doctorName).toMatch(/Hegde/);
  });

  it('urgent tasks sort first within the existing order, and the flag is returned', async () => {
    const p = await newPatient(reception, 'Urgent Order');
    await linkPatient(admin, reception, p, 1);
    const later = await taskFor(p, { dueAt: inHours(30), title: 'Later routine' });
    const sooner = await taskFor(p, { dueAt: inHours(5), title: 'Sooner routine' });
    const urgentLate = await taskFor(p, { dueAt: inHours(40), title: 'Urgent but later due' });
    await t.pool.query(`UPDATE follow_up_tasks SET urgent = true WHERE id = $1`, [urgentLate.id]);

    const all = (await doctor1.get(`/follow-up-tasks?owner=all&patientId=${p}`)).body as FollowUpTask[];
    expect(all.map((x) => x.id)).toEqual([urgentLate.id, sooner.id, later.id]);
    expect(all[0]!.urgent).toBe(true);
    const open = (await doctor1.get(`/follow-up-tasks?owner=all&status=open&patientId=${p}`)).body as FollowUpTask[];
    expect(open.map((x) => x.id)).toEqual([urgentLate.id, sooner.id, later.id]);
  });
});

describe('PR-32 a doctor creates a follow-up for the patient in front of them', () => {
  async function consult(): Promise<{ patientId: string; visitId: string; session: Awaited<ReturnType<typeof makeSession>> }> {
    const p = await newPatient(reception, 'Consulted Patient');
    const session = await makeSession(admin, { doctor: 1 });
    await t.pool.query(
      `UPDATE queue_entries SET state = 'skipped', skipped_at = now() WHERE doctor_id = (SELECT doctor_id FROM sessions WHERE id = $1) AND state IN ('called','in_service')`,
      [session.id],
    );
    t.clock.set(at(session, 0));
    const arrival = ArrivalResult.parse((await reception.post(`/sessions/${session.id}/walk-ins`, { patientId: p })).body);
    t.clock.set(at(session, 2));
    const called = CallNextResult.parse((await doctor1.post(`/sessions/${session.id}/call-next`, {})).body);
    expect(called.entry?.visitId).toBe(arrival.visitId);
    t.clock.set(at(session, 3));
    expect((await doctor1.post(`/visits/${arrival.visitId}/start`, {})).status).toBe(200);
    return { patientId: p, visitId: arrival.visitId, session };
  }

  it('for the current in-service patient and, after completion, for the visit just completed', async () => {
    const { patientId, visitId, session } = await consult();
    // in service
    const during = await doctor1.post('/follow-up-tasks', {
      patientId,
      sourceVisitId: visitId,
      kind: 'post_visit',
      title: 'Check the wound in a week',
      dueAt: inHours(24 * 7),
    });
    expect(during.status).toBe(201);
    expect(FollowUpTask.parse(during.body)).toMatchObject({ kind: 'post_visit', sourceVisitId: visitId, status: 'open' });
    expect(during.body.ownerId).toBeTruthy(); // never unowned

    t.clock.set(at(session, 15));
    expect((await doctor1.post(`/visits/${visitId}/complete`, {})).status).toBe(200);
    // completed
    const after = await doctor1.post('/follow-up-tasks', {
      patientId,
      sourceVisitId: visitId,
      title: 'Call with blood test results',
      dueAt: inHours(48),
    });
    expect(after.status).toBe(201);
    // without a source visit too (the patient is linked by the completed visit)
    expect((await doctor1.post('/follow-up-tasks', { patientId, title: 'General check-in call', dueAt: inHours(72) })).status).toBe(201);
    // another doctor still cannot
    expect((await doctor2.post('/follow-up-tasks', { patientId, sourceVisitId: visitId, title: 'Not my patient', dueAt: inHours(24) })).status).toBe(404);
  });
});
