import type { Policy } from './policy.js';
import { MINUTE_MS, toMs } from './types.js';
import type { Instant, QueueEntryState } from './types.js';

export type ArrivalClass = 'on_time' | 'late_requires_review';

/**
 * Report Table 7, late grace. Arrival up to and including scheduled + grace keeps the appointment
 * classification (early arrival of any amount is on time). After grace the arrival needs a staff
 * capacity review and, if admitted, follows walk-in ordering.
 */
export function classifyArrival(
  arrival: { scheduledAt: Instant; arrivedAt: Instant },
  policy: Policy,
): ArrivalClass {
  const limit = toMs(arrival.scheduledAt) + policy.lateGraceMin * MINUTE_MS;
  return toMs(arrival.arrivedAt) <= limit ? 'on_time' : 'late_requires_review';
}

/** What the eligible time is derived from. */
export type EligibilityBasis =
  | { kind: 'appointment'; scheduledAt: Instant; checkedInAt: Instant }
  | { kind: 'walkin' | 'late_admission'; acceptedAt: Instant }
  | { kind: 're_entry'; reEnteredAt: Instant };

/**
 * Earliest time the entry may be selected, as epoch milliseconds.
 * - on-time appointment: max(check-in, scheduled - earlyEligibilityMin)
 * - walk-in or late admission: the accepted check-in time
 * - re-entry after skip/absent: the re-entry time (fresh eligibility)
 */
export function computeEligibleAt(basis: EligibilityBasis, policy: Policy): number {
  switch (basis.kind) {
    case 'appointment':
      return Math.max(
        toMs(basis.checkedInAt),
        toMs(basis.scheduledAt) - policy.earlyEligibilityMin * MINUTE_MS,
      );
    case 'walkin':
    case 'late_admission':
      return toMs(basis.acceptedAt);
    case 're_entry':
      return toMs(basis.reEnteredAt);
  }
}

/**
 * Present WAITING entries whose eligible time has been reached. Absent, cancelled, called,
 * in-service, skipped and completed entries are never eligible.
 */
export function isEligible(entry: { state: QueueEntryState; eligibleAt: Instant }, now: Instant): boolean {
  return entry.state === 'waiting' && toMs(entry.eligibleAt) <= toMs(now);
}
