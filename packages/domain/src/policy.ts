import type { Group } from './types.js';

/** Versioned session policy (report Table 7). The policy stays fixed for a session. */
export interface Policy {
  readonly version: number;
  /** Normal rotation, e.g. A, A, W. */
  readonly rotation: readonly Group[];
  /** Appointment enters the eligible set from scheduled time minus this, after check-in. */
  readonly earlyEligibilityMin: number;
  /** Arrival within scheduled + grace keeps the appointment classification. */
  readonly lateGraceMin: number;
  /** Oldest eligible wait at or beyond this triggers the aging override. */
  readonly agingTriggerMin: number;
  /** An unanswered call becomes SKIPPED after this many seconds. */
  readonly calledTimeoutSec: number;
  /** EWMA weight of the latest completed consultation duration. */
  readonly ewmaAlpha: number;
  /** Starting service-time estimate in minutes. */
  readonly initialEstimateMin: number;
  readonly defaultBookedCapacity: number;
  readonly defaultWalkinCapacity: number;
}

export const DEFAULT_POLICY: Policy = Object.freeze({
  version: 1,
  rotation: Object.freeze(['A', 'A', 'W'] as const) as readonly Group[],
  earlyEligibilityMin: 10,
  lateGraceMin: 15,
  agingTriggerMin: 45,
  calledTimeoutSec: 120,
  ewmaAlpha: 0.2,
  initialEstimateMin: 12,
  defaultBookedCapacity: 10,
  defaultWalkinCapacity: 5,
});

/** Human-readable rotation, e.g. "A, A, W". */
export function rotationLabel(policy: Policy): string {
  return policy.rotation.join(', ');
}

/** Returns a list of problems; empty when the policy is usable by the selector. */
export function validatePolicy(policy: Policy): string[] {
  const problems: string[] = [];
  if (policy.rotation.length === 0) problems.push('rotation must not be empty');
  if (!policy.rotation.includes('A')) problems.push('rotation must contain A');
  if (!policy.rotation.includes('W')) problems.push('rotation must contain W');
  if (!(policy.ewmaAlpha > 0 && policy.ewmaAlpha <= 1)) problems.push('ewmaAlpha must be in (0, 1]');
  if (!(policy.initialEstimateMin > 0)) problems.push('initialEstimateMin must be positive');
  if (!(policy.agingTriggerMin > 0)) problems.push('agingTriggerMin must be positive');
  if (policy.earlyEligibilityMin < 0) problems.push('earlyEligibilityMin must not be negative');
  if (policy.lateGraceMin < 0) problems.push('lateGraceMin must not be negative');
  if (!(policy.calledTimeoutSec > 0)) problems.push('calledTimeoutSec must be positive');
  return problems;
}

/** Position in the rotation that is safe to index: wraps and handles negatives. */
export function normalizePointer(pointer: number, rotationLength: number): number {
  if (rotationLength <= 0) return 0;
  const p = Math.trunc(pointer);
  return ((p % rotationLength) + rotationLength) % rotationLength;
}
