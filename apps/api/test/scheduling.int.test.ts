/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Appointment, Capacity, QueuePolicy, Session, SlotAvailability } from '@hqms/contracts';
import { capacityInvariant } from '@hqms/db';
import {
  type Client,
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
let patient: Client;

beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  patient = await loginAs(t.server, 'patient@hqms.test');
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  t.clock.reset();
});

describe('FR-02 sessions and capacity', () => {
  it('FR-02-a: seeded sessions carry 10 booked and 5 walk-in places under policy v1 (Table 7)', async () => {
    const res = await admin.get('/sessions');
    expect(res.status).toBe(200);
    const sessions = (res.body as unknown[]).map((s) => Session.parse(s));
    const seeded = sessions.filter((s) => s.sessionDate < '2040-01-01');
    expect(seeded.length).toBe(140);
    for (const s of seeded) {
      expect(s.capacity.bookedCapacity).toBe(10);
      expect(s.capacity.walkinCapacity).toBe(5);
      expect(s.policyVersion).toBe(1);
      expect(Capacity.parse(s.capacity).bookedAvailable).toBe(s.capacity.bookedCapacity - s.capacity.bookedReserved);
    }
    const policy = QueuePolicy.parse((await patient.get('/policies/current')).body);
    expect(policy).toMatchObject({
      version: 1,
      rotation: ['A', 'A', 'W'],
      earlyEligibilityMin: 10,
      lateGraceMin: 15,
      agingTriggerMin: 45,
      calledTimeoutSec: 120,
      ewmaAlpha: 0.2,
      initialEstimateMin: 12,
      defaultBookedCapacity: 10,
      defaultWalkinCapacity: 5,
    });
  });

  it('doctors list and session filters work', async () => {
    const docs = await patient.get('/doctors');
    expect(docs.status).toBe(200);
    expect(docs.body.length).toBe(10);
    const one = await admin.get(`/sessions?doctorId=${doctorId(2)}`);
    expect((one.body as Array<{ doctorId: string }>).every((s) => s.doctorId === doctorId(2))).toBe(true);
    expect((await admin.get('/sessions?date=not-a-date')).status).toBe(400);
  });

  it('admin creates a session with policy defaults; a duplicate start is a 409', async () => {
    const s = await makeSession(admin, { booked: 10, walkin: 5 });
    const read = Session.parse((await admin.get(`/sessions/${s.id}`)).body);
    expect(read.status).toBe('scheduled');
    expect(read.capacity).toMatchObject({ bookedCapacity: 10, walkinCapacity: 5, bookedReserved: 0, walkinUsed: 0 });
    const dup = await admin.post(
      '/sessions',
      {
        doctorId: doctorId(1),
        sessionDate: s.date,
        label: 'morning',
        startsAt: s.startsAt,
        endsAt: new Date(new Date(s.startsAt).getTime() + 3_600_000).toISOString(),
      },
      null,
    );
    expect(dup.status).toBe(409);
    const backwards = await admin.post(
      '/sessions',
      { doctorId: doctorId(1), sessionDate: s.date, label: 'evening', startsAt: s.startsAt, endsAt: s.startsAt },
      null,
    );
    expect(backwards.status).toBe(400);
  });

  it('FR-02-b: capacity cannot be reduced below places in use', async () => {
    const s = await makeSession(admin, { booked: 5, walkin: 2 });
    for (let i = 0; i < 3; i++)
      expect((await reception.post('/appointments', { sessionId: s.id, patientId: patientId(10 + i) })).status).toBe(
        201,
      );

    const tooLow = await admin.patch(`/sessions/${s.id}/capacity`, { bookedCapacity: 2, walkinCapacity: 2 });
    expect(tooLow.status).toBe(409);
    expect(tooLow.body.error.code).toBe('INVALID_CAPACITY_REDUCTION');
    expect(await capacityOf(t.pool, s.id)).toMatchObject({ booked_capacity: 5, booked_reserved: 3 });

    const ok = await admin.patch(`/sessions/${s.id}/capacity`, { bookedCapacity: 3, walkinCapacity: 4 });
    expect(ok.status).toBe(200);
    const updated = Session.parse(ok.body);
    expect(updated.capacity).toMatchObject({ bookedCapacity: 3, walkinCapacity: 4, bookedAvailable: 0 });
    expect(updated.version).toBe(2);

    // Stale version -> controlled 409, not a 500.
    const stale = await admin.patch(`/sessions/${s.id}/capacity`, {
      bookedCapacity: 4,
      walkinCapacity: 4,
      expectedVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CONFLICT');

    // The change itself is audited.
    expect(
      await count(t.pool, `SELECT 1 FROM audit_events WHERE operation = 'session.capacity.update' AND entity_id = $1`, [
        s.id,
      ]),
    ).toBe(1);
  });

  it('slots: every slot_minutes from the start; a held slot is unavailable', async () => {
    const s = await makeSession(admin);
    const before = SlotAvailability.parse((await patient.get(`/sessions/${s.id}/slots`)).body);
    expect(before.slots).toHaveLength(12); // 09:00-13:00 in 20 minute slots
    expect(before.slots.every((x) => x.available)).toBe(true);
    expect(new Date(before.slots[1]!.scheduledAt).getTime() - new Date(before.slots[0]!.scheduledAt).getTime()).toBe(
      20 * 60_000,
    );

    const booked = await patient.post('/appointments', { sessionId: s.id });
    expect(booked.status).toBe(201);
    const after = SlotAvailability.parse((await patient.get(`/sessions/${s.id}/slots`)).body);
    expect(after.slots[0]).toMatchObject({ scheduledAt: booked.body.scheduledAt, available: false });
    expect(after.slots.filter((x) => x.available)).toHaveLength(11);
    expect(after.capacity.bookedReserved).toBe(1);
  });
});

describe('FR-03 booking', () => {
  it('books the first free slot and writes audit, outbox and the release timer together', async () => {
    const s = await makeSession(admin);
    const res = await patient.post('/appointments', { sessionId: s.id });
    expect(res.status).toBe(201);
    const appt = Appointment.parse(res.body);
    expect(appt).toMatchObject({
      patientId: patientId(1),
      sessionId: s.id,
      doctorId: doctorId(1),
      status: 'booked',
      version: 1,
    });
    expect(appt.scheduledAt).toBe(s.startsAt);
    expect(res.body).not.toHaveProperty('allocationId');

    const second = await reception.post('/appointments', { sessionId: s.id, patientId: patientId(12) });
    expect(second.body.scheduledAt).toBe(new Date(new Date(s.startsAt).getTime() + 20 * 60_000).toISOString());

    expect(
      await count(t.pool, `SELECT 1 FROM audit_events WHERE operation = 'appointment.book' AND entity_id = $1`, [
        appt.id,
      ]),
    ).toBe(1);
    const outbox = await t.pool.query(
      `SELECT payload FROM outbox_events WHERE event_type = 'AppointmentBooked' AND entity_id = $1`,
      [appt.id],
    );
    expect(outbox.rows).toHaveLength(1);
    const job = await t.pool.query<{ run_at: string; state: string }>(
      `SELECT run_at, state FROM jobs WHERE dedupe_key = $1`,
      [`reservation_release:${appt.id}`],
    );
    expect(job.rows).toHaveLength(1);
    expect(new Date(job.rows[0]!.run_at).getTime()).toBe(new Date(appt.scheduledAt).getTime() + 15 * 60_000);
    expect(job.rows[0]!.state).toBe('pending');
    expect((await capacityInvariant(t.pool, s.id)).ok).toBe(true);
  });

  it('requires an Idempotency-Key and refuses follow-up linkage for reception and unknown sessions', async () => {
    const s = await makeSession(admin);
    const noKey = await patient.post('/appointments', { sessionId: s.id }, null);
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe('VALIDATION_FAILED');
    const link = await reception.post('/appointments', {
      sessionId: s.id,
      patientId: patientId(12),
      followUpTaskId: randomUUID(),
    });
    expect(link.status).toBe(403); // W3: only follow-up staff (and admin) book from a follow-up task
    expect((await patient.post('/appointments', { sessionId: randomUUID() })).status).toBe(404);
    expect((await reception.post('/appointments', { sessionId: s.id })).status).toBe(400); // staff must name the patient
    expect((await reception.post('/appointments', { sessionId: s.id, patientId: randomUUID() })).status).toBe(404);
    expect(await count(t.pool, `SELECT 1 FROM appointments WHERE session_id = $1`, [s.id])).toBe(0);
  });

  it('refuses sessions that are closed or already ended', async () => {
    const s = await makeSession(admin);
    await t.pool.query(`UPDATE sessions SET status = 'closed' WHERE id = $1`, [s.id]);
    const closed = await patient.post('/appointments', { sessionId: s.id });
    expect(closed.status).toBe(409);
    await t.pool.query(`UPDATE sessions SET status = 'open' WHERE id = $1`, [s.id]);
    t.clock.set(new Date(new Date(s.startsAt).getTime() + 5 * 3_600_000)); // after 13:00 IST
    const ended = await patient.post('/appointments', { sessionId: s.id });
    expect(ended.status).toBe(409);
    t.clock.reset();
    expect((await patient.post('/appointments', { sessionId: s.id })).status).toBe(201);
  });

  it('FR-03-b: the same key twice returns the first outcome and writes one row; the same key with other input is a 409', async () => {
    const s = await makeSession(admin);
    const other = await makeSession(admin);
    const key = `book-${randomUUID()}`;
    const first = await patient.post('/appointments', { sessionId: s.id }, key);
    const retry = await patient.post('/appointments', { sessionId: s.id }, key);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.headers['idempotency-replayed']).toBe('true');
    expect(await count(t.pool, `SELECT 1 FROM appointments WHERE session_id = $1`, [s.id])).toBe(1);
    expect((await capacityOf(t.pool, s.id)).booked_reserved).toBe(1);

    const reused = await patient.post('/appointments', { sessionId: other.id }, key);
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await count(t.pool, `SELECT 1 FROM appointments WHERE session_id = $1`, [other.id])).toBe(0);

    // Keys are per actor: another user may use the same string.
    const mine = await reception.post('/appointments', { sessionId: other.id, patientId: patientId(12) }, key);
    expect(mine.status).toBe(201);
  });

  it('parallel race: 12 requests for the last place give exactly one 201 and eleven CAPACITY_FULL', async () => {
    const s = await makeSession(admin, { booked: 3 });
    for (let i = 0; i < 2; i++)
      expect((await reception.post('/appointments', { sessionId: s.id, patientId: patientId(20 + i) })).status).toBe(
        201,
      );

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        reception.post('/appointments', { sessionId: s.id, patientId: patientId(22 + i) }),
      ),
    );
    const created = results.filter((r) => r.status === 201);
    const full = results.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(full).toHaveLength(11);
    expect(new Set(full.map((r) => r.body.error.code))).toEqual(new Set(['CAPACITY_FULL']));
    expect(results.some((r) => r.status >= 500)).toBe(false);

    expect(await count(t.pool, `SELECT 1 FROM appointments WHERE session_id = $1`, [s.id])).toBe(3);
    expect((await capacityOf(t.pool, s.id)).booked_reserved).toBe(3);
    expect((await capacityInvariant(t.pool, s.id)).ok).toBe(true);
    const slots = await t.pool.query(`SELECT DISTINCT scheduled_at FROM appointments WHERE session_id = $1`, [s.id]);
    expect(slots.rows).toHaveLength(3); // no two bookings share a slot
  });
});

describe('FR-04 cancel and reschedule', () => {
  it('FR-04-b: cancelling a booked appointment releases its place', async () => {
    const s = await makeSession(admin);
    const a = (await patient.post('/appointments', { sessionId: s.id })).body as Appointment;
    expect((await capacityOf(t.pool, s.id)).booked_reserved).toBe(1);

    const res = await patient.post(`/appointments/${a.id}/cancel`, { reason: 'unwell' });
    expect(res.status).toBe(200);
    expect(Appointment.parse(res.body)).toMatchObject({ status: 'cancelled', version: 2 });
    expect((await capacityOf(t.pool, s.id)).booked_reserved).toBe(0);
    expect((await capacityInvariant(t.pool, s.id)).ok).toBe(true);
    const alloc = await t.pool.query(
      `SELECT state FROM capacity_allocations WHERE id = (SELECT allocation_id FROM appointments WHERE id = $1)`,
      [a.id],
    );
    expect(alloc.rows[0]!.state).toBe('released');

    const types = (
      await t.pool.query<{ event_type: string }>(`SELECT event_type FROM outbox_events WHERE entity_id = $1`, [a.id])
    ).rows.map((r) => r.event_type);
    expect(types).toEqual(expect.arrayContaining(['AppointmentBooked', 'AppointmentCancelled', 'ReservationReleased']));
    const job = await t.pool.query(`SELECT state FROM jobs WHERE dedupe_key = $1`, [`reservation_release:${a.id}`]);
    expect(job.rows[0]!.state).toBe('cancelled');

    // A second cancel does not release twice.
    const again = await patient.post(`/appointments/${a.id}/cancel`, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_TRANSITION');
    expect((await capacityOf(t.pool, s.id)).booked_reserved).toBe(0);

    // The freed place can be booked again.
    expect((await reception.post('/appointments', { sessionId: s.id, patientId: patientId(12) })).status).toBe(201);
  });

  it('a stale expectedVersion on cancel is a controlled 409', async () => {
    const s = await makeSession(admin);
    const a = (await patient.post('/appointments', { sessionId: s.id })).body as Appointment;
    const stale = await patient.post(`/appointments/${a.id}/cancel`, { expectedVersion: 7 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CONFLICT');
    expect((await capacityOf(t.pool, s.id)).booked_reserved).toBe(1);
  });

  it('reschedule exchanges the reservations in one transaction', async () => {
    const from = await makeSession(admin);
    const to = await makeSession(admin);
    const a = (await patient.post('/appointments', { sessionId: from.id })).body as Appointment;

    const res = await patient.post(`/appointments/${a.id}/reschedule`, { targetSessionId: to.id });
    expect(res.status).toBe(201);
    const moved = Appointment.parse(res.body);
    expect(moved).toMatchObject({
      sessionId: to.id,
      status: 'booked',
      rescheduledFromId: a.id,
      patientId: patientId(1),
    });

    expect(Appointment.parse((await patient.get(`/appointments/${a.id}`)).body).status).toBe('rescheduled');
    expect((await capacityOf(t.pool, from.id)).booked_reserved).toBe(0);
    expect((await capacityOf(t.pool, to.id)).booked_reserved).toBe(1);
    expect((await capacityInvariant(t.pool, from.id)).ok).toBe(true);
    expect((await capacityInvariant(t.pool, to.id)).ok).toBe(true);
    expect(
      await count(
        t.pool,
        `SELECT 1 FROM outbox_events WHERE event_type = 'AppointmentRescheduled' AND entity_id = $1`,
        [moved.id],
      ),
    ).toBe(1);

    // Rescheduled appointments cannot be moved or cancelled again.
    expect((await patient.post(`/appointments/${a.id}/reschedule`, { targetSessionId: to.id })).status).toBe(409);
    expect((await patient.post(`/appointments/${a.id}/cancel`, {})).status).toBe(409);
    expect((await patient.post(`/appointments/${moved.id}/reschedule`, { targetSessionId: to.id })).status).toBe(400);
  });

  it('FR-04-a: a failed target reservation leaves the original appointment intact', async () => {
    const from = await makeSession(admin, { booked: 5 });
    const full = await makeSession(admin, { booked: 1 });
    expect((await reception.post('/appointments', { sessionId: full.id, patientId: patientId(12) })).status).toBe(201);
    const a = (await patient.post('/appointments', { sessionId: from.id })).body as Appointment;
    const beforeFrom = await capacityOf(t.pool, from.id);
    const beforeFull = await capacityOf(t.pool, full.id);
    const apptCountBefore = await count(t.pool, `SELECT 1 FROM appointments WHERE patient_id = $1`, [patientId(1)]);

    const res = await patient.post(`/appointments/${a.id}/reschedule`, { targetSessionId: full.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAPACITY_FULL');

    const original = Appointment.parse((await patient.get(`/appointments/${a.id}`)).body);
    expect(original).toMatchObject({ status: 'booked', sessionId: from.id, version: 1 });
    expect(await capacityOf(t.pool, from.id)).toEqual(beforeFrom);
    expect(await capacityOf(t.pool, full.id)).toEqual(beforeFull);
    const alloc = await t.pool.query(
      `SELECT state FROM capacity_allocations WHERE id = (SELECT allocation_id FROM appointments WHERE id = $1)`,
      [a.id],
    );
    expect(alloc.rows[0]!.state).toBe('reserved');
    expect(await count(t.pool, `SELECT 1 FROM appointments WHERE patient_id = $1`, [patientId(1)])).toBe(
      apptCountBefore,
    );
    expect((await capacityInvariant(t.pool, from.id)).ok).toBe(true);
    expect((await capacityInvariant(t.pool, full.id)).ok).toBe(true);
  });

  it('reschedule needs an Idempotency-Key and replays on the same key', async () => {
    const from = await makeSession(admin);
    const to = await makeSession(admin);
    const a = (await patient.post('/appointments', { sessionId: from.id })).body as Appointment;
    expect((await patient.post(`/appointments/${a.id}/reschedule`, { targetSessionId: to.id }, null)).status).toBe(400);
    const key = randomUUID();
    const one = await patient.post(`/appointments/${a.id}/reschedule`, { targetSessionId: to.id }, key);
    const two = await patient.post(`/appointments/${a.id}/reschedule`, { targetSessionId: to.id }, key);
    expect(one.status).toBe(201);
    expect(two.body.id).toBe(one.body.id);
    expect(await count(t.pool, `SELECT 1 FROM appointments WHERE session_id = $1`, [to.id])).toBe(1);
  });

  it('concurrent reschedules into a session with one place left: one wins, the loser keeps its original', async () => {
    const target = await makeSession(admin, { booked: 1 });
    const sources = await Promise.all([makeSession(admin), makeSession(admin), makeSession(admin), makeSession(admin)]);
    const appts = await Promise.all(
      sources.map(
        async (src, i) =>
          (await reception.post('/appointments', { sessionId: src.id, patientId: patientId(30 + i) }))
            .body as Appointment,
      ),
    );
    const results = await Promise.all(
      appts.map((a) => reception.post(`/appointments/${a.id}/reschedule`, { targetSessionId: target.id })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.body.error.code === 'CAPACITY_FULL')).toHaveLength(3);
    expect(results.some((r) => r.status >= 500)).toBe(false);
    expect((await capacityOf(t.pool, target.id)).booked_reserved).toBe(1);
    for (const [i, src] of sources.entries()) {
      const won = results[i]!.status === 201;
      expect((await capacityOf(t.pool, src.id)).booked_reserved).toBe(won ? 0 : 1);
      expect((await capacityInvariant(t.pool, src.id)).ok).toBe(true);
    }
  });

  it('listing: a patient only gets their own; staff must name a session or patient and stay in scope', async () => {
    const s = await makeSession(admin);
    await patient.post('/appointments', { sessionId: s.id });
    await reception.post('/appointments', { sessionId: s.id, patientId: patientId(12) });

    const bySession = await reception.get(`/appointments?sessionId=${s.id}`);
    expect(bySession.status).toBe(200);
    expect(bySession.body).toHaveLength(2);
    expect((await reception.get('/appointments')).status).toBe(400);
    const mine = await patient.get(`/appointments?sessionId=${s.id}`);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].patientId).toBe(patientId(1));

    const pid = await newPatient(reception);
    expect((await reception.get(`/appointments?patientId=${pid}`)).body).toEqual([]);
  });
});
