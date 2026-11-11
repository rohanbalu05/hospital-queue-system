/**
 * T2 (report Table 5, FR-06-a at system level): report Table 8 reproduced through the real HTTP API, twice, on
 * two fresh sessions of two different doctors. Check-ins, the doctor's priority, call-next, start and complete
 * are all ordinary API calls; the decision log is read back over HTTP and straight from `queue_decisions`.
 *
 * The API runs on the real clock, so the Table 8 times are replaced by their relative order: a session that
 * started 12 to 13 minutes ago has slot 1 in its 15-minute grace window and slot 2 already eligible (early
 * eligibility is 10 minutes before the slot), exactly the A1, A2, W1 situation of decision 1.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are JSON of known shapes that each test narrows */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiClient } from '../support/client.js';
import { recordResult, T2_RESULTS_FILE } from '../support/results.js';
import {
  admitWalkIns,
  book,
  checkGlobalInvariants,
  closePool,
  doctorEmail,
  loginAs,
  makeRunningSession,
  registerPatients,
  sqlRows,
  type MadeSession,
} from '../support/world.js';

let admin: ApiClient;
let reception: ApiClient;
let patients: string[];

beforeAll(async () => {
  admin = await loginAs('admin@hqms.test');
  reception = await loginAs('reception@hqms.test');
  patients = await registerPatients(reception, 12, 'T2 Golden');
}, 120_000);

afterAll(async () => {
  const invariants = await checkGlobalInvariants();
  recordResult('t2GoldenHttp', { ...record, globalInvariantViolations: invariants.violations }, T2_RESULTS_FILE);
  await closePool();
});

const record: Record<string, unknown> = {};

/** The report's Table 8, decision by decision. `eligible` lists the tokens the policy considered. */
const GOLDEN = [
  {
    n: 1,
    token: 'A-001',
    reason: 'ROTATION',
    slot: 0,
    before: 0,
    after: 1,
    eligible: ['A-001', 'A-002', 'W-001'],
    explanation: 'Called by rotation: 1st appointment of A, A, W',
  },
  {
    n: 2,
    token: 'W-002',
    reason: 'CLINICAL_PRIORITY',
    slot: null,
    before: 1,
    after: 1,
    eligible: ['A-002', 'W-001', 'W-002'],
    explanation: 'Clinical priority (class 1)',
  },
  {
    n: 3,
    token: 'A-002',
    reason: 'ROTATION',
    slot: 1,
    before: 1,
    after: 2,
    eligible: ['A-002', 'W-001'],
    explanation: 'Called by rotation: 2nd appointment of A, A, W',
  },
  {
    n: 4,
    token: 'W-001',
    reason: 'ROTATION',
    slot: 2,
    before: 2,
    after: 0,
    eligible: ['W-001'],
    explanation: 'Called by rotation: walk-in turn of A, A, W',
  },
  {
    n: 5,
    token: 'W-003',
    reason: 'ROTATION',
    slot: 2,
    before: 0,
    after: 0,
    eligible: ['W-003'],
    explanation: 'Called by rotation: walk-in turn of A, A, W; appointment turn skipped (no appointments waiting)',
  },
] as const;

interface NormalizedDecision {
  token: string | null;
  reason: string;
  rotationSlot: number | null;
  pointerBefore: number;
  pointerAfter: number;
  policyVersion: number;
  queueVersion: number;
  explanation: string;
  eligibleTokens: string[];
}

interface RunResult {
  session: MadeSession;
  http: NormalizedDecision[];
  sql: NormalizedDecision[];
  finalPointer: number;
  occupiedChecks: number;
}

async function runTable8(doctorNumber: number, patientOffset: number): Promise<RunResult> {
  const doctor = await loginAs(doctorEmail(doctorNumber));
  const session = await makeRunningSession(admin, { doctor: doctorNumber, startOffsetMin: -12 });
  const p = (i: number): string => patients[patientOffset + i] as string;

  const arrive = async (i: number) => {
    const appt = await book(reception, session.id, p(i));
    expect(appt.status).toBe(201);
    const checkIn = await reception.post(`/appointments/${appt.body.id}/check-in`, {});
    expect(checkIn.status).toBe(201);
    expect(checkIn.body.group).toBe('A');
    return checkIn.body;
  };

  // Decision 1 situation: A1, A2 (appointments) and W1 (walk-in), all eligible, doctor free.
  const a1 = await arrive(0);
  const a2 = await arrive(1);
  const [w1] = await admitWalkIns(reception, session.id, [p(2)]);
  expect([a1.token, a2.token, w1.token]).toEqual(['A-001', 'A-002', 'W-001']);

  let occupiedChecks = 0;
  const served: Array<{ entryId: string; token: string }> = [];

  const decide = async () => {
    const res = await doctor.post(`/sessions/${session.id}/call-next`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const entry = res.body.entry;
    expect(entry).not.toBeNull();
    // Non-preemptive: while this patient is called, neither the doctor nor reception can call another one.
    for (const who of [doctor, reception]) {
      const blocked = await who.post(`/sessions/${session.id}/call-next`, {});
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('DOCTOR_OCCUPIED');
      occupiedChecks += 1;
    }
    expect((await doctor.post(`/visits/${entry.visitId}/start`, {})).status).toBe(200);
    expect((await doctor.post(`/visits/${entry.visitId}/complete`, {})).status).toBe(200);
    served.push({ entryId: entry.id, token: entry.token });
    return res.body;
  };

  await decide(); // 1: A1

  // Decision 2 situation: P1, a walk-in who arrives after decision 1 and receives clinical priority.
  const [p1] = await admitWalkIns(reception, session.id, [p(3)]);
  expect(p1.token).toBe('W-002');
  const deniedPriority = await reception.post(`/queue-entries/${p1.queueEntryId}/priority`, {
    priorityClass: 1,
    reason: 'Chest pain on arrival',
  });
  expect(deniedPriority.status, 'reception is a non-clinical actor').toBe(403);
  const priority = await doctor.post(`/queue-entries/${p1.queueEntryId}/priority`, {
    priorityClass: 1,
    reason: 'Chest pain on arrival',
  });
  expect(priority.status, JSON.stringify(priority.body)).toBe(200);

  await decide(); // 2: P1 by clinical priority, pointer unchanged
  await decide(); // 3: A2
  await decide(); // 4: W1

  // Decision 5 situation: only W2 is left, it arrived after decision 4.
  const [w2] = await admitWalkIns(reception, session.id, [p(4)]);
  expect(w2.token).toBe('W-003');
  await decide(); // 5: W2 after the empty A position

  expect(served.map((s) => s.token)).toEqual(GOLDEN.map((g) => g.token));

  // The decision log over HTTP (newest first) and straight from the table.
  const log = await doctor.get(`/sessions/${session.id}/decisions`);
  expect(log.status).toBe(200);
  const tokenById = new Map(served.map((s) => [s.entryId, s.token]));
  const http: NormalizedDecision[] = (log.body as any[]).reverse().map((d) => ({
    token: d.token,
    reason: d.reason,
    rotationSlot: d.rotationSlot,
    pointerBefore: d.pointerBefore,
    pointerAfter: d.pointerAfter,
    policyVersion: d.policyVersion,
    queueVersion: d.queueVersion,
    explanation: d.explanation,
    eligibleTokens: [],
  }));
  const rows = await sqlRows(
    `SELECT d.reason, d.rotation_slot, d.pointer_before, d.pointer_after, d.policy_version, d.queue_version::int AS queue_version,
            d.explanation, d.candidates, q.token
       FROM queue_decisions d LEFT JOIN queue_entries q ON q.id = d.queue_entry_id
      WHERE d.session_id = $1 ORDER BY d.queue_version, d.decided_at`,
    [session.id],
  );
  const sql: NormalizedDecision[] = rows.map((r) => ({
    token: r['token'],
    reason: r['reason'],
    rotationSlot: r['rotation_slot'],
    pointerBefore: r['pointer_before'],
    pointerAfter: r['pointer_after'],
    policyVersion: r['policy_version'],
    queueVersion: r['queue_version'],
    explanation: r['explanation'],
    eligibleTokens: (r['candidates'] as Array<{ token: string }>).map((c) => c.token).sort(),
  }));
  expect(tokenById.size).toBe(5);
  http.forEach((d, i) => {
    d.eligibleTokens = sql[i]?.eligibleTokens ?? [];
  });
  const ptr = await sqlRows(`SELECT rotation_pointer FROM sessions WHERE id = $1`, [session.id]);
  return { session, http, sql, finalPointer: ptr[0]?.['rotation_pointer'], occupiedChecks };
}

describe('T2 golden trace over HTTP (Table 8)', () => {
  it('reproduces Table 8 on two fresh sessions with identical decision sequences', async () => {
    const runA = await runTable8(3, 0);
    const runB = await runTable8(4, 5);

    for (const [name, run] of [
      ['run A (doctor 3)', runA],
      ['run B (doctor 4)', runB],
    ] as const) {
      for (const source of ['http', 'sql'] as const) {
        const got = run[source];
        expect(got, `${name} ${source}`).toHaveLength(5);
        GOLDEN.forEach((g, i) => {
          const d = got[i] as NormalizedDecision;
          const label = `${name} ${source} decision ${g.n}`;
          expect(d.token, label).toBe(g.token);
          expect(d.reason, label).toBe(g.reason);
          expect(d.rotationSlot, label).toBe(g.slot);
          expect(d.pointerBefore, `${label} pointer before`).toBe(g.before);
          expect(d.pointerAfter, `${label} pointer after`).toBe(g.after);
          expect(d.policyVersion, label).toBe(1);
          expect(d.explanation, label).toBe(g.explanation);
          if (source === 'sql') expect(d.eligibleTokens, `${label} eligible set`).toEqual([...g.eligible].sort());
        });
      }
      expect(run.finalPointer, `${name} final rotation pointer`).toBe(0);
    }

    // FR-06-a at system level: the two independent runs made the same decisions in the same order.
    expect(runB.http).toEqual(runA.http);
    expect(runB.sql).toEqual(runA.sql);

    record['table8'] = {
      golden: GOLDEN,
      runs: [runA, runB].map((r, i) => ({
        run: i === 0 ? 'A (doctor 3)' : 'B (doctor 4)',
        sessionId: r.session.id,
        decisionsOverHttp: r.http,
        decisionsFromTable: r.sql,
        finalRotationPointer: r.finalPointer,
        doctorOccupiedRefusals: r.occupiedChecks,
      })),
      identicalSequences: { http: true, table: true },
    };
  }, 120_000);
});
