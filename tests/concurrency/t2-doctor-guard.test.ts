/**
 * T2 (report Table 5, FR-06, NFR-03): the doctor-level guard under real concurrency.
 *
 *  1. One doctor with TWO overlapping sessions, each holding waiting walk-ins: 30 parallel call-next requests
 *     (doctor and reception logins, split over both sessions) -> exactly one patient is called, the other 29 get
 *     409 DOCTOR_OCCUPIED, no 5xx; a separate connection polls "called or in service" for that doctor during the
 *     race and never sees more than one. 20 rounds, the visit is completed between rounds.
 *  2. call-next vs start vs complete vs skip on the same entry: one valid transition sequence, no 5xx.
 *  3. pause racing call-next: once the pause has committed, no call succeeds.
 *  4. The same Idempotency-Key fired in parallel: one allocation, identical replayed responses.
 *
 * Real HTTP against the built API, real PostgreSQL, nothing mocked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { percentile, newKey, type ApiClient, type ApiResponse } from '../support/client.js';
import { recordResult, T2_RESULTS_FILE } from '../support/results.js';
import {
  admitWalkIns,
  checkGlobalInvariants,
  closePool,
  databaseUrl,
  doctorEmail,
  doctorId,
  loginAs,
  makeRunningSession,
  openSession,
  pollActiveAllocations,
  registerPatients,
  round1,
  serveEntry,
  sqlRows,
  tally,
} from '../support/world.js';

let admin: ApiClient;
let reception: ApiClient;
const record: Record<string, unknown> = {};

beforeAll(async () => {
  admin = await loginAs('admin@hqms.test');
  reception = await loginAs('reception@hqms.test');
}, 120_000);

afterAll(async () => {
  const invariants = await checkGlobalInvariants();
  recordResult('t2DoctorGuard', { ...record, globalInvariantViolations: invariants.violations }, T2_RESULTS_FILE);
  await closePool();
});

/** Random start offset (0..maxMs) so the interleavings differ from round to round instead of always being the same burst order. */
const jitter = async (maxMs: number): Promise<void> => {
  await new Promise((r) => setTimeout(r, Math.random() * maxMs));
};

const activeFor = async (doctor: number): Promise<number> => {
  const rows = await sqlRows(
    `SELECT count(*)::int AS n FROM queue_entries WHERE doctor_id = $1 AND state IN ('called','in_service')`,
    [doctorId(doctor)],
  );
  return rows[0]?.['n'];
};

describe('T2 doctor guard under concurrency', () => {
  it('two overlapping sessions of one doctor, 30 parallel call-next x 20 rounds: one allocation per round, the rest 409 DOCTOR_OCCUPIED', async () => {
    const DOCTOR = 5;
    const ROUNDS = 20;
    const RACERS = 30;
    const doctorClients = await Promise.all(Array.from({ length: 3 }, () => loginAs(doctorEmail(DOCTOR))));
    const receptionClients = await Promise.all(Array.from({ length: 3 }, () => loginAs('reception@hqms.test')));
    const clients = [...doctorClients, ...receptionClients];

    // Two sessions of the same doctor that overlap in time (started 40 and 25 minutes ago, 4 hours long).
    const sessionA = await makeRunningSession(admin, {
      doctor: DOCTOR,
      startOffsetMin: -40,
      walkin: 30,
      label: 'morning',
    });
    const sessionB = await makeRunningSession(admin, {
      doctor: DOCTOR,
      startOffsetMin: -25,
      walkin: 30,
      label: 'afternoon',
    });
    expect(new Date(sessionB.startsAt).getTime()).toBeLessThan(new Date(sessionA.endsAt).getTime());
    const patients = await registerPatients(reception, 32, 'T2 Guard');
    await admitWalkIns(reception, sessionA.id, patients.slice(0, 16));
    await admitWalkIns(reception, sessionB.id, patients.slice(16, 32));

    const allLatencies: number[] = [];
    const winnerLatencies: number[] = [];
    const perRound: Array<Record<string, unknown>> = [];
    let violations = 0;
    let totalPolls = 0;
    let maxSeen = 0;
    let winnersFromA = 0;
    let winnersFromB = 0;
    const allResults: ApiResponse[] = [];

    for (let round = 1; round <= ROUNDS; round += 1) {
      const decisionsBefore = (
        await sqlRows(
          `SELECT count(*)::int AS n FROM queue_decisions WHERE doctor_id = $1 AND queue_entry_id IS NOT NULL`,
          [doctorId(DOCTOR)],
        )
      )[0]?.['n'];
      expect(await activeFor(DOCTOR)).toBe(0);

      const poller = pollActiveAllocations(databaseUrl(), doctorId(DOCTOR));
      const results = await Promise.all(
        Array.from({ length: RACERS }, (_, i) => {
          const session = i % 2 === 0 ? sessionA : sessionB;
          return (clients[i % clients.length] as ApiClient).post(`/sessions/${session.id}/call-next`, {});
        }),
      );
      const seen = await poller.stop();
      totalPolls += seen.polls;
      maxSeen = Math.max(maxSeen, seen.max);
      if (seen.max > 1) violations += 1;

      const t = tally(results);
      const winners = results.filter((r) => r.status === 200);
      const losers = results.filter((r) => r.status !== 200);
      expect(t.serverErrors, `round ${round}: 5xx responses`).toBe(0);
      expect(winners, `round ${round}: successful calls`).toHaveLength(1);
      expect(winners[0]?.body.entry, `round ${round}: the winner called a real patient`).not.toBeNull();
      expect(losers).toHaveLength(RACERS - 1);
      for (const l of losers) {
        expect(l.status, `round ${round}`).toBe(409);
        expect(l.body.error.code, `round ${round}`).toBe('DOCTOR_OCCUPIED');
      }
      expect(seen.max, `round ${round}: polled max of called|in_service rows`).toBeLessThanOrEqual(1);
      expect(await activeFor(DOCTOR), `round ${round}: committed state`).toBe(1);
      const decisionsAfter = (
        await sqlRows(
          `SELECT count(*)::int AS n FROM queue_decisions WHERE doctor_id = $1 AND queue_entry_id IS NOT NULL`,
          [doctorId(DOCTOR)],
        )
      )[0]?.['n'];
      expect(decisionsAfter - decisionsBefore, `round ${round}: decision rows written`).toBe(1);

      const winner = winners[0] as ApiResponse;
      if (winner.body.entry.sessionId === sessionA.id) winnersFromA += 1;
      else winnersFromB += 1;
      winnerLatencies.push(winner.ms);
      results.forEach((r) => allLatencies.push(r.ms));
      allResults.push(...results);
      perRound.push({
        round,
        requests: RACERS,
        ok200: winners.length,
        conflict409: losers.length,
        serverErrors: t.serverErrors,
        byCode: t.byCode,
        winnerSession: winner.body.entry.sessionId === sessionA.id ? 'A' : 'B',
        winnerToken: winner.body.entry.token,
        pollsDuringRace: seen.polls,
        maxActiveSeenByPoller: seen.max,
        latencyMs: {
          p50: round1(
            percentile(
              results.map((r) => r.ms),
              50,
            ),
          ),
          p95: round1(
            percentile(
              results.map((r) => r.ms),
              95,
            ),
          ),
        },
      });

      // Complete the visit between rounds (the doctor's own login).
      await serveEntry(doctorClients[0] as ApiClient, winner.body.entry);
      expect(await activeFor(DOCTOR)).toBe(0);
    }

    const overall = tally(allResults);
    expect(violations).toBe(0);
    expect(overall.serverErrors).toBe(0);
    record['overlappingSessions'] = {
      doctor: DOCTOR,
      sessions: 2,
      rounds: ROUNDS,
      racersPerRound: RACERS,
      requests: allResults.length,
      ok200: allResults.filter((r) => r.status === 200).length,
      conflict409DoctorOccupied: overall.byCode['DOCTOR_OCCUPIED'] ?? 0,
      serverErrors: overall.serverErrors,
      byStatus: overall.byStatus,
      invariantViolations: violations,
      poller: { totalPolls, maxActiveAllocationsEverSeen: maxSeen },
      winnersFromSessionA: winnersFromA,
      winnersFromSessionB: winnersFromB,
      latencyMs: {
        allRequests: {
          n: allLatencies.length,
          p50: round1(percentile(allLatencies, 50)),
          p95: round1(percentile(allLatencies, 95)),
          max: round1(Math.max(...allLatencies)),
        },
        winningRequests: {
          n: winnerLatencies.length,
          p50: round1(percentile(winnerLatencies, 50)),
          p95: round1(percentile(winnerLatencies, 95)),
        },
      },
      perRound,
    };
  }, 240_000);

  it('call-next races start, complete and skip of the same entry: one valid transition sequence, no 5xx', async () => {
    const DOCTOR = 6;
    const ROUNDS = 40;
    const doctorClient = await loginAs(doctorEmail(DOCTOR));
    const doctorClient2 = await loginAs(doctorEmail(DOCTOR));
    const session = await makeRunningSession(admin, { doctor: DOCTOR, startOffsetMin: -30, walkin: 100 });
    const patients = await registerPatients(reception, ROUNDS * 2 + 2, 'T2 Transition');
    let patientCursor = 0;
    const nextPatients = (n: number): string[] => patients.slice(patientCursor, (patientCursor += n));

    const outcomes: Record<string, number> = {};
    const perRound: Array<Record<string, unknown>> = [];
    const allResults: ApiResponse[] = [];
    let sequenceViolations = 0;

    for (let round = 1; round <= ROUNDS; round += 1) {
      await admitWalkIns(reception, session.id, nextPatients(2));
      const first = await doctorClient.post(`/sessions/${session.id}/call-next`, {});
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const entry = first.body.entry;
      expect(entry.state).toBe('called');
      const versionBefore = entry.version as number;

      // One request per command, two for start/complete/skip so the same command also races itself.
      const jobs: Array<{ kind: string; run: () => Promise<ApiResponse> }> = [
        { kind: 'start', run: () => doctorClient.post(`/visits/${entry.visitId}/start`, {}, null) },
        { kind: 'start', run: () => doctorClient2.post(`/visits/${entry.visitId}/start`, {}, null) },
        { kind: 'complete', run: () => doctorClient.post(`/visits/${entry.visitId}/complete`, {}, null) },
        { kind: 'complete', run: () => doctorClient2.post(`/visits/${entry.visitId}/complete`, {}, null) },
        { kind: 'skip', run: () => doctorClient.post(`/queue-entries/${entry.id}/skip`, {}, null) },
        { kind: 'skip', run: () => reception.post(`/queue-entries/${entry.id}/skip`, {}, null) },
        { kind: 'call-next', run: () => doctorClient.post(`/sessions/${session.id}/call-next`, {}) },
        { kind: 'call-next', run: () => reception.post(`/sessions/${session.id}/call-next`, {}) },
        { kind: 'call-next', run: () => doctorClient2.post(`/sessions/${session.id}/call-next`, {}) },
      ];
      // Shuffle so the arrival order differs from round to round.
      for (let i = jobs.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [jobs[i], jobs[j]] = [jobs[j] as (typeof jobs)[number], jobs[i] as (typeof jobs)[number]];
      }
      const poller = pollActiveAllocations(databaseUrl(), doctorId(DOCTOR));
      const results = await Promise.all(
        jobs.map(async (j) => {
          await jitter(8);
          return j.run();
        }),
      );
      const seen = await poller.stop();
      allResults.push(...results);

      const byKind = (kind: string): ApiResponse[] => results.filter((_, i) => jobs[i]?.kind === kind);
      const t = tally(results);
      expect(t.serverErrors, `round ${round}: 5xx`).toBe(0);
      for (const r of results)
        expect([200, 409], `round ${round}: status ${r.status} ${JSON.stringify(r.body)}`).toContain(r.status);
      expect(seen.max, `round ${round}: polled max active`).toBeLessThanOrEqual(1);
      expect(await activeFor(DOCTOR)).toBeLessThanOrEqual(1);

      const row = (await sqlRows(`SELECT state, version FROM queue_entries WHERE id = $1`, [entry.id]))[0] as {
        state: string;
        version: number;
      };
      const ok = (kind: string): number => byKind(kind).filter((r) => r.status === 200).length;
      const valid = ['completed', 'skipped', 'in_service'];
      expect(valid, `round ${round}: final state ${row.state}`).toContain(row.state);

      // Exactly one valid transition sequence: the version advanced once per committed transition, no more.
      let expectedOk: Record<string, number>;
      let expectedBump: number;
      if (row.state === 'completed') {
        expectedOk = { start: 1, complete: 1, skip: 0 };
        expectedBump = 2;
      } else if (row.state === 'skipped') {
        expectedOk = { start: 0, complete: 0, skip: 1 };
        expectedBump = 1;
      } else {
        expectedOk = { start: 1, complete: 0, skip: 0 };
        expectedBump = 1;
      }
      const sequenceOk =
        ok('start') === expectedOk['start'] &&
        ok('complete') === expectedOk['complete'] &&
        ok('skip') === expectedOk['skip'] &&
        row.version - versionBefore === expectedBump;
      if (!sequenceOk) sequenceViolations += 1;
      expect(
        { start: ok('start'), complete: ok('complete'), skip: ok('skip'), bump: row.version - versionBefore },
        `round ${round}: final ${row.state}`,
      ).toEqual({ ...expectedOk, bump: expectedBump });

      // call-next may only succeed after this entry left called|in_service, and at most once.
      const callOk = byKind('call-next').filter((r) => r.status === 200);
      for (const r of byKind('call-next').filter((x) => x.status === 409)) {
        expect(['DOCTOR_OCCUPIED'], `round ${round}: call-next refusal`).toContain(r.body.error.code);
      }
      expect(callOk.length, `round ${round}: call-next successes`).toBeLessThanOrEqual(1);
      if (row.state === 'in_service')
        expect(callOk, `round ${round}: nobody may be called while the consultation runs`).toHaveLength(0);
      for (const r of callOk) expect(r.body.entry.id).not.toBe(entry.id);

      const key = `${row.state}${callOk.length > 0 ? '+next-called' : ''}`;
      outcomes[key] = (outcomes[key] ?? 0) + 1;
      perRound.push({
        round,
        finalState: row.state,
        versionBump: row.version - versionBefore,
        callNextSucceeded: callOk.length,
        statuses: t.byStatus,
        maxActiveSeen: seen.max,
      });

      // Reset for the next round: finish whatever the doctor still holds.
      if (row.state === 'in_service') {
        expect((await doctorClient.post(`/visits/${entry.visitId}/complete`, {})).status).toBe(200);
      }
      const held = (
        await sqlRows(
          `SELECT visit_id, state FROM queue_entries WHERE doctor_id = $1 AND state IN ('called','in_service')`,
          [doctorId(DOCTOR)],
        )
      )[0];
      if (held) {
        if (held['state'] === 'called')
          expect((await doctorClient.post(`/visits/${held['visit_id']}/start`, {})).status).toBe(200);
        expect((await doctorClient.post(`/visits/${held['visit_id']}/complete`, {})).status).toBe(200);
      }
      expect(await activeFor(DOCTOR)).toBe(0);
    }

    const overall = tally(allResults);
    record['transitionRace'] = {
      doctor: DOCTOR,
      rounds: ROUNDS,
      requestsPerRound: 9,
      requests: allResults.length,
      byStatus: overall.byStatus,
      byCode: overall.byCode,
      serverErrors: overall.serverErrors,
      sequenceViolations,
      finalStateDistribution: outcomes,
      perRound,
    };
    expect(sequenceViolations).toBe(0);
  }, 240_000);

  it('pause racing call-next: after the pause commits no call succeeds', async () => {
    const DOCTOR = 7;
    const ROUNDS = 20;
    const doctorClient = await loginAs(doctorEmail(DOCTOR));
    const patients = await registerPatients(reception, ROUNDS * 4, 'T2 Pause');
    const perRound: Array<Record<string, unknown>> = [];
    let callsAfterPause = 0;
    let callWonBeforePause = 0;
    let pauseWonFirst = 0;

    for (let round = 1; round <= ROUNDS; round += 1) {
      const session = await makeRunningSession(admin, { doctor: DOCTOR, startOffsetMin: -20 - round, walkin: 10 });
      await openSession(reception, session.id);
      await admitWalkIns(reception, session.id, patients.slice((round - 1) * 4, round * 4));
      const versionBefore = (
        await sqlRows(`SELECT queue_version::int AS v FROM sessions WHERE id = $1`, [session.id])
      )[0]?.['v'];

      const jobs: Array<{ kind: string; run: () => Promise<ApiResponse> }> = [
        { kind: 'pause', run: () => doctorClient.post(`/sessions/${session.id}/pause`, { reason: 'T2 race' }) },
        {
          kind: 'pause',
          run: () => reception.post(`/sessions/${session.id}/pause`, { reason: 'T2 race (second pauser)' }),
        },
        ...Array.from({ length: 10 }, (_, i) => ({
          kind: 'call-next',
          run: () => (i % 2 === 0 ? doctorClient : reception).post(`/sessions/${session.id}/call-next`, {}),
        })),
      ];
      // Rotate so the pause sits at a different position in the burst each round.
      const shift = round % jobs.length;
      const ordered = [...jobs.slice(shift), ...jobs.slice(0, shift)];
      const results = await Promise.all(
        ordered.map(async (j) => {
          await jitter(10);
          return j.run();
        }),
      );
      const byKind = (kind: string): ApiResponse[] => results.filter((_, i) => ordered[i]?.kind === kind);
      const t = tally(results);
      expect(t.serverErrors, `round ${round}: 5xx`).toBe(0);

      const pauses = byKind('pause');
      expect(
        pauses.filter((r) => r.status === 200),
        `round ${round}: exactly one pause applies`,
      ).toHaveLength(1);
      for (const r of pauses.filter((x) => x.status !== 200)) {
        expect(r.status).toBe(409);
        expect(r.body.error.code).toBe('INVALID_TRANSITION');
      }
      const calls = byKind('call-next');
      const callOk = calls.filter((r) => r.status === 200);
      for (const r of calls.filter((x) => x.status !== 200)) {
        expect(r.status, `round ${round}`).toBe(409);
        expect(['DOCTOR_OCCUPIED', 'SESSION_NOT_CALLABLE'], `round ${round}: call-next refusal`).toContain(
          r.body.error.code,
        );
      }
      expect(callOk.length, `round ${round}: at most one call can win`).toBeLessThanOrEqual(1);

      // The pause's own queue version (audit row) versus the decisions: every successful call was serialised BEFORE it.
      const audit = await sqlRows(
        `SELECT (next->>'queueVersion')::int AS v FROM audit_events WHERE operation = 'session.pause' AND entity_id = $1`,
        [session.id],
      );
      expect(audit, `round ${round}: one pause audit row`).toHaveLength(1);
      const pauseVersion = audit[0]?.['v'] as number;
      for (const r of callOk) {
        if (r.body.decision.queueVersion >= pauseVersion) callsAfterPause += 1;
        expect(r.body.decision.queueVersion, `round ${round}: a call committed after the pause`).toBeLessThan(
          pauseVersion,
        );
      }
      const status = (await sqlRows(`SELECT status FROM sessions WHERE id = $1`, [session.id]))[0]?.['status'];
      expect(status).toBe('paused');
      const decisionsAfterPause = await sqlRows(
        `SELECT 1 FROM queue_decisions WHERE session_id = $1 AND queue_entry_id IS NOT NULL AND queue_version >= $2`,
        [session.id, pauseVersion],
      );
      expect(decisionsAfterPause, `round ${round}: decisions at or after the pause version`).toHaveLength(0);
      if (callOk.length === 1) callWonBeforePause += 1;
      else pauseWonFirst += 1;

      // Let the doctor finish whatever was called (paused sessions still allow start/complete), then prove the pause holds.
      const held = (
        await sqlRows(
          `SELECT visit_id, state FROM queue_entries WHERE doctor_id = $1 AND state IN ('called','in_service')`,
          [doctorId(DOCTOR)],
        )
      )[0];
      if (held) {
        if (held['state'] === 'called')
          expect((await doctorClient.post(`/visits/${held['visit_id']}/start`, {})).status).toBe(200);
        expect((await doctorClient.post(`/visits/${held['visit_id']}/complete`, {})).status).toBe(200);
      }
      const after = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          (i % 2 === 0 ? doctorClient : reception).post(`/sessions/${session.id}/call-next`, {}),
        ),
      );
      for (const r of after) {
        expect(r.status, `round ${round}: call after pause`).toBe(409);
        expect(r.body.error.code, `round ${round}: call after pause`).toBe('SESSION_NOT_CALLABLE');
      }
      expect(await activeFor(DOCTOR)).toBe(0);
      perRound.push({
        round,
        callsThatWonBeforePause: callOk.length,
        pauseVersion,
        versionBefore,
        statuses: t.byStatus,
        byCode: t.byCode,
        callsAfterCommittedPause: after.length,
      });
    }

    record['pauseRace'] = {
      doctor: DOCTOR,
      rounds: ROUNDS,
      requestsPerRound: 12,
      roundsWhereACallWonBeforeThePause: callWonBeforePause,
      roundsWhereThePauseWonFirst: pauseWonFirst,
      successfulCallsSerialisedAfterThePause: callsAfterPause,
      callsAfterCommittedPause: ROUNDS * 6,
      allRefusedSessionNotCallable: true,
      perRound,
    };
    expect(callsAfterPause).toBe(0);
  }, 240_000);

  it('the same Idempotency-Key fired 10x in parallel allocates one patient and replays one response', async () => {
    const DOCTOR = 8;
    const TRIALS = 5;
    const doctorClient = await loginAs(doctorEmail(DOCTOR));
    const session = await makeRunningSession(admin, { doctor: DOCTOR, startOffsetMin: -30, walkin: 20 });
    const patients = await registerPatients(reception, TRIALS * 2, 'T2 Replay');
    await admitWalkIns(reception, session.id, patients);
    const perTrial: Array<Record<string, unknown>> = [];

    for (let trial = 1; trial <= TRIALS; trial += 1) {
      const key = newKey();
      const results = await Promise.all(
        Array.from({ length: 10 }, () => doctorClient.post(`/sessions/${session.id}/call-next`, {}, key)),
      );
      expect(tally(results).serverErrors).toBe(0);
      const ok = results.filter((r) => r.status === 200);
      expect(ok, `trial ${trial}: every same-key request returns the stored 200`).toHaveLength(10);
      expect(new Set(ok.map((r) => r.body.entry.id)).size).toBe(1);
      expect(new Set(ok.map((r) => r.body.decision.id)).size).toBe(1);
      expect(await activeFor(DOCTOR)).toBe(1);
      const rows = await sqlRows(`SELECT count(*)::int AS n FROM queue_decisions WHERE queue_entry_id = $1`, [
        ok[0]?.body.entry.id,
      ]);
      expect(rows[0]?.['n']).toBe(1);
      perTrial.push({ trial, requests: 10, ok200: ok.length, distinctEntries: 1, decisionRows: 1 });
      await serveEntry(doctorClient, ok[0]?.body.entry);
    }
    record['sameKeyCallNext'] = { doctor: DOCTOR, trials: TRIALS, perTrial };
  }, 120_000);
});
