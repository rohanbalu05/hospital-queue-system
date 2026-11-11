/**
 * T1 / FR-04: reschedule is an atomic exchange of reservations.
 *  - into a full session: 409 and nothing changes;
 *  - 10 appointments racing for one place: exactly one moves, nine stay untouched;
 *  - reschedule racing with cancel of the same appointment: never both effects.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiClient, type ApiResponse } from '../support/client.js';
import { recordResult } from '../support/results.js';
import {
  appointmentSnapshot,
  capacityCounts,
  checkGlobalInvariants,
  closePool,
  loginAs,
  makeFutureSession,
  registerPatients,
  sqlRows,
  tally,
} from '../support/world.js';

let admin: ApiClient;
let reception: ApiClient;
let selfClients: ApiClient[];
let patients: string[];
const record: Record<string, unknown> = {};

beforeAll(async () => {
  admin = await loginAs('admin@hqms.test');
  reception = await loginAs('reception@hqms.test');
  selfClients = await Promise.all(
    Array.from({ length: 10 }, (_, i) => loginAs(i === 0 ? 'patient@hqms.test' : `patient${i + 1}@hqms.test`)),
  );
  patients = await registerPatients(reception, 40, 'T1 Resched');
}, 120_000);

afterAll(async () => {
  const invariants = await checkGlobalInvariants();
  recordResult('t1Reschedule', { ...record, globalInvariantViolations: invariants.violations });
  await closePool();
});

async function counts(sessionId: string) {
  const c = await capacityCounts(sessionId);
  return { reserved: c.booked_reserved, allocations: c.booked_allocations, capacity: c.booked_capacity };
}

async function sideEffectRows(sessionIds: string[]) {
  const [audit] = await sqlRows<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_events WHERE entity_type = 'appointment' AND entity_id IN
       (SELECT id FROM appointments WHERE session_id = ANY($1::uuid[]))`,
    [sessionIds],
  );
  const [outbox] = await sqlRows<{ n: number }>(
    `SELECT count(*)::int AS n FROM outbox_events WHERE session_id = ANY($1::uuid[])`,
    [sessionIds],
  );
  const [appts] = await sqlRows<{ n: number }>(
    `SELECT count(*)::int AS n FROM appointments WHERE session_id = ANY($1::uuid[])`,
    [sessionIds],
  );
  return { audit: audit?.n, outbox: outbox?.n, appointments: appts?.n };
}

describe('T1 reschedule', () => {
  it('rescheduling into a full session is a 409 and leaves appointment, allocation, audit and outbox untouched', async () => {
    const attempts = 10;
    for (let i = 0; i < attempts; i += 1) {
      const from = await makeFutureSession(admin, { booked: 5, doctor: 1 });
      const to = await makeFutureSession(admin, { booked: 1, doctor: 2 });
      const mine = await reception.post('/appointments', { sessionId: from.id, patientId: patients[i] });
      const filler = await reception.post('/appointments', { sessionId: to.id, patientId: patients[20 + i] });
      expect(mine.status).toBe(201);
      expect(filler.status).toBe(201);

      const before = await appointmentSnapshot(mine.body.id);
      const fillerBefore = await appointmentSnapshot(filler.body.id);
      const sideBefore = await sideEffectRows([from.id, to.id]);
      const cFromBefore = await counts(from.id);
      const cToBefore = await counts(to.id);

      const res = await reception.post(`/appointments/${mine.body.id}/reschedule`, { targetSessionId: to.id });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CAPACITY_FULL');

      expect(await appointmentSnapshot(mine.body.id)).toEqual(before);
      expect(await appointmentSnapshot(filler.body.id)).toEqual(fillerBefore);
      expect(await sideEffectRows([from.id, to.id])).toEqual(sideBefore);
      expect(await counts(from.id)).toEqual(cFromBefore);
      expect(await counts(to.id)).toEqual(cToBefore);
      expect(before?.['status']).toBe('booked');
      expect(before?.['allocation_state']).toBe('reserved');
    }
    record['intoFullSession'] = { attempts, allConflict: true, rowSnapshotsEqual: true };
  }, 120_000);

  it('10 appointments race to reschedule into a session with one place: exactly one moves, nine are untouched', async () => {
    const rounds = 5;
    const perRound: Array<Record<string, unknown>> = [];
    for (let r = 0; r < rounds; r += 1) {
      const from = await makeFutureSession(admin, { booked: 10, doctor: 1 });
      const to = await makeFutureSession(admin, { booked: 1, doctor: 2 });
      // Each of the 10 login patients books in `from` themselves.
      const booked = await Promise.all(selfClients.map((c) => c.post('/appointments', { sessionId: from.id })));
      expect(booked.map((b) => b.status)).toEqual(Array(10).fill(201));
      const ids: string[] = booked.map((b) => b.body.id);
      const before = new Map(await Promise.all(ids.map(async (id) => [id, await appointmentSnapshot(id)] as const)));

      const results: ApiResponse[] = await Promise.all(
        selfClients.map((c, i) => c.post(`/appointments/${ids[i]}/reschedule`, { targetSessionId: to.id })),
      );
      const t = tally(results);
      const winners = results.map((x, i) => [x, i] as const).filter(([x]) => x.status === 201);
      expect(t.serverErrors).toBe(0);
      expect(winners).toHaveLength(1);
      expect(t.byCode['CAPACITY_FULL']).toBe(9);

      const winnerIdx = winners[0]?.[1] as number;
      for (let i = 0; i < 10; i += 1) {
        const after = await appointmentSnapshot(ids[i] as string);
        if (i === winnerIdx) {
          expect(after?.['status']).toBe('rescheduled');
          expect(after?.['allocation_state']).toBe('released');
        } else {
          expect(after).toEqual(before.get(ids[i] as string));
        }
      }
      const cFrom = await counts(from.id);
      const cTo = await counts(to.id);
      expect(cFrom.reserved).toBe(9);
      expect(cFrom.allocations).toBe(9);
      expect(cTo.reserved).toBe(1);
      expect(cTo.allocations).toBe(1);
      const inTo = await sqlRows(`SELECT id, status FROM appointments WHERE session_id = $1`, [to.id]);
      expect(inTo).toHaveLength(1);
      perRound.push({
        round: r + 1,
        successes: winners.length,
        capacityFull: t.byCode['CAPACITY_FULL'],
        serverErrors: t.serverErrors,
        sourceReservedAfter: cFrom.reserved,
        targetReservedAfter: cTo.reserved,
      });
    }
    record['tenRaceOnePlace'] = { rounds, perRound };
  }, 180_000);

  it('reschedule racing with cancel of the same appointment never applies both', async () => {
    const trials = 20;
    const outcomes = { rescheduleWon: 0, cancelWon: 0 };
    let serverErrors = 0;
    for (let i = 0; i < trials; i += 1) {
      // Different doctors for source and target, to exercise the doctor -> session -> capacity ordering.
      const from = await makeFutureSession(admin, { booked: 5, doctor: 1 });
      const to = await makeFutureSession(admin, { booked: 5, doctor: 2 });
      const appt = await reception.post('/appointments', { sessionId: from.id, patientId: patients[i] });
      expect(appt.status).toBe(201);

      const [resched, cancel] = await Promise.all([
        reception.post(`/appointments/${appt.body.id}/reschedule`, { targetSessionId: to.id }),
        reception.post(`/appointments/${appt.body.id}/cancel`, { reason: 'race' }),
      ]);
      serverErrors += tally([resched, cancel]).serverErrors;
      const reschedOk = resched.status === 201;
      const cancelOk = cancel.status === 200;
      expect(reschedOk !== cancelOk, `trial ${i + 1}: reschedule ${resched.status}, cancel ${cancel.status}`).toBe(
        true,
      );
      expect(reschedOk ? cancel.status : resched.status).toBe(409);

      const cFrom = await counts(from.id);
      const cTo = await counts(to.id);
      expect(cFrom.reserved).toBe(cFrom.allocations);
      expect(cTo.reserved).toBe(cTo.allocations);
      expect(cFrom.reserved).toBe(0); // the original place is released either way
      const original = await appointmentSnapshot(appt.body.id);
      if (reschedOk) {
        outcomes.rescheduleWon += 1;
        expect(original?.['status']).toBe('rescheduled');
        expect(cTo.reserved).toBe(1);
        expect(
          await sqlRows(`SELECT 1 FROM appointments WHERE session_id = $1 AND status = 'booked'`, [to.id]),
        ).toHaveLength(1);
      } else {
        outcomes.cancelWon += 1;
        expect(original?.['status']).toBe('cancelled');
        expect(cTo.reserved).toBe(0);
        expect(await sqlRows(`SELECT 1 FROM appointments WHERE session_id = $1`, [to.id])).toHaveLength(0);
      }
    }
    expect(serverErrors).toBe(0);
    record['rescheduleVsCancel'] = { trials, ...outcomes, serverErrors, bothAppliedOrNeither: 0 };
  }, 180_000);
});
