/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
/**
 * B4.5 patient's own today visits (walk-ins), B4.6 follow-up link kept across reschedule/cancel, B4.7 clear
 * errors for "new version of" verification, B4.8 availability on session reads.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, Appointment, FollowUpTask, MyTodayVisit, Session } from '@hqms/contracts';
import {
  type Client,
  at,
  createTestApp,
  linkPatient,
  loginAs,
  makeSession,
  newLoginPatient,
  newPatient,
  type TestApp,
} from './helpers.js';
import { makePng } from './fakes.js';

let t: TestApp;
let admin: Client;
let reception: Client;
let doctor1: Client;
let followup: Client;
let F1: string;

beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  doctor1 = await loginAs(t.server, 'doctor@hqms.test');
  followup = await loginAs(t.server, 'followup@hqms.test');
  F1 = (await followup.get('/me')).body.userId as string;
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => t.clock.reset());

const code = (body: unknown): string => ApiError.parse(body).error.code;

describe('B4.5 GET /me/visits/today', () => {
  it('a walk-in admitted by reception appears on the patient own Today; another patient sees nothing of it', async () => {
    const a = await newLoginPatient(t, reception, 'Walk In Alpha');
    const b = await newLoginPatient(t, reception, 'Walk In Beta');
    const s = await makeSession(admin);
    t.clock.set(at(s, 30)); // 09:30 on the session day
    const adm = await reception.post(`/sessions/${s.id}/walk-ins`, { patientId: a.id });
    expect(adm.status).toBe(201);

    const mine = await a.client.get('/me/visits/today');
    expect(mine.status).toBe(200);
    const visits = (mine.body as unknown[]).map((v) => MyTodayVisit.parse(v));
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({
      sessionId: s.id,
      appointmentId: null,
      kind: 'walkin',
      visitStatus: 'open',
      token: adm.body.token,
      queueState: 'waiting',
    });
    expect(visits[0]!.availability.state).toBe('not_started');
    expect(visits[0]!.availability.reason).toBeNull();

    const other = await b.client.get('/me/visits/today');
    expect(other.status).toBe(200);
    expect(other.body).toEqual([]);
  });

  it('an appointment check-in carries its appointment id; a completed visit and a different day are not listed', async () => {
    const p = await newLoginPatient(t, reception, 'Appt Visit');
    const s = await makeSession(admin);
    const booked = await reception.post('/appointments', { sessionId: s.id, patientId: p.id });
    expect(booked.status).toBe(201);
    t.clock.set(at(s, 5));
    const ci = await reception.post(`/appointments/${booked.body.id}/check-in`, {});
    expect(ci.status).toBe(201);
    const list = (await p.client.get('/me/visits/today')).body as unknown[];
    expect(list).toHaveLength(1);
    expect(MyTodayVisit.parse(list[0])).toMatchObject({ appointmentId: booked.body.id, kind: 'appointment' });
    // the next day it is no longer "today"
    t.clock.set(at(s, 24 * 60 + 30));
    expect((await p.client.get('/me/visits/today')).body).toEqual([]);
    t.clock.set(at(s, 30));
    await t.pool.query(`UPDATE visits SET status = 'completed', completed_at = now() WHERE id = $1`, [ci.body.visitId]);
    expect((await p.client.get('/me/visits/today')).body).toEqual([]);
  });

  it('is patient-only', async () => {
    expect((await reception.get('/me/visits/today')).status).toBe(403);
    expect((await doctor1.get('/me/visits/today')).status).toBe(403);
    expect((await admin.get('/me/visits/today')).status).toBe(403);
  });
});

describe('B4.6 follow-up link survives reschedule and cancel', () => {
  async function returnBooking(): Promise<{ patient: string; task: FollowUpTask; appt: Appointment }> {
    const patient = await newPatient(reception, 'Return Patient');
    await linkPatient(admin, reception, patient, 1);
    const made = await doctor1.post('/follow-up-tasks', {
      patientId: patient,
      kind: 'return_visit',
      title: 'Arrange a review visit',
      dueAt: new Date(t.clock.now().getTime() + 24 * 3_600_000).toISOString(),
      ownerId: F1,
    });
    expect(made.status).toBe(201);
    const task = FollowUpTask.parse(made.body);
    const target = await makeSession(admin, { doctor: 1 });
    const res = await followup.post(`/follow-up-tasks/${task.id}/return-booking`, { sessionId: target.id });
    expect(res.status).toBe(201);
    return { patient, task, appt: Appointment.parse(res.body) };
  }

  it('reschedule keeps follow_up_task_id and moves the task return pointer in the same transaction', async () => {
    const { task, appt } = await returnBooking();
    const to = await makeSession(admin, { doctor: 2 });
    const res = await reception.post(`/appointments/${appt.id}/reschedule`, {
      targetSessionId: to.id,
      expectedVersion: appt.version,
    });
    expect(res.status).toBe(201);
    const moved = Appointment.parse(res.body);
    expect(moved.followUpTaskId).toBe(task.id);
    expect(moved.rescheduledFromId).toBe(appt.id);
    const read = FollowUpTask.parse((await followup.get(`/follow-up-tasks/${task.id}`)).body);
    expect(read.returnAppointmentId).toBe(moved.id);
    expect(read.version).toBeGreaterThan(task.version);
    // the task can still be resolved as return_booked against the new appointment
    const resolved = await followup.post(`/follow-up-tasks/${task.id}/resolve`, {
      disposition: 'return_booked',
      outcomeNote: 'Return visit booked',
      returnAppointmentId: moved.id,
    });
    expect(resolved.status).toBe(200);
  });

  it('cancelling the return booking leaves an open task without a live return appointment, and it can be rebooked', async () => {
    const { task, appt } = await returnBooking();
    const cancel = await reception.post(`/appointments/${appt.id}/cancel`, { reason: 'patient asked' });
    expect(cancel.status).toBe(200);
    const read = FollowUpTask.parse((await followup.get(`/follow-up-tasks/${task.id}`)).body);
    expect(read.status).toBe('open');
    expect(read.returnAppointmentId).toBeNull();
    const again = await followup.post(`/follow-up-tasks/${task.id}/return-booking`, {
      sessionId: (await makeSession(admin, { doctor: 1 })).id,
    });
    expect(again.status).toBe(201);
  });

  it('a resolved return_booked task keeps its pointer (history) when the appointment is later cancelled', async () => {
    const { task, appt } = await returnBooking();
    const resolved = await followup.post(`/follow-up-tasks/${task.id}/resolve`, {
      disposition: 'return_booked',
      outcomeNote: 'Return visit booked',
      returnAppointmentId: appt.id,
    });
    expect(resolved.status).toBe(200);
    expect((await reception.post(`/appointments/${appt.id}/cancel`, {})).status).toBe(200);
    const read = FollowUpTask.parse((await followup.get(`/follow-up-tasks/${task.id}`)).body);
    expect(read.returnAppointmentId).toBe(appt.id);
  });
});

describe('B4.7 verifying a new version of an instruction', () => {
  it('a revision without expectedCurrentVersionId is a 400 that names the field and the current version id; stale is 409 with it', async () => {
    const p = await newLoginPatient(t, reception, 'Instruction Patient');
    await linkPatient(admin, reception, p.id, 1);
    async function readyDocument(text: string): Promise<string> {
      const up = await p.client.upload('/documents', makePng(), { patientId: p.id });
      expect(up.status).toBe(201);
      await t.pool.query(`INSERT INTO ocr_drafts (document_id, provider, text, blocks) VALUES ($1, 'fake', $2, '[]')`, [
        up.body.id,
        text,
      ]);
      await t.pool.query(`UPDATE documents SET status = 'ocr_ready', version = version + 1 WHERE id = $1`, [
        up.body.id,
      ]);
      return up.body.id as string;
    }
    const d1 = await readyDocument('Take rest');
    const v1 = await doctor1.post(`/documents/${d1}/verify`, { title: 'Aftercare', body: 'Rest and fluids.' });
    expect(v1.status).toBe(201);
    const d2 = await readyDocument('Take more rest');
    const missing = await doctor1.post(`/documents/${d2}/verify`, {
      instructionId: v1.body.instructionId,
      title: 'Aftercare',
      body: 'Rest and plenty of fluids.',
    });
    expect(missing.status).toBe(400);
    expect(code(missing.body)).toBe('VALIDATION_FAILED');
    expect(missing.body.error.message).toContain('expectedCurrentVersionId');
    expect(missing.body.error.details).toMatchObject({
      field: 'expectedCurrentVersionId',
      currentVersionId: v1.body.id,
    });
    const stale = await doctor1.post(`/documents/${d2}/verify`, {
      instructionId: v1.body.instructionId,
      expectedCurrentVersionId: '00000000-0000-4000-8000-000000000000',
      title: 'Aftercare',
      body: 'Rest and plenty of fluids.',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details).toMatchObject({ currentVersionId: v1.body.id });
    const ok = await doctor1.post(`/documents/${d2}/verify`, {
      instructionId: v1.body.instructionId,
      expectedCurrentVersionId: v1.body.id,
      title: 'Aftercare',
      body: 'Rest and plenty of fluids.',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.version).toBe(2);
  });
});

describe('B4.8 sessions carry availability', () => {
  it('GET /sessions/{id} and GET /sessions include availability; the reason is staff-only', async () => {
    const s = await makeSession(admin);
    const plain = Session.parse((await admin.get(`/sessions/${s.id}`)).body);
    expect(plain.availability).toMatchObject({ state: 'not_started', reason: null, expectedBackAt: null });

    expect((await reception.post(`/sessions/${s.id}/open`, {})).status).toBe(200);
    const until = new Date(Date.now() + 30 * 60_000).toISOString();
    const away = await reception.post(`/sessions/${s.id}/pause`, { until, reason: 'Emergency in ward' });
    expect(away.status).toBe(200);

    const patient = (await newLoginPatient(t, reception, 'Availability Reader')).client;
    const asStaff = Session.parse((await reception.get(`/sessions/${s.id}`)).body);
    expect(asStaff.availability).toMatchObject({ state: 'away', reason: 'Emergency in ward', overdue: false });
    expect(asStaff.availability?.since).not.toBeNull();
    expect(new Date(asStaff.availability!.expectedBackAt!).toISOString()).toBe(until);
    const asPatient = Session.parse((await patient.get(`/sessions/${s.id}`)).body);
    expect(asPatient.availability).toMatchObject({ state: 'away', reason: null });
    expect(JSON.stringify((await patient.get(`/sessions/${s.id}`)).body)).not.toContain('Emergency in ward');

    const listed = (await admin.get(`/sessions?date=${s.date}`)).body as unknown[];
    const row = listed.map((x) => Session.parse(x)).find((x) => x.id === s.id);
    expect(row?.availability?.state).toBe('away');

    const un = await reception.post(`/sessions/${s.id}/unavailable`, { reason: 'Doctor unwell' });
    expect(un.status).toBe(200);
    expect(Session.parse((await patient.get(`/sessions/${s.id}`)).body).availability).toMatchObject({
      state: 'unavailable',
      reason: null,
    });
    expect(Session.parse((await admin.get(`/sessions/${s.id}`)).body).availability).toMatchObject({
      state: 'unavailable',
      reason: 'Doctor unwell',
    });
  });
});
