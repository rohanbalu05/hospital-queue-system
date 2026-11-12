import { createHash } from 'node:crypto';
import { DEFAULT_POLICY } from '@hqms/domain';
import { describe, expect, it } from 'vitest';
import { ARMS, InvariantViolation, assertSchedule, runArm } from './engine.js';
import type { ArmRun } from './engine.js';
import { MIN, SCENARIOS, SESSION_MIN, SESSION_START_MS, generateSession } from './model.js';
import type { SimPatient, SimSession } from './model.js';
import { mulberry32 } from './prng.js';
import { perTrialCsv, runAll, runScenario, summaryCsv, toJson } from './simulate.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function patient(over: Partial<SimPatient> & Pick<SimPatient, 'id' | 'seq' | 'group'>): SimPatient {
  return {
    origin: over.group === 'A' ? 'appointment' : 'walk_in',
    scheduledAtMs: over.group === 'A' ? SESSION_START_MS : null,
    bookedAtMs: null,
    arrivalMs: SESSION_START_MS,
    eligibleAtMs: SESSION_START_MS,
    durationMs: 10 * MIN,
    priorityClass: null,
    ...over,
  };
}

function session(patients: SimPatient[]): SimSession {
  return {
    seed: 0,
    scenario: 'crafted',
    startMs: SESSION_START_MS,
    endMs: SESSION_START_MS + SESSION_MIN * MIN,
    breaks: [],
    patients,
    counts: {
      booked: 0,
      noShows: 0,
      lateDropped: 0,
      lateAdmitted: 0,
      walkInAttempts: 0,
      walkInAdmitted: 0,
      walkInTurnedAway: 0,
      priority: 0,
      totalWorkMin: 0,
    },
  };
}

const order = (run: ArmRun): string[] => run.calls.map((c) => c.id);

describe('seeded generator', () => {
  it('mulberry32 is deterministic and seed-sensitive', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const xs = Array.from({ length: 5 }, () => a());
    expect(xs).toEqual(Array.from({ length: 5 }, () => b()));
    expect(xs).not.toEqual(Array.from({ length: 5 }, () => c()));
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('same seed gives the same session; a different seed gives a different one', () => {
    for (const s of SCENARIOS) {
      expect(generateSession(s, s.baseSeed + 3)).toEqual(generateSession(s, s.baseSeed + 3));
      expect(generateSession(s, s.baseSeed + 3)).not.toEqual(generateSession(s, s.baseSeed + 4));
    }
  });

  it('respects session capacity and the check-in model', () => {
    for (const s of SCENARIOS) {
      for (let i = 0; i < 60; i += 1) {
        const g = generateSession(s, s.baseSeed + i);
        expect(g.counts.booked).toBeLessThanOrEqual(DEFAULT_POLICY.defaultBookedCapacity);
        expect(g.counts.walkInAdmitted).toBeLessThanOrEqual(DEFAULT_POLICY.defaultWalkinCapacity);
        expect(g.breaks.reduce((sum, b) => sum + b.durationMs, 0)).toBe(30 * MIN);
        const ids = new Set(g.patients.map((p) => p.id));
        expect(ids.size).toBe(g.patients.length);
        g.patients.forEach((p, k) => {
          expect(p.seq).toBe(k + 1); // sequence = check-in order
          expect(p.eligibleAtMs).toBeGreaterThanOrEqual(p.arrivalMs); // never eligible before check-in
          expect(p.durationMs).toBeGreaterThanOrEqual(3 * MIN);
          expect(p.durationMs).toBeLessThanOrEqual(45 * MIN);
          if (p.group === 'A') expect(p.scheduledAtMs).not.toBeNull();
          else expect(p.scheduledAtMs).toBeNull();
        });
      }
    }
  });
});

describe('determinism of the full run', () => {
  it('same seeds give byte-identical results JSON and CSV', () => {
    const first = runAll(6);
    const second = runAll(6);
    const a = toJson(first.output);
    expect(a).toBe(toJson(second.output));
    expect(sha(a)).toBe(sha(toJson(second.output)));
    expect(summaryCsv(first.output)).toBe(summaryCsv(second.output));
    expect(perTrialCsv(first.perTrial)).toBe(perTrialCsv(second.perTrial));
  });

  it('a different base seed changes the results', () => {
    const base = SCENARIOS.slice(0, 1);
    const shifted = base.map((s) => ({ ...s, baseSeed: s.baseSeed + 1_000 }));
    expect(toJson(runAll(8, base).output)).not.toBe(toJson(runAll(8, shifted).output));
  });
});

describe('invariants hold on generated sessions (engine asserts while running)', () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))('%s: 40 trials, all three arms', (_name, scenario) => {
    const { result } = runScenario(scenario, 40);
    expect(result.trials).toBe(40);
    // Every arm served exactly the same patients.
    const n = result.arms.fcfs.wait.n;
    for (const arm of ARMS) expect(result.arms[arm].wait.n).toBe(n);
  });

  it('every arm sees identical arrivals, durations and pauses', () => {
    const s = SCENARIOS[3];
    if (s === undefined) throw new Error('scenario missing');
    const g = generateSession(s, s.baseSeed + 7);
    const runs = ARMS.map((arm) => runArm(arm, g));
    const ids = runs.map((r) => [...r.calls].map((c) => c.id).sort());
    expect(ids[1]).toEqual(ids[0]);
    expect(ids[2]).toEqual(ids[0]);
    const eligible = runs.map((r) => [...r.calls].sort((a, b) => (a.id < b.id ? -1 : 1)).map((c) => c.eligibleAtMs));
    expect(eligible[1]).toEqual(eligible[0]);
    expect(runs.every((r) => r.breaks.length === g.breaks.length)).toBe(true);
  });

  it('assertSchedule rejects two patients in service at once', () => {
    const p1 = patient({ id: 'A1', seq: 1, group: 'A' });
    const p2 = patient({ id: 'A2', seq: 2, group: 'A' });
    const s = session([p1, p2]);
    const good = runArm('fcfs', s);
    expect(() => assertSchedule(good, s)).not.toThrow();
    const bad: ArmRun = {
      ...good,
      calls: good.calls.map((c, i) => (i === 1 ? { ...c, startMs: c.startMs - 5 * MIN, endMs: c.endMs - 5 * MIN } : c)),
    };
    expect(() => assertSchedule(bad, s)).toThrow(InvariantViolation);
  });

  it('assertSchedule rejects a start before eligibility', () => {
    const p1 = patient({ id: 'W1', seq: 1, group: 'W', eligibleAtMs: SESSION_START_MS + 20 * MIN });
    const s = session([p1]);
    const good = runArm('fcfs', s);
    const bad: ArmRun = {
      ...good,
      calls: good.calls.map((c) => ({ ...c, startMs: s.startMs, endMs: s.startMs + 10 * MIN })),
    };
    expect(() => assertSchedule(bad, s)).toThrow(InvariantViolation);
  });
});

describe('crafted sessions: policy behaviour through selectNext', () => {
  it('rotation A,A,W against FCFS on identical arrivals', () => {
    const t0 = SESSION_START_MS;
    const s = session([
      patient({ id: 'A1', seq: 1, group: 'A', scheduledAtMs: t0 }),
      patient({ id: 'A2', seq: 2, group: 'A', scheduledAtMs: t0 + 5 * MIN }),
      patient({ id: 'A3', seq: 3, group: 'A', scheduledAtMs: t0 + 10 * MIN }),
      patient({ id: 'W1', seq: 4, group: 'W' }),
      patient({ id: 'W2', seq: 5, group: 'W' }),
    ]);
    expect(order(runArm('policy', s))).toEqual(['A1', 'A2', 'W1', 'A3', 'W2']);
    expect(order(runArm('fcfs', s))).toEqual(['A1', 'A2', 'A3', 'W1', 'W2']);
  });

  it('priority never preempts a consultation and leaves the rotation pointer unchanged', () => {
    const t0 = SESSION_START_MS;
    const s = session([
      patient({ id: 'X', seq: 1, group: 'A', durationMs: 30 * MIN }),
      patient({ id: 'W1', seq: 2, group: 'W', arrivalMs: t0 + MIN, eligibleAtMs: t0 + MIN }),
      patient({
        id: 'P',
        seq: 3,
        group: 'W',
        priorityClass: 1,
        arrivalMs: t0 + 5 * MIN,
        eligibleAtMs: t0 + 5 * MIN,
      }),
    ]);
    const run = runArm('policy', s);
    expect(order(run)).toEqual(['X', 'P', 'W1']);
    const x = run.calls[0];
    const p = run.calls[1];
    expect(p?.startMs).toBe(x?.endMs); // P waited for X to finish
    expect(p?.reason).toBe('CLINICAL_PRIORITY');
    // X took slot 0 (pointer 1); P left it at 1; W1 skipped the empty A slot and took W (pointer 0).
    expect(run.calls.map((c) => c.reason)).toEqual(['ROTATION', 'CLINICAL_PRIORITY', 'ROTATION']);
    expect(run.finalPointer).toBe(0);
    // FCFS ignores priority.
    expect(order(runArm('fcfs', s))).toEqual(['X', 'W1', 'P']);
    expect(order(runArm('fcfs_priority', s))).toEqual(['X', 'P', 'W1']);
  });

  it('aging overrides the rotation once the oldest eligible wait reaches 45 minutes', () => {
    const t0 = SESSION_START_MS;
    const long = 30 * MIN;
    const s = session([
      patient({ id: 'B0', seq: 1, group: 'A', durationMs: long }),
      patient({ id: 'W1', seq: 2, group: 'W', durationMs: long, arrivalMs: t0 + MIN, eligibleAtMs: t0 + MIN }),
      patient({
        id: 'A1',
        seq: 3,
        group: 'A',
        durationMs: long,
        scheduledAtMs: t0 + MIN,
        arrivalMs: t0 + 2 * MIN,
        eligibleAtMs: t0 + 2 * MIN,
      }),
      patient({
        id: 'A2',
        seq: 4,
        group: 'A',
        durationMs: long,
        scheduledAtMs: t0 + 2 * MIN,
        arrivalMs: t0 + 2 * MIN,
        eligibleAtMs: t0 + 2 * MIN,
      }),
    ]);
    const run = runArm('policy', s);
    expect(order(run)).toEqual(['B0', 'A1', 'W1', 'A2']);
    expect(run.calls.map((c) => c.reason)).toEqual(['ROTATION', 'ROTATION', 'AGING', 'AGING']); // A2 has also waited 88 min by t0 + 90
    // Third call at t0 + 60 min: W1 eligible since t0 + 1 min.
    expect(run.calls[2]?.waitMin).toBe(59);
  });

  it('a pause blocks calls, does not interrupt a consultation and is taken afterwards', () => {
    const t0 = SESSION_START_MS;
    const s = session([
      patient({ id: 'A1', seq: 1, group: 'A', durationMs: 100 * MIN }),
      patient({
        id: 'A2',
        seq: 2,
        group: 'A',
        scheduledAtMs: t0 + 5 * MIN,
        arrivalMs: t0 + 5 * MIN,
        eligibleAtMs: t0 + 5 * MIN,
      }),
    ]);
    s.breaks = [{ nominalStartMs: t0 + 90 * MIN, durationMs: 15 * MIN }];
    for (const arm of ARMS) {
      const run = runArm(arm, s);
      const a1 = run.calls[0];
      const a2 = run.calls[1];
      expect(a1?.endMs).toBe(t0 + 100 * MIN); // ran through the nominal break start
      expect(run.breaks).toEqual([{ startMs: t0 + 100 * MIN, endMs: t0 + 115 * MIN }]);
      expect(a2?.startMs).toBe(t0 + 115 * MIN);
    }
  });
});
