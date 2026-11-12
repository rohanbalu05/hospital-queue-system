/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
import { randomUUID } from 'node:crypto';
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
  type MadeSession,
  type TestApp,
} from './helpers.js';

let t: TestApp;
let admin: Client;
let reception: Client;

beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  t.clock.reset();
});

/** Book `patient` into `s` (as reception, real clock) and return the appointment. */
async function bookFor(s: MadeSession, patient: string): Promise<Appointment> {
  t.clock.reset();
  const res = await reception.post('/appointments', { sessionId: s.id, patientId: patient });
  if (res.status !== 201) throw new Error(`booking failed ${res.status}`);
  return res.body as Appointment;
}

describe('FR-05 check-in', () => {
  it('FR-05-a: an on-time check-in creates one visit and one group-A queue entry and consumes the allocation', async () => {
    const s = await makeSession(admin);
    const appt = await bookFor(s, patientId(12));
    t.clock.set(at(s, -5));
    const res = await reception.post(`/appointments/${appt.id}/check-in`, {});
    expect(res.status).toBe(201);
    const arrival = ArrivalResult.parse(res.body);
    expect(arrival).toMatchObject({ token: 'A-001', group: 'A', kind: 'appointment' });
    expect(arrival.queueVersion).toBe(1);

    const visit = await t.pool.query(`SELECT kind, appointment_id, status FROM visits WHERE id = $1`, [
      arrival.visitId,
    ]);
    expect(visit.rows[0]).toMatchObject({ kind: 'appointment', appointment_id: appt.id, status: 'open' });
    const entry = await t.pool.query(
      `SELECT queue_group, token, seq, state, doctor_id, scheduled_at, eligible_at FROM queue_entries WHERE id = $1`,
      [arrival.queueEntryId],
    );
    expect(entry.rows[0]).toMatchObject({ queue_group: 'A', token: 'A-001', seq: 1, state: 'waiting' });
    // eligible = max(check-in, scheduled - 10 min) = check-in (5 min before the slot is after the 10-minute mark)
    expect(new Date(arrival.eligibleAt).getTime()).toBe(at(s, -5).getTime());

    expect(Appointment.parse((await reception.get(`/appointments/${appt.id}`)).body).status).toBe('checked_in');
    const alloc = await t.pool.query(
      `SELECT state FROM capacity_allocations WHERE id = (SELECT allocation_id FROM appointments WHERE id = $1)`,
      [appt.id],
    );
    expect(alloc.rows[0]!.state).toBe('consumed');
    expect(await capacityOf(t.pool, s.id)).toMatchObject({ booked_reserved: 1, walkin_used: 0 });

    // Audit + a minimal event in the same transaction.
    expect(
      await count(t.pool, `SELECT 1 FROM audit_events WHERE operation = 'visit.check_in' AND entity_id = $1`, [
        arrival.visitId,
      ]),
    ).toBe(1);
    const ev = await t.pool.query(
      `SELECT payload FROM outbox_events WHERE event_type = 'VisitCheckedIn' AND entity_id = $1`,
      [arrival.visitId],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]!.payload).toEqual({ queueVersion: 1, token: 'A-001' });
    expect(
      (await t.pool.query(`SELECT queue_version FROM sessions WHERE id = $1`, [s.id])).rows[0]!.queue_version,
    ).toBe(1);
    // The no-show timer is no longer needed.
    expect(
      (await t.pool.query(`SELECT state FROM jobs WHERE dedupe_key = $1`, [`reservation_release:${appt.id}`])).rows[0]!
        .state,
    ).toBe('cancelled');
  });

  it('FR-05-a: a repeated check-in, even with a different key, returns the same visit and entry', async () => {
    const s = await makeSession(admin);
    const appt = await bookFor(s, patientId(12));
    t.clock.set(at(s, 0));
    const first = await reception.post(`/appointments/${appt.id}/check-in`, {});
    const again = await reception.post(`/appointments/${appt.id}/check-in`, {}, randomUUID());
    const sameKey = await reception.post(`/appointments/${appt.id}/check-in`, {}, 'fixed-key-123456');
    const sameKeyAgain = await reception.post(`/appointments/${appt.id}/check-in`, {}, 'fixed-key-123456');
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    for (const r of [again, sameKey, sameKeyAgain]) {
      expect(r.body.visitId).toBe(first.body.visitId);
      expect(r.body.queueEntryId).toBe(first.body.queueEntryId);
      expect(r.body.token).toBe('A-001');
    }
    expect(sameKeyAgain.headers['idempotency-replayed']).toBe('true');
    expect(await count(t.pool, `SELECT 1 FROM visits WHERE appointment_id = $1`, [appt.id])).toBe(1);
    expect(await count(t.pool, `SELECT 1 FROM queue_entries WHERE visit_id = $1`, [first.body.visitId])).toBe(1);
    expect(
      (await t.pool.query(`SELECT next_seq_a, queue_version FROM sessions WHERE id = $1`, [s.id])).rows[0],
    ).toMatchObject({ next_seq_a: 2, queue_version: 1 });
    expect(
      await count(t.pool, `SELECT 1 FROM outbox_events WHERE event_type = 'VisitCheckedIn' AND entity_id = $1`, [
        first.body.visitId,
      ]),
    ).toBe(1);
  });

  it('parallel check-ins of one appointment under different keys produce a single visit', async () => {
    const s = await makeSession(admin);
    const appt = await bookFor(s, patientId(12));
    t.clock.set(at(s, 0));
    const results = await Promise.all(
      Array.from({ length: 6 }, () => reception.post(`/appointments/${appt.id}/check-in`, {})),
    );
    expect(results.some((r) => r.status >= 500)).toBe(false);
    expect(new Set(results.map((r) => r.body.visitId)).size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await count(t.pool, `SELECT 1 FROM visits WHERE appointment_id = $1`, [appt.id])).toBe(1);
  });

  it('tokens and sequence numbers follow check-in order, per group and per session', async () => {
    const s = await makeSession(admin);
    const a1 = await bookFor(s, patientId(12));
    const a2 = await bookFor(s, patientId(13));
    t.clock.set(at(s, 0));
    const r2 = await reception.post(`/appointments/${a2.id}/check-in`, {});
    const w1 = await reception.post(`/sessions/${s.id}/walk-ins`, { patientId: await newPatient(reception) });
    const r1 = await reception.post(`/appointments/${a1.id}/check-in`, {});
    expect([r2.body.token, w1.body.token, r1.body.token]).toEqual(['A-001', 'W-001', 'A-002']);
    const seqs = await t.pool.query(`SELECT token, seq FROM queue_entries WHERE session_id = $1 ORDER BY seq`, [s.id]);
    expect(seqs.rows).toEqual([
      { token: 'A-001', seq: 1 },
      { token: 'W-001', seq: 2 },
      { token: 'A-002', seq: 3 },
    ]);
  });

  it('an early arrival is eligible ten minutes before the slot, not at check-in', async () => {
    const s = await makeSession(admin);
    const appt = await bookFor(s, patientId(12));
    t.clock.set(at(s, -60));
    const res = await reception.post(`/appointments/${appt.id}/check-in`, {});
    expect(res.status).toBe(201);
    expect(new Date(res.body.eligibleAt).getTime()).toBe(at(s, -10).getTime());
  });

  it('FR-05-b: 20 minutes after the slot needs review; admitLate takes a walk-in place and frees the booked one', async () => {
    const s = await makeSession(admin, { booked: 5, walkin: 2 });
    const appt = await bookFor(s, patientId(12));
    t.clock.set(at(s, 20));

    const refused = await reception.post(`/appointments/${appt.id}/check-in`, {});
    expect(refused.status).toBe(409);
    expect(ApiError.parse(refused.body).error.code).toBe('LATE_ARRIVAL_REQUIRES_REVIEW');
    expect(refused.body.error.details.minutesLate).toBe(20);
    expect(await count(t.pool, `SELECT 1 FROM visits WHERE appointment_id = $1`, [appt.id])).toBe(0);
    expect(await capacityOf(t.pool, s.id)).toMatchObject({ booked_reserved: 1, walkin_used: 0 });
    expect(Appointment.parse((await reception.get(`/appointments/${appt.id}`)).body).status).toBe('booked');

    const admitted = await reception.post(`/appointments/${appt.id}/check-in`, { admitLate: true });
    expect(admitted.status).toBe(201);
    const arrival = ArrivalResult.parse(admitted.body);
    expect(arrival).toMatchObject({ group: 'W', kind: 'late_admission', token: 'W-001' });
    expect(new Date(arrival.eligibleAt).getTime()).toBe(at(s, 20).getTime()); // walk-in ordering: eligible on acceptance
    expect(await capacityOf(t.pool, s.id)).toMatchObject({ booked_reserved: 0, walkin_used: 1 });
    expect((await capacityInvariant(t.pool, s.id)).ok).toBe(true);
    const visit = await t.pool.query(
      `SELECT kind, appointment_id, (SELECT kind FROM capacity_allocations WHERE id = allocation_id) AS alloc_kind FROM visits WHERE id = $1`,
      [arrival.visitId],
    );
    expect(visit.rows[0]).toMatchObject({ kind: 'late_admission', appointment_id: appt.id, alloc_kind: 'walkin' });
    expect(Appointment.parse((await reception.get(`/appointments/${appt.id}`)).body).status).toBe('checked_in');
    const audit = await t.pool.query(
      `SELECT reason FROM audit_events WHERE operation = 'visit.check_in' AND entity_id = $1`,
      [arrival.visitId],
    );
    expect(audit.rows[0]!.reason).toMatch(/late/);
  });

  it('late admission with no walk-in place left is CAPACITY_FULL and changes nothing', async () => {
    const s = await makeSession(admin, { booked: 5, walkin: 0 });
    const appt = await bookFor(s, patientId(12));
    t.clock.set(at(s, 40));
    const res = await reception.post(`/appointments/${appt.id}/check-in`, { admitLate: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAPACITY_FULL');
    expect(await capacityOf(t.pool, s.id)).toMatchObject({ booked_reserved: 1, walkin_used: 0 });
    expect(await count(t.pool, `SELECT 1 FROM visits WHERE session_id = $1`, [s.id])).toBe(0);
  });

  it('exactly at the 15 minute grace the arrival is still on time', async () => {
    const s = await makeSession(admin);
    const appt = await bookFor(s, patientId(12));
    t.clock.set(at(s, 15));
    const res = await reception.post(`/appointments/${appt.id}/check-in`, {});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ group: 'A', kind: 'appointment' });
    expect(new Date(res.body.eligibleAt).getTime()).toBe(at(s, 15).getTime());
  });

  it('rejects other days, closed sessions and appointments that are not booked', async () => {
    const s = await makeSession(admin);
    const appt = await bookFor(s, patientId(12));
    // Day before the session.
    t.clock.set(at(s, -24 * 60));
    const early = await reception.post(`/appointments/${appt.id}/check-in`, {});
    expect(early.status).toBe(409);

    t.clock.set(at(s, 0));
    await t.pool.query(`UPDATE sessions SET status = 'closed' WHERE id = $1`, [s.id]);
    const closed = await reception.post(`/appointments/${appt.id}/check-in`, {});
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('SESSION_NOT_CALLABLE');
    await t.pool.query(`UPDATE sessions SET status = 'open' WHERE id = $1`, [s.id]);

    t.clock.reset();
    const other = await bookFor(s, patientId(13));
    expect((await reception.post(`/appointments/${other.id}/cancel`, {})).status).toBe(200);
    t.clock.set(at(s, 0));
    const cancelled = await reception.post(`/appointments/${other.id}/check-in`, {});
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.error.code).toBe('INVALID_TRANSITION');
    expect((await reception.post(`/appointments/${randomUUID()}/check-in`, {})).status).toBe(404);
    expect((await reception.post(`/appointments/${appt.id}/check-in`, {}, null)).status).toBe(400);
  });

  it('FR-04-c: after check-in the appointment cannot be cancelled or rescheduled and the allocation stays consumed', async () => {
    const s = await makeSession(admin);
    const other = await makeSession(admin);
    const patientClient = await loginAs(t.server, 'patient2@hqms.test');
    const appt = (await patientClient.post('/appointments', { sessionId: s.id })).body as Appointment;
    t.clock.set(at(s, 0));
    expect((await reception.post(`/appointments/${appt.id}/check-in`, {})).status).toBe(201);
    const before = await capacityOf(t.pool, s.id);

    const cancel = await patientClient.post(`/appointments/${appt.id}/cancel`, {});
    expect(cancel.status).toBe(409);
    expect(cancel.body.error.code).toBe('INVALID_TRANSITION');
    const move = await patientClient.post(`/appointments/${appt.id}/reschedule`, { targetSessionId: other.id });
    expect(move.status).toBe(409);
    expect(move.body.error.code).toBe('INVALID_TRANSITION');

    expect(await capacityOf(t.pool, s.id)).toEqual(before);
    expect(before.booked_reserved).toBe(1);
    const alloc = await t.pool.query(
      `SELECT state FROM capacity_allocations WHERE id = (SELECT allocation_id FROM appointments WHERE id = $1)`,
      [appt.id],
    );
    expect(alloc.rows[0]!.state).toBe('consumed');
    expect((await capacityOf(t.pool, other.id)).booked_reserved).toBe(0);
  });
  it('FR-04-c: after the visit is COMPLETED the appointment cannot be cancelled or rescheduled and the allocation stays consumed', async () => {
    const doctor = await loginAs(t.server, 'doctor9@hqms.test');
    await t.pool.query(
      `UPDATE queue_entries SET state = 'skipped', skipped_at = now() WHERE doctor_id = $1 AND state IN ('called','in_service')`,
      [doctorId(9)],
    );
    const s = await makeSession(admin, { doctor: 9 });
    const other = await makeSession(admin, { doctor: 9 });
    const patientClient = await loginAs(t.server, 'patient3@hqms.test');
    t.clock.reset();
    const appt = (await patientClient.post('/appointments', { sessionId: s.id })).body as Appointment;
    t.clock.set(at(s, 0));
    expect((await reception.post(`/appointments/${appt.id}/check-in`, {})).status).toBe(201);
    const called = await doctor.post(`/sessions/${s.id}/call-next`, {});
    expect(called.status).toBe(200);
    const visitId = called.body.entry.visitId as string;
    t.clock.set(at(s, 1));
    expect((await doctor.post(`/visits/${visitId}/start`, {})).status).toBe(200);
    t.clock.set(at(s, 9));
    expect((await doctor.post(`/visits/${visitId}/complete`, {})).status).toBe(200);
    expect((await t.pool.query(`SELECT status FROM appointments WHERE id = $1`, [appt.id])).rows[0]!.status).toBe('completed');
    const before = await capacityOf(t.pool, s.id);
    const otherBefore = await capacityOf(t.pool, other.id);

    for (const caller of [patientClient, reception, admin]) {
      const cancel = await caller.post(`/appointments/${appt.id}/cancel`, {});
      expect(cancel.status).toBe(409);
      expect(cancel.body.error.code).toBe('INVALID_TRANSITION');
    }
    const move = await patientClient.post(`/appointments/${appt.id}/reschedule`, { targetSessionId: other.id });
    expect(move.status).toBe(409);
    expect(move.body.error.code).toBe('INVALID_TRANSITION');

    // Nothing moved: the place stays consumed, the counters are unchanged, the target session got nothing.
    expect(await capacityOf(t.pool, s.id)).toEqual(before);
    expect(await capacityOf(t.pool, other.id)).toEqual(otherBefore);
    const alloc = await t.pool.query(
      `SELECT state FROM capacity_allocations WHERE id = (SELECT allocation_id FROM appointments WHERE id = $1)`,
      [appt.id],
    );
    expect(alloc.rows[0]!.state).toBe('consumed');
    expect((await t.pool.query(`SELECT status FROM appointments WHERE id = $1`, [appt.id])).rows[0]!.status).toBe('completed');
    // The release timer was cancelled at check-in: no pending reservation_release can free the place.
    expect(await count(t.pool, `SELECT 1 FROM jobs WHERE dedupe_key = $1 AND state IN ('pending','running')`, [`reservation_release:${appt.id}`])).toBe(0);
  });

});

describe('FR-05 walk-ins', () => {
  it('FR-05-c: five walk-ins fill the walk-in places; the sixth is CAPACITY_FULL', async () => {
    const s = await makeSession(admin, { booked: 10, walkin: 5 });
    t.clock.set(at(s, 30));
    const tokens: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await reception.post(`/sessions/${s.id}/walk-ins`, { patientId: patientId(15 + i) });
      expect(res.status).toBe(201);
      const arrival = ArrivalResult.parse(res.body);
      expect(arrival).toMatchObject({ group: 'W', kind: 'walkin' });
      expect(new Date(arrival.eligibleAt).getTime()).toBe(at(s, 30).getTime());
      tokens.push(arrival.token);
    }
    expect(tokens).toEqual(['W-001', 'W-002', 'W-003', 'W-004', 'W-005']);

    const sixth = await reception.post(`/sessions/${s.id}/walk-ins`, { patientId: patientId(20) });
    expect(sixth.status).toBe(409);
    expect(sixth.body.error.code).toBe('CAPACITY_FULL');
    expect(await capacityOf(t.pool, s.id)).toMatchObject({ walkin_used: 5, booked_reserved: 0 });
    expect(await count(t.pool, `SELECT 1 FROM queue_entries WHERE session_id = $1`, [s.id])).toBe(5);
    expect(await count(t.pool, `SELECT 1 FROM visits WHERE session_id = $1`, [s.id])).toBe(5);
    expect((await capacityInvariant(t.pool, s.id)).ok).toBe(true);
    // Walk-ins do not touch booked capacity.
    expect((await reception.post('/appointments', { sessionId: s.id, patientId: patientId(20) })).status).toBe(201);
  });

  it('a patient with a live place in the session cannot be admitted twice; a retry with the same key replays', async () => {
    const s = await makeSession(admin);
    t.clock.set(at(s, 0));
    const p = await newPatient(reception);
    const key = randomUUID();
    const first = await reception.post(`/sessions/${s.id}/walk-ins`, { patientId: p }, key);
    const replay = await reception.post(`/sessions/${s.id}/walk-ins`, { patientId: p }, key);
    expect(first.status).toBe(201);
    expect(replay.body.visitId).toBe(first.body.visitId);
    const dup = await reception.post(`/sessions/${s.id}/walk-ins`, { patientId: p });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT');
    expect(await count(t.pool, `SELECT 1 FROM visits WHERE session_id = $1`, [s.id])).toBe(1);
    expect((await capacityOf(t.pool, s.id)).walkin_used).toBe(1);
  });

  it('parallel walk-ins never exceed the walk-in capacity', async () => {
    const s = await makeSession(admin, { walkin: 3 });
    t.clock.set(at(s, 0));
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        reception.post(`/sessions/${s.id}/walk-ins`, { patientId: patientId(20 + i) }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409 && r.body.error.code === 'CAPACITY_FULL')).toHaveLength(5);
    const tokens = (
      await t.pool.query<{ token: string }>(`SELECT token FROM queue_entries WHERE session_id = $1 ORDER BY seq`, [
        s.id,
      ])
    ).rows.map((r) => r.token);
    expect(tokens).toEqual(['W-001', 'W-002', 'W-003']);
  });

  it('validates the request and the session', async () => {
    const s = await makeSession(admin);
    t.clock.set(at(s, 0));
    expect((await reception.post(`/sessions/${s.id}/walk-ins`, {})).status).toBe(400);
    expect((await reception.post(`/sessions/${s.id}/walk-ins`, { patientId: patientId(20) }, null)).status).toBe(400);
    expect((await reception.post(`/sessions/${randomUUID()}/walk-ins`, { patientId: patientId(20) })).status).toBe(404);
    expect((await reception.post(`/sessions/${s.id}/walk-ins`, { patientId: randomUUID() })).status).toBe(404);
    t.clock.set(at(s, 24 * 60));
    expect((await reception.post(`/sessions/${s.id}/walk-ins`, { patientId: patientId(20) })).status).toBe(409);
    t.clock.set(at(s, 0));
    await t.pool.query(`UPDATE sessions SET status = 'unavailable' WHERE id = $1`, [s.id]);
    const res = await reception.post(`/sessions/${s.id}/walk-ins`, { patientId: patientId(20) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SESSION_NOT_CALLABLE');
  });
});
