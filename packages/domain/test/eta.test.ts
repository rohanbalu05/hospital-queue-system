import { describe, expect, it } from 'vitest';
import {
  COLD_START_SAMPLES,
  DEFAULT_POLICY,
  ewmaUpdate,
  initialEstimator,
  projectEta,
  recordConsultation,
} from '../src/index.js';
import type { Candidate, EtaInput, Policy } from '../src/index.js';
import { MIN, at, cand } from './helpers.js';

const a = (id: string, scheduled: number, checkedIn: number, seq: number, extra: Partial<Candidate> = {}): Candidate =>
  cand({ id, group: 'A', seq, scheduledAt: at(scheduled), checkedInAt: at(checkedIn), eligibleAt: at(checkedIn), ...extra });
const w = (id: string, checkedIn: number, seq: number, extra: Partial<Candidate> = {}): Candidate =>
  cand({ id, group: 'W', seq, checkedInAt: at(checkedIn), eligibleAt: at(checkedIn), ...extra });

const base = (over: Partial<EtaInput> & { targetEntryId: string; entries: Candidate[] }): EtaInput => ({
  rotationPointer: 0,
  active: null,
  session: { status: 'open', pauseUntil: null },
  estimator: { meanMinutes: 12, samples: 10 },
  policy: DEFAULT_POLICY,
  now: at(10),
  ...over,
});

describe('EWMA', () => {
  it('m = 0.2 d + 0.8 m_prev: 12 then d=20 gives 13.6', () => {
    expect(ewmaUpdate(12, 20, 0.2)).toBeCloseTo(13.6, 10);
  });

  it('starts at the policy initial estimate and counts samples', () => {
    const e0 = initialEstimator(DEFAULT_POLICY);
    expect(e0).toEqual({ meanMinutes: 12, samples: 0 });
    const e1 = recordConsultation(e0, 20, DEFAULT_POLICY);
    expect(e1.meanMinutes).toBeCloseTo(13.6, 10);
    expect(e1.samples).toBe(1);
    const e2 = recordConsultation(e1, 10, DEFAULT_POLICY);
    expect(e2.meanMinutes).toBeCloseTo(0.2 * 10 + 0.8 * 13.6, 10);
    expect(e0.samples).toBe(0); // input not mutated
  });

  it('alpha 1 follows the latest duration; a duration equal to the mean leaves it unchanged', () => {
    expect(ewmaUpdate(12, 7, 1)).toBe(7);
    expect(ewmaUpdate(12, 12, 0.2)).toBeCloseTo(12, 10);
  });

  it('rejects invalid input', () => {
    expect(() => ewmaUpdate(12, -1, 0.2)).toThrow(RangeError);
    expect(() => ewmaUpdate(12, Number.NaN, 0.2)).toThrow(RangeError);
    expect(() => ewmaUpdate(12, Number.POSITIVE_INFINITY, 0.2)).toThrow(RangeError);
    expect(() => ewmaUpdate(12, 10, 0)).toThrow(RangeError);
    expect(() => ewmaUpdate(12, 10, 1.1)).toThrow(RangeError);
  });
});

describe('projectEta: withheld and unsupported', () => {
  const entries = [a('A1', 0, 0, 1), w('W1', 0, 2)];

  it('paused with unknown duration is withheld', () => {
    const eta = projectEta(base({ targetEntryId: 'A1', entries, session: { status: 'paused', pauseUntil: null } }));
    expect(eta).toMatchObject({ status: 'withheld', lowMinutes: null, highMinutes: null, note: 'Estimate paused' });
  });

  it('paused with a pause that has already passed is withheld', () => {
    const eta = projectEta(base({ targetEntryId: 'A1', entries, session: { status: 'paused', pauseUntil: at(5) } }));
    expect(eta.status).toBe('withheld');
    expect(eta.note).toMatch(/longer than planned/);
  });

  it('unavailable, closed and not-yet-open sessions are withheld', () => {
    const run = (status: 'unavailable' | 'closed' | 'scheduled') =>
      projectEta(base({ targetEntryId: 'A1', entries, session: { status, pauseUntil: null } }));
    expect(run('unavailable')).toMatchObject({ status: 'withheld', note: 'Doctor unavailable' });
    expect(run('closed')).toMatchObject({ status: 'withheld', note: 'Session closed' });
    expect(run('scheduled')).toMatchObject({ status: 'withheld', note: 'Session has not opened yet' });
  });

  it('a target that is not waiting (or unknown) is unsupported', () => {
    const called = [a('A1', 0, 0, 1, { state: 'called' })];
    expect(projectEta(base({ targetEntryId: 'A1', entries: called })).status).toBe('unsupported');
    expect(projectEta(base({ targetEntryId: 'missing', entries })).status).toBe('unsupported');
  });

  it('a broken estimator is unsupported', () => {
    for (const meanMinutes of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(projectEta(base({ targetEntryId: 'A1', entries, estimator: { meanMinutes, samples: 3 } })).status).toBe('unsupported');
    }
  });

  it('a rotation that cannot place the patient is unsupported rather than a wrong number', () => {
    const onlyA: Policy = { ...DEFAULT_POLICY, rotation: ['A'] };
    expect(projectEta(base({ targetEntryId: 'W1', entries, policy: onlyA })).status).toBe('unsupported');
  });

  it('computedAt equals now as an ISO string, for every status', () => {
    const now = at(10);
    const ok = projectEta(base({ targetEntryId: 'A1', entries, now }));
    const withheld = projectEta(base({ targetEntryId: 'A1', entries, now: new Date(now), session: { status: 'closed', pauseUntil: null } }));
    expect(ok.computedAt).toBe(new Date(now).toISOString());
    expect(withheld.computedAt).toBe('2026-01-12T03:40:00.000Z');
    expect(ok.estimatorMeanMinutes).toBe(12);
    expect(ok.estimatorSamples).toBe(10);
    expect(ok.uncertainty).toBe('warm');
    expect(withheld.uncertainty).toBeNull();
  });
});

describe('projectEta: ok estimates', () => {
  it('first in line with a free doctor starts now', () => {
    const eta = projectEta(base({ targetEntryId: 'A1', entries: [a('A1', 0, 0, 1)] }));
    expect(eta).toMatchObject({ status: 'ok', lowMinutes: 0, highMinutes: 0 });
    expect(eta.note).toMatch(/not a measured confidence interval/);
  });

  it('respects A, A, W: the walk-in waits behind two appointments', () => {
    const entries = [w('W1', 0, 1), a('A1', 0, 0, 2), a('A2', 1, 0, 3), a('A3', 2, 0, 4)];
    const eta = (id: string) => projectEta(base({ targetEntryId: id, entries, now: at(5) }));
    // Offsets with m = 12: A1 0, A2 12, W1 24, A3 36. Warm band is 30%.
    expect(eta('A1')).toMatchObject({ lowMinutes: 0, highMinutes: 0 });
    expect(eta('A2')).toMatchObject({ lowMinutes: 8, highMinutes: 16 }); // 12 * 0.7 = 8.4 -> 8, 12 * 1.3 = 15.6 -> 16
    expect(eta('W1')).toMatchObject({ lowMinutes: 16, highMinutes: 32 }); // 24 * 0.7 = 16.8 -> 16, 24 * 1.3 = 31.2 -> 32
    expect(eta('A3')).toMatchObject({ lowMinutes: 25, highMinutes: 47 }); // 36 * 0.7 = 25.2, 36 * 1.3 = 46.8
  });

  it('uses the rotation pointer', () => {
    const entries = [w('W1', 0, 1), a('A1', 0, 0, 2)];
    const atW = projectEta(base({ targetEntryId: 'W1', entries, rotationPointer: 2, now: at(5) }));
    expect(atW).toMatchObject({ lowMinutes: 0, highMinutes: 0 });
  });

  it('cold start (fewer than 5 samples) uses a +-50% range', () => {
    const entries = [a('A1', 0, 0, 1), a('A2', 1, 0, 2)];
    const cold = projectEta(base({ targetEntryId: 'A2', entries, estimator: { meanMinutes: 12, samples: COLD_START_SAMPLES - 1 }, now: at(5) }));
    expect(cold).toMatchObject({ lowMinutes: 6, highMinutes: 18 });
    expect(cold.note).toMatch(/Few completed consultations/);
    expect(cold.uncertainty).toBe('cold_start');
    const warm = projectEta(base({ targetEntryId: 'A2', entries, estimator: { meanMinutes: 12, samples: COLD_START_SAMPLES }, now: at(5) }));
    expect(warm).toMatchObject({ lowMinutes: 8, highMinutes: 16 });
    expect(warm.note).not.toMatch(/Few completed/);
    expect(warm.uncertainty).toBe('warm');
  });

  it('subtracts the elapsed part of the active consultation', () => {
    const entries = [a('A1', 0, 0, 1)];
    const eta = projectEta(
      base({ targetEntryId: 'A1', entries, now: at(10), active: { startedAt: at(4), calledAt: at(3) } }),
    );
    // Residual 12 - 6 = 6 min; warm band 30%: 4.2 -> 4, 7.8 -> 8.
    expect(eta).toMatchObject({ status: 'ok', lowMinutes: 4, highMinutes: 8 });
    expect(eta.note).not.toMatch(/longer than average/);
  });

  it('an active consultation exactly at the mean has zero residual but is not an overrun', () => {
    const eta = projectEta(base({ targetEntryId: 'A1', entries: [a('A1', 0, 0, 1)], now: at(16), active: { startedAt: at(4), calledAt: null } }));
    expect(eta).toMatchObject({ lowMinutes: 0, highMinutes: 0 });
  });

  it('an overrun consultation widens the upper bound instead of reporting a certain zero', () => {
    const entries = [a('A1', 0, 0, 1)];
    const eta = projectEta(base({ targetEntryId: 'A1', entries, now: at(30), active: { startedAt: at(4), calledAt: at(3) } }));
    expect(eta.status).toBe('ok');
    expect(eta.lowMinutes).toBe(0);
    expect(eta.highMinutes).toBe(12); // one more mean consultation of headroom
    expect(eta.note).toMatch(/run longer than average/);
    expect(eta.uncertainty).toBe('widened_overrun');
  });

  it('a called but not yet started patient counts the full consultation plus the call timeout window', () => {
    const entries = [a('A1', 0, 0, 1)];
    const eta = projectEta(
      base({ targetEntryId: 'A1', entries, now: at(10), estimator: { meanMinutes: 10, samples: 10 }, active: { startedAt: null, calledAt: at(10) } }),
    );
    // 2 min until the call times out + 10 min consultation = 12; 12 * 0.7 = 8.4 -> 8, 12 * 1.3 = 15.6 -> 16.
    expect(eta).toMatchObject({ lowMinutes: 8, highMinutes: 16 });
    const noCallTime = projectEta(
      base({ targetEntryId: 'A1', entries, now: at(10), estimator: { meanMinutes: 10, samples: 10 }, active: { startedAt: null, calledAt: null } }),
    );
    expect(noCallTime).toMatchObject({ lowMinutes: 7, highMinutes: 13 });
    // Long after the call, only the consultation remains.
    const late = projectEta(
      base({ targetEntryId: 'A1', entries, now: at(10), estimator: { meanMinutes: 10, samples: 10 }, active: { startedAt: null, calledAt: at(0) } }),
    );
    expect(late).toMatchObject({ lowMinutes: 7, highMinutes: 13 });
  });

  it('a known pause starts simulated time at the pause end', () => {
    const entries = [a('A1', 0, 0, 1), a('A2', 1, 0, 2)];
    const eta = projectEta(
      base({ targetEntryId: 'A2', entries, now: at(10), session: { status: 'paused', pauseUntil: at(40) } }),
    );
    // A1 starts at 40, A2 at 52: offset 42 min -> 29.4 -> 29, 54.6 -> 55.
    expect(eta).toMatchObject({ status: 'ok', lowMinutes: 29, highMinutes: 55 });
    expect(eta.note).toMatch(/known pause/);
  });

  it('a known pause that ends before the active consultation does not shorten the wait', () => {
    const eta = projectEta(
      base({ targetEntryId: 'A1', entries: [a('A1', 0, 0, 1)], now: at(10), active: { startedAt: at(10), calledAt: null }, session: { status: 'paused', pauseUntil: at(15) } }),
    );
    // Consultation ends at 22, after the pause: offset 12.
    expect(eta).toMatchObject({ lowMinutes: 8, highMinutes: 16 });
  });

  it('an appointment that is not yet eligible waits for its eligible time even if the doctor is free', () => {
    const eta = projectEta(
      base({ targetEntryId: 'A1', entries: [a('A1', 60, 0, 1, { eligibleAt: at(50) })], now: at(10) }),
    );
    // Eligible at 50: offset 40 -> 28, 52.
    expect(eta).toMatchObject({ status: 'ok', lowMinutes: 28, highMinutes: 52 });
  });

  it('simulated time lets aging reorder the queue: a long-waiting walk-in jumps ahead', () => {
    const policy: Policy = { ...DEFAULT_POLICY, rotation: ['A', 'A', 'A', 'W'] };
    const entries = [
      a('A1', 0, 20, 1, { eligibleAt: at(20) }),
      a('A2', 1, 20, 2, { eligibleAt: at(20) }),
      a('A3', 2, 20, 3, { eligibleAt: at(20) }),
      w('W1', 0, 4),
    ];
    const run = (id: string) => projectEta(base({ targetEntryId: id, entries, policy, now: at(30) }));
    // W1 would be fourth by rotation (offset 36). At the third decision (offset 24, clock 54) it has
    // waited 54 min, so aging promotes it to offset 24 and A3 slips to 36.
    expect(run('W1')).toMatchObject({ lowMinutes: 16, highMinutes: 32 });
    expect(run('A3')).toMatchObject({ lowMinutes: 25, highMinutes: 47 });
  });

  it('priority already on an entry moves it to the front of the projection', () => {
    const entries = [a('A1', 0, 0, 1), w('P', 5, 2, { priorityClass: 1 })];
    expect(projectEta(base({ targetEntryId: 'P', entries, now: at(10) }))).toMatchObject({ lowMinutes: 0, highMinutes: 0 });
    expect(projectEta(base({ targetEntryId: 'A1', entries, now: at(10) }))).toMatchObject({ lowMinutes: 8, highMinutes: 16 });
  });

  it('never returns a negative or inverted range', () => {
    const eta = projectEta(base({ targetEntryId: 'A1', entries: [a('A1', 0, 0, 1)], now: at(10), active: { startedAt: at(10) + 5 * MIN, calledAt: null } }));
    expect(eta.lowMinutes).toBeGreaterThanOrEqual(0);
    expect(eta.highMinutes as number).toBeGreaterThanOrEqual(eta.lowMinutes as number);
  });
});
