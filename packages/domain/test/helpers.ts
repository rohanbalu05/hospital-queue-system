import type { Candidate } from '../src/index.js';

/** 2026-01-12 09:00 Asia/Kolkata (03:30Z), the clock origin for hand-written scenarios. */
export const T0 = Date.UTC(2026, 0, 12, 3, 30, 0);
export const MIN = 60_000;

/** Epoch ms for T0 plus `minutes`. */
export const at = (minutes: number): number => T0 + minutes * MIN;

let counter = 0;

/** A waiting walk-in candidate unless overridden. Eligible time defaults to check-in time. */
export function cand(overrides: Partial<Candidate> & { id: string }): Candidate {
  counter += 1;
  const checkedInAt = overrides.checkedInAt ?? at(0);
  return {
    group: 'W',
    seq: counter,
    state: 'waiting',
    scheduledAt: null,
    checkedInAt,
    eligibleAt: overrides.eligibleAt ?? checkedInAt,
    priorityClass: null,
    ...overrides,
  };
}
