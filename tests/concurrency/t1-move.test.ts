/**
 * T1 / B3 (D-033): bulk move and transfer of affected patients, real PostgreSQL, real parallel connections.
 *
 * Two staff members (reception and admin) move OVERLAPPING sets of checked-in patients from an unavailable doctor's
 * session into a target session that has only 2 free booked places, at the same moment. Whatever the interleaving:
 *  - the target is never over-allocated (exactly 2 places taken, counters equal the allocation rows);
 *  - each patient is moved at most once (one new entry per old visit, old entry cancelled, old visit transferred);
 *  - nothing answers 5xx; losing items are skipped with a controlled code, never a 500.
 * The same race is also run with appointments (booked) in the move set.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiClient } from '../support/client.js';
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

beforeAll(async () => {
  admin = await loginAs('admin@hqms.test');
  reception = await loginAs('reception@hqms.test');
  patients = await registerPatients(reception, 60, 'T1 Move');
}, 120_000);

afterAll(async () => {
  const invariants = await checkGlobalInvariants();
  expect(invariants.violations).toEqual([]);
  await closePool();
});

interface MoveResult {
  moved: number;
  skipped: number;
  results: Array<{
    kind: string;
    sourceId: string;
    outcome: 'moved' | 'skipped';
    code: string | null;
    newQueueEntryId: string | null;
    newAppointmentId: string | null;
  }>;
}

/** Source session (doctor 1) with `n` booked-and-checked-in patients; returns their queue entry ids. */
async function checkedInSource(first: number, n: number) {
  const S = await makeTodaySession(admin, { doctor: 1, booked: 10, walkin: 5 });
  const entries: string[] = [];
  const appts: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const appt = await reception.post('/appointments', { sessionId: S.id, patientId: patients[first + i] });
    expect(appt.status).toBe(201);
    appts.push(appt.body.id);
  }
  for (const id of appts) {
    const ci = await reception.post(`/appointments/${id}/check-in`, {});
    expect(ci.status).toBe(201);
    entries.push(ci.body.queueEntryId);
  }
  return { S, entries, appts };
}

describe('T1 bulk move and transfer', () => {
  it('two staff move overlapping sets into a target with 2 free places: no over-allocation, nobody moved twice', async () => {
    const rounds = 6;
    for (let r = 0; r < rounds; r += 1) {
      const { S, entries } = await checkedInSource(r * 6, 6);
      const T = await makeTodaySession(admin, { doctor: 2, booked: 2, walkin: 0 });
      const away = await reception.post(`/sessions/${S.id}/unavailable`, { reason: 'T1 race' });
      expect(away.status).toBe(200);

      const setA = entries.slice(0, 4); // e0..e3
      const setB = entries.slice(2, 6); // e2..e5 (e2 and e3 overlap)
      const [ra, rb] = await Promise.all([
        reception.post(`/sessions/${S.id}/affected/move`, { targetSessionId: T.id, queueEntryIds: setA }),
        admin.post(`/sessions/${S.id}/affected/move`, { targetSessionId: T.id, queueEntryIds: setB }),
      ]);
      const t = tally([ra, rb]);
      expect(t.serverErrors, JSON.stringify([ra.body, rb.body])).toBe(0);
      expect(ra.status).toBe(200);
      expect(rb.status).toBe(200);
      const a = ra.body as MoveResult;
      const b = rb.body as MoveResult;

      expect(a.moved + b.moved).toBe(2);
      for (const item of [...a.results, ...b.results]) {
        if (item.outcome === 'skipped')
          expect(['CAPACITY_FULL', 'INVALID_TRANSITION', 'CONFLICT']).toContain(item.code);
      }

      const cap = await capacityCounts(T.id);
      expect(cap.booked_reserved).toBe(2);
      expect(cap.booked_allocations).toBe(2);

      const moved = await sqlRows<{ old_entry: string; n: number }>(
        `SELECT oq.id AS old_entry, count(nq.id)::int AS n
           FROM queue_entries oq
           JOIN visits ov ON ov.id = oq.visit_id
           LEFT JOIN visits nv ON nv.transferred_from_visit_id = ov.id
           LEFT JOIN queue_entries nq ON nq.visit_id = nv.id
          WHERE oq.id = ANY($1::uuid[]) GROUP BY oq.id`,
        [entries],
      );
      for (const row of moved) expect(row.n).toBeLessThanOrEqual(1);
      expect(moved.reduce((s, x) => s + x.n, 0)).toBe(2);

      const states = await sqlRows<{ state: string; vstatus: string }>(
        `SELECT oq.state, ov.status AS vstatus FROM queue_entries oq JOIN visits ov ON ov.id = oq.visit_id WHERE oq.id = ANY($1::uuid[])`,
        [entries],
      );
      expect(states.filter((s) => s.state === 'cancelled' && s.vstatus === 'transferred')).toHaveLength(2);
      expect(states.filter((s) => s.state === 'waiting' && s.vstatus === 'open')).toHaveLength(4);
      const inTarget = await sqlRows(`SELECT id FROM queue_entries WHERE session_id = $1`, [T.id]);
      expect(inTarget).toHaveLength(2);
    }
  }, 240_000);

  it('the same race with booked appointments in the move set: a place is taken at most once per patient', async () => {
    const rounds = 4;
    for (let r = 0; r < rounds; r += 1) {
      const S = await makeTodaySession(admin, { doctor: 1, booked: 10, walkin: 5 });
      const appts: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const res = await reception.post('/appointments', { sessionId: S.id, patientId: patients[36 + r * 6 + i] });
        expect(res.status).toBe(201);
        appts.push(res.body.id);
      }
      const T = await makeTodaySession(admin, { doctor: 2, booked: 2, walkin: 0 });
      expect((await reception.post(`/sessions/${S.id}/unavailable`, { reason: 'Doctor unwell' })).status).toBe(200);

      const [ra, rb] = await Promise.all([
        reception.post(`/sessions/${S.id}/affected/move`, { targetSessionId: T.id, appointmentIds: appts.slice(0, 4) }),
        admin.post(`/sessions/${S.id}/affected/move`, { targetSessionId: T.id, appointmentIds: appts.slice(2, 6) }),
      ]);
      expect(tally([ra, rb]).serverErrors, JSON.stringify([ra.body, rb.body])).toBe(0);
      expect((ra.body as MoveResult).moved + (rb.body as MoveResult).moved).toBe(2);
      const cap = await capacityCounts(T.id);
      expect(cap.booked_reserved).toBe(2);
      expect(cap.booked_allocations).toBe(2);
      const replaced = await sqlRows<{ id: string; n: number }>(
        `SELECT o.id, count(n.id)::int AS n FROM appointments o LEFT JOIN appointments n ON n.rescheduled_from_id = o.id
          WHERE o.id = ANY($1::uuid[]) GROUP BY o.id`,
        [appts],
      );
      for (const row of replaced) expect(row.n).toBeLessThanOrEqual(1);
      expect(replaced.reduce((s, x) => s + x.n, 0)).toBe(2);
    }
  }, 240_000);
});
