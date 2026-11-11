/**
 * Shared literal types. Deliberately re-declared here instead of imported from
 * `@hqms/contracts` (DECISIONS D-004): this package has zero dependencies.
 * A contract test in `apps/api` checks that the literals stay in sync.
 */

/** Queue group: A = appointment, W = walk-in (late admissions are ordered as W). */
export type Group = 'A' | 'W';

export type QueueEntryState =
  | 'waiting'
  | 'called'
  | 'in_service'
  | 'completed'
  | 'skipped'
  | 'absent'
  | 'cancelled';

export type DecisionReason = 'CLINICAL_PRIORITY' | 'AGING' | 'ROTATION' | 'NO_ALLOCATION';

export type SessionStatus = 'scheduled' | 'open' | 'paused' | 'unavailable' | 'closed';

/** 1 = most urgent. */
export type PriorityClass = 1 | 2 | 3;

/**
 * A point in time. Time is always an input to this package: a `Date` or epoch
 * milliseconds. Nothing here reads a clock.
 */
export type Instant = Date | number;

export const MINUTE_MS = 60_000;
export const SECOND_MS = 1_000;

export function toMs(t: Instant): number {
  return typeof t === 'number' ? t : t.getTime();
}

/** Total order on numbers that is safe with Infinity. */
export function cmpNum(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Locale-independent string order, used as the last deterministic tie-breaker. */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
