/**
 * Synthetic workload model for one doctor-session (report section 5.5 Tables 3-4, section 5.6).
 * Every number here is an assumption chosen to exercise the queue policy; none is a hospital
 * measurement. Times inside a session are minutes from the 09:00 opening and converted to epoch
 * milliseconds only at the boundary with @hqms/domain.
 */
import { DEFAULT_POLICY, classifyArrival, computeEligibleAt } from '@hqms/domain';
import type { Group, Policy, PriorityClass } from '@hqms/domain';
import { Rng } from './prng.js';

/** 09:00 Asia/Kolkata on a fixed Monday (03:30 UTC). Only differences between instants matter. */
export const SESSION_START_MS = Date.UTC(2026, 0, 5, 3, 30, 0);
export const MIN = 60_000;

export const SESSION_MIN = 240;
/** Nominal consultation minutes: 240 minus 30 minutes of breaks (report Table 3). */
export const CONSULT_CAPACITY_MIN = 210;
/** Appointment slot grid: every 20 minutes from 09:00 to 12:40 (12 slots, at most 10 are booked). */
export const SLOT_STEP_MIN = 20;
export const SLOT_COUNT = 12;
/** Walk-ins are accepted until 30 minutes before close. */
export const WALKIN_CUTOFF_MIN = 210;
/** Two 15-minute doctor pauses; 30 minutes in total. Nominal start minutes from 09:00. */
export const BREAKS: readonly { startMin: number; durationMin: number }[] = [
  { startMin: 90, durationMin: 15 },
  { startMin: 180, durationMin: 15 },
];

export type Origin = 'appointment' | 'late_appointment' | 'walk_in';

export interface SimPatient {
  id: string;
  origin: Origin;
  /** Queue group as the selector sees it. Late admissions are ordered as walk-ins (Table 7). */
  group: Group;
  /** Check-in order; the selector's stable sequence. */
  seq: number;
  /** Appointment time for on-time appointments; null for walk-ins and late admissions. */
  scheduledAtMs: number | null;
  /** Booked time for late appointments (for reporting only; ordering ignores it). */
  bookedAtMs: number | null;
  arrivalMs: number;
  eligibleAtMs: number;
  durationMs: number;
  priorityClass: PriorityClass | null;
}

export interface SimBreak {
  nominalStartMs: number;
  durationMs: number;
}

export interface SimSession {
  seed: number;
  scenario: string;
  startMs: number;
  endMs: number;
  breaks: SimBreak[];
  patients: SimPatient[];
  counts: {
    booked: number;
    noShows: number;
    lateDropped: number;
    lateAdmitted: number;
    walkInAttempts: number;
    walkInAdmitted: number;
    walkInTurnedAway: number;
    priority: number;
    totalWorkMin: number;
  };
}

export interface IntensityPiece {
  fromMin: number;
  toMin: number;
  /** Expected walk-in arrival attempts per minute in this piece. */
  ratePerMin: number;
}

export interface ScenarioParams {
  name: string;
  title: string;
  description: string;
  baseSeed: number;
  bookedCount: number;
  noShowProb: number;
  lateProb: number;
  /** Late arrivals are lateGraceMin + 1 + Exp(lateExtraMeanMin) minutes after the booked time. */
  lateExtraMeanMin: number;
  /** On-time arrival offset from the booked time: Normal(mean, sd), clamped to the opening. */
  onTimeOffsetMeanMin: number;
  onTimeOffsetSdMin: number;
  walkInIntensity: readonly IntensityPiece[];
  walkInCapacity: number;
  priorityProb: number;
  /** Weights for classes 1, 2, 3. */
  priorityClassWeights: readonly [number, number, number];
  durationMeanMin: number;
  durationSigma: number;
}

const COMMON = {
  lateProb: 0.1,
  lateExtraMeanMin: 12,
  onTimeOffsetMeanMin: -6,
  onTimeOffsetSdMin: 7,
  walkInCapacity: 5,
  priorityClassWeights: [0.2, 0.3, 0.5] as const,
  durationSigma: 0.4,
} as const;

export const SCENARIOS: readonly ScenarioParams[] = [
  {
    ...COMMON,
    name: 'appointment-heavy',
    title: 'Appointment-heavy',
    description: '10 booked slots, light walk-in demand (about 3 attempts), mean consultation 12 min.',
    baseSeed: 1_000_000,
    bookedCount: 10,
    noShowProb: 0.08,
    walkInIntensity: [{ fromMin: 0, toMin: 210, ratePerMin: 3 / 210 }],
    priorityProb: 0.03,
    durationMeanMin: 12,
  },
  {
    ...COMMON,
    name: 'walk-in-heavy',
    title: 'Walk-in-heavy',
    description:
      '5 booked slots; walk-in demand of about 10 attempts front-loaded into the first 90 minutes, so the 5-walk-in cap is reached early; mean 12 min.',
    baseSeed: 2_000_000,
    bookedCount: 5,
    noShowProb: 0.08,
    walkInIntensity: [
      { fromMin: 0, toMin: 90, ratePerMin: 7 / 90 },
      { fromMin: 90, toMin: 210, ratePerMin: 3 / 120 },
    ],
    priorityProb: 0.03,
    durationMeanMin: 12,
  },
  {
    ...COMMON,
    name: 'priority-heavy',
    title: 'Priority-heavy',
    description:
      '10 booked slots and about 6 walk-in attempts; 20% of attending patients receive an authorized clinical priority (classes 1/2/3 at 20/30/50%); mean 12 min.',
    baseSeed: 3_000_000,
    bookedCount: 10,
    noShowProb: 0.08,
    walkInIntensity: [{ fromMin: 0, toMin: 210, ratePerMin: 6 / 210 }],
    priorityProb: 0.2,
    durationMeanMin: 12,
  },
  {
    ...COMMON,
    name: 'overloaded',
    title: 'Overloaded',
    description:
      'Full capacity (10 booked, about 8 walk-in attempts so the cap of 5 is normally reached), mean consultation 16 min (report Table 3 sensitivity case).',
    baseSeed: 4_000_000,
    bookedCount: 10,
    noShowProb: 0.03,
    walkInIntensity: [{ fromMin: 0, toMin: 210, ratePerMin: 8 / 210 }],
    priorityProb: 0.05,
    durationMeanMin: 16,
  },
];

export const DEFAULT_TRIALS = 500;

const MIN_DURATION_MIN = 3;
const MAX_DURATION_MIN = 45;

function atMs(minutes: number): number {
  // Whole seconds only, so every instant is an exact integer number of milliseconds.
  return SESSION_START_MS + Math.round(minutes * 60) * 1000;
}

function drawDuration(rng: Rng, p: ScenarioParams): number {
  const raw = rng.lognormalByMean(p.durationMeanMin, p.durationSigma);
  const clamped = Math.min(MAX_DURATION_MIN, Math.max(MIN_DURATION_MIN, raw));
  return Math.round(clamped * 60) * 1000;
}

interface Draft {
  idKey: string;
  origin: Origin;
  scheduledMin: number | null;
  arrivalMin: number;
  durationMs: number;
  priorityClass: PriorityClass | null;
}

function drawPriority(rng: Rng, p: ScenarioParams): PriorityClass | null {
  // Two draws every time so the stream does not depend on the outcome.
  const flag = rng.bernoulli(p.priorityProb);
  const cls = rng.weighted(p.priorityClassWeights) + 1;
  return flag ? (cls as PriorityClass) : null;
}

/**
 * Generates one session. The generator consumes a fixed number of draws per appointment, so the
 * stream position depends only on the seed. Both queue policies receive the very same session.
 */
export function generateSession(params: ScenarioParams, seed: number, policy: Policy = DEFAULT_POLICY): SimSession {
  const rng = new Rng(seed);
  const drafts: Draft[] = [];
  let noShows = 0;
  let lateDropped = 0;
  let lateAdmitted = 0;

  // Booked appointments: a random subset of the 12 slots.
  const slots = Array.from({ length: SLOT_COUNT }, (_, i) => i * SLOT_STEP_MIN);
  const booked = rng
    .shuffled(slots)
    .slice(0, Math.min(params.bookedCount, policy.defaultBookedCapacity))
    .sort((a, b) => a - b);
  for (const slotMin of booked) {
    const noShow = rng.bernoulli(params.noShowProb);
    const isLate = rng.bernoulli(params.lateProb);
    const z = rng.normal();
    const extra = rng.exp(params.lateExtraMeanMin);
    const priorityClass = drawPriority(rng, params);
    const durationMs = drawDuration(rng, params);
    if (noShow) {
      noShows += 1;
      continue;
    }
    const offset = isLate ? policy.lateGraceMin + 1 + extra : params.onTimeOffsetMeanMin + params.onTimeOffsetSdMin * z;
    const arrivalMin = Math.max(0, Math.round((slotMin + offset) * 60) / 60);
    if (arrivalMin >= SESSION_MIN) {
      lateDropped += 1; // arrives after close: treated as a no-show
      continue;
    }
    drafts.push({
      idKey: `A${String(slotMin).padStart(3, '0')}`,
      origin: 'appointment',
      scheduledMin: slotMin,
      arrivalMin,
      durationMs,
      priorityClass,
    });
  }

  // Walk-in attempts: piecewise-constant Poisson process. The first walkInCapacity are admitted.
  const attempts: number[] = [];
  for (const piece of params.walkInIntensity) {
    let t = piece.fromMin;
    for (;;) {
      t += rng.exp(1 / piece.ratePerMin);
      if (t >= piece.toMin || t >= WALKIN_CUTOFF_MIN) break;
      attempts.push(Math.round(t * 60) / 60);
    }
  }
  attempts.sort((a, b) => a - b);
  let walkInAdmitted = 0;
  attempts.forEach((arrivalMin, k) => {
    const priorityClass = drawPriority(rng, params);
    const durationMs = drawDuration(rng, params);
    if (walkInAdmitted >= Math.min(params.walkInCapacity, policy.defaultWalkinCapacity)) return;
    walkInAdmitted += 1;
    drafts.push({
      idKey: `W${String(k).padStart(2, '0')}`,
      origin: 'walk_in',
      scheduledMin: null,
      arrivalMin,
      durationMs,
      priorityClass,
    });
  });

  // Classify arrivals with the domain rule, derive eligibility, then assign check-in sequence.
  const classified = drafts.map((d) => {
    const arrivalMs = atMs(d.arrivalMin);
    let origin = d.origin;
    let group: Group = 'W';
    let eligibleAtMs: number;
    let scheduledAtMs: number | null = null;
    let bookedAtMs: number | null = null;
    if (d.scheduledMin !== null) {
      const scheduled = atMs(d.scheduledMin);
      const cls = classifyArrival({ scheduledAt: scheduled, arrivedAt: arrivalMs }, policy);
      if (cls === 'on_time') {
        group = 'A';
        scheduledAtMs = scheduled;
        eligibleAtMs = computeEligibleAt(
          { kind: 'appointment', scheduledAt: scheduled, checkedInAt: arrivalMs },
          policy,
        );
      } else {
        origin = 'late_appointment';
        bookedAtMs = scheduled;
        lateAdmitted += 1; // staff capacity review assumed to approve immediately
        eligibleAtMs = computeEligibleAt({ kind: 'late_admission', acceptedAt: arrivalMs }, policy);
      }
    } else {
      eligibleAtMs = computeEligibleAt({ kind: 'walkin', acceptedAt: arrivalMs }, policy);
    }
    return { d, origin, group, arrivalMs, eligibleAtMs, scheduledAtMs, bookedAtMs };
  });
  classified.sort((a, b) => a.arrivalMs - b.arrivalMs || (a.d.idKey < b.d.idKey ? -1 : 1));
  const patients: SimPatient[] = classified.map((c, i) => ({
    id: c.d.idKey,
    origin: c.origin,
    group: c.group,
    seq: i + 1,
    scheduledAtMs: c.scheduledAtMs,
    bookedAtMs: c.bookedAtMs,
    arrivalMs: c.arrivalMs,
    eligibleAtMs: c.eligibleAtMs,
    durationMs: c.d.durationMs,
    priorityClass: c.d.priorityClass,
  }));

  return {
    seed,
    scenario: params.name,
    startMs: SESSION_START_MS,
    endMs: SESSION_START_MS + SESSION_MIN * MIN,
    breaks: BREAKS.map((b) => ({ nominalStartMs: atMs(b.startMin), durationMs: b.durationMin * MIN })),
    patients,
    counts: {
      booked: booked.length,
      noShows,
      lateDropped,
      lateAdmitted,
      walkInAttempts: attempts.length,
      walkInAdmitted,
      walkInTurnedAway: attempts.length - walkInAdmitted,
      priority: patients.filter((p) => p.priorityClass !== null).length,
      totalWorkMin: Math.round(patients.reduce((s, p) => s + p.durationMs, 0) / 600) / 100,
    },
  };
}
