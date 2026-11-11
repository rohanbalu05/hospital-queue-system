/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, ArrivalResult, Appointment } from '@hqms/contracts';
import { capacityInvariant } from '@hqms/db';
import {
  type Client,
  at,
  capacityOf,
  count,
  createTestApp,
  doctorId,
  loginAs,
  makeSession,
  newPatient,
  patientId,
  type TestApp,
} from './helpers.js';

let t: TestApp;
let admin: Client;
let reception: Client;
let doctor1: Client;
let doctor2: Client;
let followup: Client;

beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  doctor1 = await loginAs(t.server, 'doctor@hqms.test');
  doctor2 = await loginAs(t.server, 'doctor2@hqms.test');
  followup = await loginAs(t.server, 'followup2@hqms.test'); // doctors 1-4
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => t.clock.reset());

describe('D-022 past-slot booking', () => {
  it('booking mid-session never hands out a slot whose grace window has closed', async () => {
    const s = await makeSession(admin);
    t.clock.set(at(s, 120)); // 11:00, session 09:00-13:00, 20 minute slots
    const res = await reception.post('/appointments', { sessionId: s.id, patientId: patientId(3) });
    expect(res.status).toBe(201);
    const appt = res.body as Appointment;
    // Slots start at 09:00 + 20k: 10:40 is stale (its grace closed at 10:55), 11:00 is the first worth booking.
    expect(new Date(appt.scheduledAt).getTime()).toBe(at(s, 120).getTime());
    const job = await t.pool.query(`SELECT run_at FROM jobs WHERE dedupe_key = $1`, [`reservation_release:${appt.id}`]);
    expect(new Date(job.rows[0]!.run_at).getTime()).toBeGreaterThan(at(s, 120).getTime());
  });

  it('a slot still inside its grace window is bookable; one past it is skipped', async () => {
    const s = await makeSession(admin);
    t.clock.set(at(s, 130)); // 11:10: slot 11:00 closes at 11:15 -> still bookable
    const a = (await reception.post('/appointments', { sessionId: s.id, patientId: patientId(4) })).body as Appointment;
    expect(new Date(a.scheduledAt).getTime()).toBe(at(s, 120).getTime());
    t.clock.set(at(s, 136)); // 11:16: 11:00 is stale, and taken anyway -> 11:20
    const b = (await reception.post('/appointments', { sessionId: s.id, patientId: patientId(5) })).body as Appointment;
    expect(new Date(b.scheduledAt).getTime()).toBe(at(s, 140).getTime());
  });

  it('with no slot left worth booking the answer is CAPACITY_FULL', async () => {
    const s = await makeSession(admin);
    t.clock.set(at(s, 236)); // 12:56; last slot 12:40 closed at 12:55; session ends 13:00
    const res = await reception.post('/appointments', { sessionId: s.id, patientId: patientId(6) });
    expect(res.status).toBe(409);
    expect(ApiError.parse(res.body).error.code).toBe('CAPACITY_FULL');
  });
});

describe('D-022 one active appointment per patient per session', () => {
  it('a duplicate booking is a controlled 409 CONFLICT; after cancelling the patient can book again', async () => {
    const s = await makeSession(admin);
    const first = await reception.post('/appointments', { sessionId: s.id, patientId: patientId(7) });
    expect(first.status).toBe(201);
    const dup = await reception.post('/appointments', { sessionId: s.id, patientId: patientId(7) });
    expect(dup.status).toBe(409);
    expect(ApiError.parse(dup.body).error).toMatchObject({ code: 'CONFLICT' });
    expect(ApiError.parse(dup.body).error.message).toMatch(/already has an active appointment/);
    expect(await capacityOf(t.pool, s.id)).toMatchObject({ booked_reserved: 1 });

    const cancel = await reception.post(`/appointments/${first.body.id}/cancel`, {}, null);
    expect(cancel.status).toBe(200);
    expect((await reception.post('/appointments', { sessionId: s.id, patientId: patientId(7) })).status).toBe(201);
  });

  it('reschedule away and back works (the old row is rescheduled, not active); a duplicate target is refused', async () => {
    const a = await makeSession(admin, { doctor: 1 });
    const b = await makeSession(admin, { doctor: 1 });
    const appt = (await reception.post('/appointments', { sessionId: a.id, patientId: patientId(8) })).body as Appointment;
    const moved = await reception.post(`/appointments/${appt.id}/reschedule`, { targetSessionId: b.id });
    expect(moved.status).toBe(201);
    const back = await reception.post(`/appointments/${moved.body.id}/reschedule`, { targetSessionId: a.id });
    expect(back.status).toBe(201);

    // The patient also holds an active appointment in b? No: it was moved. Book b, then try to move a -> b.
    const inB = await reception.post('/appointments', { sessionId: b.id, patientId: patientId(8) });
    expect(inB.status).toBe(201);
    const clash = await reception.post(`/appointments/${back.body.id}/reschedule`, { targetSessionId: b.id });
    expect(clash.status).toBe(409);
    expect(ApiError.parse(clash.body).error.code).toBe('CONFLICT');
    expect((await capacityInvariant(t.pool, a.id)).ok).toBe(true);
    expect((await capacityInvariant(t.pool, b.id)).ok).toBe(true);
  });

  it('a walk-in is refused while the patient holds an active appointment there; check-in is the way in', async () => {
    const s = await makeSession(admin);
    const appt = (await reception.post('/appointments', { sessionId: s.id, patientId: patientId(9) })).body as Appointment;
    t.clock.set(at(s, -5));
    const walk = await reception.post(`/sessions/${s.id}/walk-ins`, { patientId: patientId(9) });
    expect(walk.status).toBe(409);
    expect(ApiError.parse(walk.body).error.code).toBe('CONFLICT');
    expect(walk.body.error.message).toMatch(/check the appointment in/);
    expect((await reception.post(`/appointments/${appt.id}/check-in`, {})).status).toBe(201);
  });

  it('check-in is refused when the patient already has a live place in the session via a walk-in', async () => {
    const s = await makeSession(admin);
    const appt = (await reception.post('/appointments', { sessionId: s.id, patientId: patientId(10) }))
      .body as Appointment;
    t.clock.set(at(s, -5));
    // Simulate a walk-in entry created before the appointment existed: insert directly.
    const pid = patientId(10);
    const alloc = await t.pool.query(
      `INSERT INTO capacity_allocations (session_id, kind, state) VALUES ($1, 'walkin', 'consumed') RETURNING id`,
      [s.id],
    );
    await t.pool.query(`UPDATE session_capacity SET walkin_used = walkin_used + 1 WHERE session_id = $1`, [s.id]);
    const admin1 = await t.pool.query(`SELECT id FROM users WHERE email = 'admin@hqms.test'`);
    const visit = await t.pool.query(
      `INSERT INTO visits (patient_id, session_id, doctor_id, allocation_id, kind, checked_in_at, checked_in_by)
       VALUES ($1, $2, $3, $4, 'walkin', now(), $5) RETURNING id`,
      [pid, s.id, doctorId(1), alloc.rows[0]!.id, admin1.rows[0]!.id],
    );
    await t.pool.query(
      `INSERT INTO queue_entries (visit_id, session_id, doctor_id, queue_group, token, seq, checked_in_at, eligible_at)
       VALUES ($1, $2, $3, 'W', 'W-001', 1, now(), now())`,
      [visit.rows[0]!.id, s.id, doctorId(1)],
    );
    const res = await reception.post(`/appointments/${appt.id}/check-in`, {});
    expect(res.status).toBe(409);
    expect(ApiError.parse(res.body).error.code).toBe('CONFLICT');
  });
});

describe('D-022 late admission after the worker marked the appointment missed', () => {
  it('missed -> checked_in needs admitLate; with it the patient joins as W without double-releasing the booked place', async () => {
    const s = await makeSession(admin);
    const appt = (await reception.post('/appointments', { sessionId: s.id, patientId: patientId(11) })).body as Appointment;
    // The worker's reservation_release effect, applied by hand: status missed + allocation released.
    await t.pool.query(`UPDATE appointments SET status = 'missed', version = version + 1 WHERE id = $1`, [appt.id]);
    await t.pool.query(
      `UPDATE capacity_allocations SET state = 'released' WHERE id = (SELECT allocation_id FROM appointments WHERE id = $1)`,
      [appt.id],
    );
    await t.pool.query(`UPDATE session_capacity SET booked_reserved = booked_reserved - 1 WHERE session_id = $1`, [s.id]);
    const before = await capacityOf(t.pool, s.id);
    expect(before).toMatchObject({ booked_reserved: 0, walkin_used: 0 });

    t.clock.set(at(s, 45));
    const refused = await reception.post(`/appointments/${appt.id}/check-in`, {});
    expect(refused.status).toBe(409);
    expect(ApiError.parse(refused.body).error.code).toBe('LATE_ARRIVAL_REQUIRES_REVIEW');

    const ok = await reception.post(`/appointments/${appt.id}/check-in`, { admitLate: true });
    expect(ok.status).toBe(201);
    expect(ArrivalResult.parse(ok.body)).toMatchObject({ group: 'W', kind: 'late_admission' });
    expect(await capacityOf(t.pool, s.id)).toMatchObject({ booked_reserved: 0, walkin_used: 1 });
    expect((await capacityInvariant(t.pool, s.id)).ok).toBe(true);
    const row = await t.pool.query(`SELECT status FROM appointments WHERE id = $1`, [appt.id]);
    expect(row.rows[0]!.status).toBe('checked_in');
  });

  it('a late admission of a still-booked appointment emits ReservationReleased', async () => {
    const s = await makeSession(admin);
    const appt = (await reception.post('/appointments', { sessionId: s.id, patientId: patientId(12) })).body as Appointment;
    t.clock.set(at(s, 40));
    expect((await reception.post(`/appointments/${appt.id}/check-in`, { admitLate: true })).status).toBe(201);
    expect(
      await count(
        t.pool,
        `SELECT 1 FROM outbox_events WHERE event_type = 'ReservationReleased' AND entity_id = $1`,
        [appt.id],
      ),
    ).toBe(1);
    expect((await capacityInvariant(t.pool, s.id)).ok).toBe(true);
  });
});

describe('D-022 patient PII scope', () => {
  it('search is reception/admin only, needs 3+ characters and is audited without the query text', async () => {
    expect((await reception.get('/patients?q=ra')).status).toBe(400);
    expect((await reception.get('/patients?q=')).status).toBe(400);
    expect((await doctor1.get('/patients?q=ramesh')).status).toBe(403);
    expect((await followup.get('/patients?q=ramesh')).status).toBe(403);
    const found = await reception.get('/patients?q=Ramesh');
    expect(found.status).toBe(200);
    expect(found.body.map((p: { fullName: string }) => p.fullName)).toContain('Ramesh Kumar');
    expect((await admin.get('/patients?q=Ramesh')).status).toBe(200);

    const rows = await t.pool.query(
      `SELECT next, actor_role FROM audit_events WHERE operation = 'patient.search' ORDER BY id DESC LIMIT 2`,
    );
    expect(rows.rows.length).toBe(2);
    expect(rows.rows.map((r) => r.actor_role).sort()).toEqual(['admin', 'reception']);
    for (const r of rows.rows) {
      expect(r.next).toMatchObject({ queryLength: 6 });
      expect(JSON.stringify(r.next)).not.toContain('Ramesh');
    }
  });

  it('a doctor or follow-up user reads only patients linked to their scope', async () => {
    const s = await makeSession(admin, { doctor: 1 });
    const p = await newPatient(reception, 'Linked Only Patient');
    // Not linked to anyone yet.
    expect((await doctor1.get(`/patients/${p}`)).status).toBe(404);
    expect((await followup.get(`/patients/${p}`)).status).toBe(404);
    expect((await reception.post('/appointments', { sessionId: s.id, patientId: p })).status).toBe(201);
    expect((await doctor1.get(`/patients/${p}`)).status).toBe(200);
    expect((await followup.get(`/patients/${p}`)).status).toBe(200); // followup2 covers doctors 1-4
    expect((await doctor2.get(`/patients/${p}`)).status).toBe(404); // linked to doctor 1 only
    expect((await reception.get(`/patients/${p}`)).status).toBe(200);
  });
});
