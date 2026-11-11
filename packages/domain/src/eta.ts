import type { Policy } from './policy.js';
import { simulatePolicyOrder } from './projection.js';
import type { Candidate } from './select.js';
import { MINUTE_MS, SECOND_MS, toMs } from './types.js';
import type { Instant, SessionStatus } from './types.js';

/** Below this many completed consultations the estimator is in its cold start. */
export const COLD_START_SAMPLES = 5;
/** Half-width of the range as a share of the projected offset. */
export const COLD_START_BAND = 0.5;
export const WARM_BAND = 0.3;
const EPSILON = 1e-9;

export interface Estimator {
  meanMinutes: number;
  /** Completed consultations folded into the mean so far. */
  samples: number;
}

export function initialEstimator(policy: Policy): Estimator {
  return { meanMinutes: policy.initialEstimateMin, samples: 0 };
}

/**
 * m(t) = alpha * d(t) + (1 - alpha) * m(t-1). Throws RangeError for an invalid alpha or a negative or
 * non-finite duration so a clock fault is visible rather than silently skewing the estimate.
 */
export function ewmaUpdate(meanMinutes: number, durationMin: number, alpha: number): number {
  if (!(alpha > 0 && alpha <= 1)) throw new RangeError('alpha must be in (0, 1]');
  if (!Number.isFinite(durationMin) || durationMin < 0) {
    throw new RangeError('durationMin must be a non-negative finite number');
  }
  return alpha * durationMin + (1 - alpha) * meanMinutes;
}

/** Folds one completed consultation into the estimator. */
export function recordConsultation(estimator: Estimator, durationMin: number, policy: Policy): Estimator {
  return {
    meanMinutes: ewmaUpdate(estimator.meanMinutes, durationMin, policy.ewmaAlpha),
    samples: estimator.samples + 1,
  };
}

export type EtaStatus = 'ok' | 'withheld' | 'unsupported';

export interface Eta {
  status: EtaStatus;
  /** Range in whole minutes from `computedAt`; null unless status is ok. */
  lowMinutes: number | null;
  highMinutes: number | null;
  note: string | null;
  /** ISO timestamp of the `now` the projection was computed at. */
  computedAt: string;
  estimatorMeanMinutes: number;
  estimatorSamples: number;
  /** Machine-readable uncertainty (FR-10); null unless status is ok. */
  uncertainty: EtaUncertainty | null;
}

export type EtaUncertainty = 'cold_start' | 'warm' | 'widened_overrun';

export interface EtaInput {
  targetEntryId: string;
  entries: readonly Candidate[];
  rotationPointer: number;
  /** The doctor's current called or in-service entry, if any. */
  active: { startedAt: Instant | null; calledAt: Instant | null } | null;
  session: { status: SessionStatus; pauseUntil: Instant | null };
  estimator: Estimator;
  policy: Policy;
  now: Instant;
}

const MODEL_NOTE = 'Model estimate from queue order and average consultation time, not a measured confidence interval.';

/**
 * Waiting-time estimate (report 6.6). Combines the residual of the active consultation, the patients
 * selected ahead under the same policy (simulated time advances, so eligibility and aging can change
 * the order) and any known pause. Withholds or widens when the basis is unsupported.
 */
export function projectEta(input: EtaInput): Eta {
  const nowMs = toMs(input.now);
  const m = input.estimator.meanMinutes;
  const make = (
    status: EtaStatus,
    low: number | null,
    high: number | null,
    note: string | null,
    uncertainty: EtaUncertainty | null = null,
  ): Eta => ({
    status,
    lowMinutes: low,
    highMinutes: high,
    note,
    computedAt: new Date(nowMs).toISOString(),
    estimatorMeanMinutes: m,
    estimatorSamples: input.estimator.samples,
    uncertainty,
  });

  if (!(m > 0) || !Number.isFinite(m)) return make('unsupported', null, null, 'Estimator is not available');

  const { status, pauseUntil } = input.session;
  if (status === 'unavailable') return make('withheld', null, null, 'Doctor unavailable');
  if (status === 'closed') return make('withheld', null, null, 'Session closed');
  if (status === 'scheduled') return make('withheld', null, null, 'Session has not opened yet');

  let pauseMs: number | null = null;
  if (status === 'paused') {
    if (pauseUntil === null) return make('withheld', null, null, 'Estimate paused');
    pauseMs = toMs(pauseUntil);
    if (pauseMs <= nowMs) {
      return make('withheld', null, null, 'Estimate paused (pause is longer than planned)');
    }
  }

  const target = input.entries.find((e) => e.id === input.targetEntryId);
  if (target === undefined || target.state !== 'waiting') {
    return make('unsupported', null, null, 'Patient is not waiting in this queue');
  }

  // When does the doctor next become free?
  let residualMin = 0;
  let overrun = false;
  const active = input.active;
  if (active !== null) {
    if (active.startedAt !== null) {
      const elapsedMin = Math.max(0, nowMs - toMs(active.startedAt)) / MINUTE_MS;
      if (elapsedMin > m) overrun = true; // residual unsupported: zero would read as "free now"
      else residualMin = m - elapsedMin;
    } else {
      // Called but not started: the patient either arrives (full consultation) or is skipped at the
      // timeout. Assume a full consultation, starting no later than the call timeout.
      const timeoutAt =
        active.calledAt === null ? nowMs : toMs(active.calledAt) + input.policy.calledTimeoutSec * SECOND_MS;
      residualMin = Math.max(0, timeoutAt - nowMs) / MINUTE_MS + m;
    }
  }
  let startMs = nowMs + residualMin * MINUTE_MS;
  if (pauseMs !== null) startMs = Math.max(startMs, pauseMs);

  const steps = simulatePolicyOrder(
    { entries: input.entries, rotationPointer: input.rotationPointer },
    input.policy,
    startMs,
    m,
  );
  const step = steps.find((s) => s.candidateId === input.targetEntryId);
  if (step === undefined) return make('unsupported', null, null, 'Could not place the patient in the projected order');

  const offsetMin = Math.max(0, step.startAtMs - nowMs) / MINUTE_MS;
  const coldStart = input.estimator.samples < COLD_START_SAMPLES;
  const band = coldStart ? COLD_START_BAND : WARM_BAND;
  // Round outwards (low down, high up) to whole minutes; EPSILON absorbs float noise such as 7.000000000000001.
  const low = Math.max(0, Math.floor(offsetMin * (1 - band) + EPSILON));
  const high = Math.max(0, Math.ceil(offsetMin * (1 + band) + (overrun ? m : 0) - EPSILON)); // max() also turns -0 into 0

  const notes = [MODEL_NOTE];
  if (coldStart) notes.push(`Few completed consultations so far (${input.estimator.samples}), so the range is wider.`);
  if (overrun) notes.push('The current consultation has run longer than average, so the upper bound is widened.');
  if (pauseMs !== null) notes.push('Includes a known pause.');
  const uncertainty: EtaUncertainty = overrun ? 'widened_overrun' : coldStart ? 'cold_start' : 'warm';
  return make('ok', low, high, notes.join(' '), uncertainty);
}
