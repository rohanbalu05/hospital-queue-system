/**
 * T1 / FR-05: repeated and competing arrivals.
 *  - 10 parallel check-ins of one appointment (different keys) -> one visit, one queue entry, one token;
 *  - 20 parallel walk-in admissions into a session with 5 walk-in places -> exactly 5 succeed;
 *  - the same patient admitted twice at once -> one place.
 * Uses sessions dated today (hospital-local) whose first slot is 60+ minutes ahead, because arrivals are
 * only accepted on the session's own day.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiClient } from '../support/client.js';
import { recordResult } from '../support/results.js';
import {
  capacityCounts,
  checkGlobalInvariants,
  closePool,
  loginAs,
  makeTodaySession,
  registerPatients,
  sqlRows,
  tally,
} from '../support/world.js';

let admin: ApiClient;
let reception: ApiClient;
let patients: string[];
const record: Record<string, unknown> = {};

beforeAll(async () => {
  admin = await loginAs('admin@hqms.test');
  reception = await loginAs('reception@hqms.test');
  patients = await registerPatients(reception, 80, 'T1 Arrival');
}, 120_000);

afterAll(async () => {
  const invariants = await checkGlobalInvariants();
  recordResult('t1CheckIn', { ...record, globalInvariantViolations: invariants.violations });
  await closePool();
});

describe('T1 check-in and walk-in races', () => {
  it('10 parallel check-ins (distinct keys) of one appointment: one visit, one queue entry, one token', async () => {
    const trials = 5;
    const perTrial: Array<Record<string, unknown>> = [];
    for (let i = 0; i < trials; i += 1) {
      const session = await makeTodaySession(admin, { booked: 5, walkin: 2 });
      const appt = await reception.post('/appointments', { sessionId: session.id, patientId: patients[i] });
      expect(appt.status).toBe(201);

      const results = await Promise.all(
        Array.from({ length: 10 }, () => reception.post(`/appointments/${appt.body.id}/check-in`, {})),
      );
      const t = tally(results);
      expect(t.serverErrors).toBe(0);
      expect(results.filter((x) => x.status === 201)).toHaveLength(1);
      expect(results.filter((x) => x.status === 200)).toHaveLength(9);
      const tokens = new Set(results.map((x) => x.body.token));
      const visits = new Set(results.map((x) => x.body.visitId));
      const entries = new Set(results.map((x) => x.body.queueEntryId));
      expect(tokens.size).toBe(1);
      expect(visits.size).toBe(1);
      expect(entries.size).toBe(1);

      const v = await sqlRows(`SELECT id FROM visits WHERE appointment_id = $1`, [appt.body.id]);
      const q = await sqlRows(`SELECT token, queue_group FROM queue_entries WHERE visit_id = $1`, [
        results[0]?.body.visitId,
      ]);
      const sessionEntries = await sqlRows(`SELECT token FROM queue_entries WHERE session_id = $1`, [session.id]);
      const audit = await sqlRows(`SELECT 1 FROM audit_events WHERE operation = 'visit.check_in' AND entity_id = $1`, [
        results[0]?.body.visitId,
      ]);
      expect(v).toHaveLength(1);
      expect(q).toHaveLength(1);
      expect(q[0]?.['token']).toBe([...tokens][0]);
      expect(sessionEntries).toHaveLength(1);
      expect(audit).toHaveLength(1);
      const counts = await capacityCounts(session.id);
      expect(counts.booked_reserved).toBe(counts.booked_allocations);
      perTrial.push({
        trial: i + 1,
        created201: 1,
        existing200: 9,
        distinctTokens: tokens.size,
        visits: v.length,
        queueEntries: sessionEntries.length,
        auditRows: audit.length,
      });
    }
    record['repeatedCheckIn'] = { trials, requestsPerTrial: 10, perTrial };
  }, 120_000);

  it('20 parallel walk-in admissions into 5 walk-in places: exactly 5 succeed with distinct tokens', async () => {
    const rounds = 3;
    const perRound: Array<Record<string, unknown>> = [];
    for (let r = 0; r < rounds; r += 1) {
      const session = await makeTodaySession(admin, { booked: 5, walkin: 5 });
      const racers = patients.slice(10 + r * 20, 30 + r * 20);
      const results = await Promise.all(
        racers.map((pid) => reception.post(`/sessions/${session.id}/walk-ins`, { patientId: pid })),
      );
      const t = tally(results);
      const winners = results.filter((x) => x.status === 201);
      expect(t.serverErrors).toBe(0);
      expect(winners).toHaveLength(5);
      expect(t.byCode['CAPACITY_FULL']).toBe(15);
      const tokens = winners.map((x) => x.body.token as string).sort();
      expect(new Set(tokens).size).toBe(5);
      expect(tokens).toEqual(['W-001', 'W-002', 'W-003', 'W-004', 'W-005']);
      const counts = await capacityCounts(session.id);
      expect(counts.walkin_used).toBe(5);
      expect(counts.walkin_allocations).toBe(5);
      expect(await sqlRows(`SELECT 1 FROM queue_entries WHERE session_id = $1`, [session.id])).toHaveLength(5);
      expect(await sqlRows(`SELECT 1 FROM visits WHERE session_id = $1`, [session.id])).toHaveLength(5);
      perRound.push({
        round: r + 1,
        requests: 20,
        created201: winners.length,
        capacityFull409: t.byCode['CAPACITY_FULL'],
        tokens,
      });
    }
    record['walkInRace'] = { rounds, perRound };
  }, 120_000);

  it('the same patient admitted as a walk-in twice at once takes one place (second call is 409)', async () => {
    const session = await makeTodaySession(admin, { booked: 5, walkin: 5 });
    const pid = patients[70] as string;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => reception.post(`/sessions/${session.id}/walk-ins`, { patientId: pid })),
    );
    const t = tally(results);
    expect(t.serverErrors).toBe(0);
    expect(results.filter((x) => x.status === 201)).toHaveLength(1);
    expect(t.byStatus['409']).toBe(5);
    const counts = await capacityCounts(session.id);
    expect(counts.walkin_used).toBe(1);
    expect(
      await sqlRows(`SELECT 1 FROM visits WHERE session_id = $1 AND patient_id = $2`, [session.id, pid]),
    ).toHaveLength(1);
    record['samePatientWalkInTwice'] = { requests: 6, statuses: t.byStatus };
  }, 60_000);

  it('check-in racing walk-in admissions on a full walk-in pool never overbooks either pool', async () => {
    const session = await makeTodaySession(admin, { booked: 5, walkin: 3 });
    const booked = await Promise.all(
      patients.slice(40, 45).map((pid) => reception.post('/appointments', { sessionId: session.id, patientId: pid })),
    );
    expect(booked.map((b) => b.status)).toEqual(Array(5).fill(201));
    const calls = [
      ...booked.map((b) => reception.post(`/appointments/${b.body.id}/check-in`, {})),
      ...patients.slice(50, 60).map((pid) => reception.post(`/sessions/${session.id}/walk-ins`, { patientId: pid })),
    ];
    const results = await Promise.all(calls);
    const t = tally(results);
    expect(t.serverErrors).toBe(0);
    expect(results.slice(0, 5).every((x) => x.status === 201)).toBe(true); // on-time check-ins take their own reservation
    expect(results.slice(5).filter((x) => x.status === 201)).toHaveLength(3);
    const counts = await capacityCounts(session.id);
    expect(counts.booked_reserved).toBe(5);
    expect(counts.walkin_used).toBe(3);
    expect(counts.booked_allocations).toBe(5);
    expect(counts.walkin_allocations).toBe(3);
    record['checkInVersusWalkIn'] = { checkIns: 5, walkInRequests: 10, walkInSucceeded: 3, statuses: t.byStatus };
  }, 60_000);
});
