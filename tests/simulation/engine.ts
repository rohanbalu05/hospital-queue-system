/**
 * Discrete-event model of one doctor-session under three queue disciplines, fed the same generated
 * session (identical arrivals, durations and pauses):
 *
 * - `fcfs`           first come first served by eligible time (then check-in sequence). No priority.
 * - `policy`         the HQMS policy: `selectNext` from @hqms/domain called exactly as the API will,
 *                    doctor free (non-preemptive), the rotation pointer carried between decisions.
 * - `fcfs_priority`  supplementary reference: authorized priority first, then FCFS. It separates the
 *                    effect of honouring priority from the effect of rotation and aging.
 *
 * The invariants from the task are asserted while the simulation runs; a violation throws and fails
 * the run.
 */
import { DEFAULT_POLICY, MINUTE_MS, selectNext } from '@hqms/domain';
import type { Candidate, DecisionReason, Policy, Selection } from '@hqms/domain';
import type { SimPatient, SimSession } from './model.js';

export type Arm = 'fcfs' | 'policy' | 'fcfs_priority';
export const ARMS: readonly Arm[] = ['fcfs', 'policy', 'fcfs_priority'];

export class InvariantViolation extends Error {
  constructor(message: string) {
    super(`simulation invariant violated: ${message}`);
    this.name = 'InvariantViolation';
  }
}

function must(condition: boolean, message: string): void {
  if (!condition) throw new InvariantViolation(message);
}

export type CallReason = DecisionReason | 'FCFS' | 'FCFS_PRIORITY';

export interface Call {
  id: string;
  group: 'A' | 'W';
  origin: SimPatient['origin'];
  priorityClass: SimPatient['priorityClass'];
  eligibleAtMs: number;
  startMs: number;
  endMs: number;
  /** Eligible to called, minutes. */
  waitMin: number;
  /** Called minus scheduled, minutes; only for on-time appointments. */
  startDelayMin: number | null;
  reason: CallReason;
}

export interface BreakTaken {
  startMs: number;
  endMs: number;
}

export interface ArmRun {
  arm: Arm;
  calls: Call[];
  breaks: BreakTaken[];
  /** Decisions by reason, including NO_ALLOCATION decisions made while patients were pending. */
  decisions: Record<string, number>;
  /** Rotation pointer after the final decision (policy only; 0 otherwise). */
  finalPointer: number;
}

function toCandidate(p: SimPatient): Candidate {
  return {
    id: p.id,
    group: p.group,
    seq: p.seq,
    state: 'waiting',
    scheduledAt: p.scheduledAtMs,
    checkedInAt: p.arrivalMs,
    eligibleAt: p.eligibleAtMs,
    priorityClass: p.priorityClass,
  };
}

function minBy<T>(items: readonly T[], cmp: (a: T, b: T) => number): T | undefined {
  let best: T | undefined;
  for (const item of items) if (best === undefined || cmp(item, best) < 0) best = item;
  return best;
}

const byFcfs = (a: SimPatient, b: SimPatient): number => a.eligibleAtMs - b.eligibleAtMs || a.seq - b.seq;
const byFcfsPriority = (a: SimPatient, b: SimPatient): number =>
  (a.priorityClass ?? 99) - (b.priorityClass ?? 99) || byFcfs(a, b);

/** Checks one policy decision against the rules in report section 6.4, independently of selectNext. */
function checkDecision(
  sel: Selection,
  pending: readonly SimPatient[],
  nowMs: number,
  policy: Policy,
  pointerBefore: number,
): void {
  const eligible = pending.filter((p) => p.eligibleAtMs <= nowMs);
  must(sel.pointerBefore === pointerBefore, 'selection did not start from the carried rotation pointer');
  must(sel.policyVersion === policy.version, 'wrong policy version in selection');
  if (sel.candidateId === null) {
    must(sel.reason === 'NO_ALLOCATION', 'null candidate with a non-NO_ALLOCATION reason');
    must(sel.pointerAfter === sel.pointerBefore, 'pointer moved on NO_ALLOCATION');
    return;
  }
  const chosen = eligible.find((p) => p.id === sel.candidateId);
  must(chosen !== undefined, `selected ${sel.candidateId} is not eligible at decision time (selected before eligible)`);
  if (chosen === undefined) return;
  const prioritized = eligible.filter((p) => p.priorityClass !== null);
  const oldestWaitMs = nowMs - Math.min(...eligible.map((p) => p.eligibleAtMs));
  switch (sel.reason) {
    case 'CLINICAL_PRIORITY': {
      must(chosen.priorityClass !== null, 'CLINICAL_PRIORITY selected a patient without authorized priority');
      const bestClass = Math.min(...prioritized.map((p) => p.priorityClass as number));
      must(chosen.priorityClass === bestClass, 'CLINICAL_PRIORITY did not select the best class');
      const sameClass = prioritized.filter((p) => p.priorityClass === bestClass);
      const oldest = Math.min(...sameClass.map((p) => p.eligibleAtMs));
      must(chosen.eligibleAtMs === oldest, 'CLINICAL_PRIORITY did not select the longest wait within the class');
      must(sel.pointerAfter === sel.pointerBefore, 'pointer moved on CLINICAL_PRIORITY');
      break;
    }
    case 'AGING': {
      must(prioritized.length === 0, 'AGING chosen while an authorized priority patient was eligible');
      must(oldestWaitMs >= policy.agingTriggerMin * MINUTE_MS, 'AGING chosen below the aging trigger');
      must(nowMs - chosen.eligibleAtMs === oldestWaitMs, 'AGING did not select the oldest eligible wait');
      must(sel.pointerAfter === sel.pointerBefore, 'pointer moved on AGING');
      break;
    }
    case 'ROTATION': {
      must(prioritized.length === 0, 'ROTATION chosen while an authorized priority patient was eligible');
      must(oldestWaitMs < policy.agingTriggerMin * MINUTE_MS, 'ROTATION chosen although the aging trigger was reached');
      must(sel.rotationSlot !== null, 'ROTATION without a rotation slot');
      const slot = sel.rotationSlot as number;
      must(policy.rotation[slot] === chosen.group, 'ROTATION served a group other than the rotation position');
      must(sel.pointerAfter === (slot + 1) % policy.rotation.length, 'pointer not advanced past the served position');
      break;
    }
    case 'NO_ALLOCATION':
      must(false, 'NO_ALLOCATION with a candidate');
  }
}

/**
 * Runs one arm. Breaks are fixed 15-minute pauses that begin at the first moment at or after their
 * nominal start when the doctor is not in a consultation. A consultation is never interrupted
 * (non-preemptive). A called patient is assumed present and starts at once (call-to-start = 0).
 * After 13:00 the doctor keeps seeing patients already checked in (overrun is measured), and no
 * further check-ins occur.
 */
export function runArm(arm: Arm, session: SimSession, policy: Policy = DEFAULT_POLICY): ArmRun {
  let pending = [...session.patients];
  const calls: Call[] = [];
  const breaksTaken: BreakTaken[] = [];
  const untaken = session.breaks.map((b) => ({ ...b, taken: false }));
  const decisions: Record<string, number> = {};
  let pointer = 0;
  let t = session.startMs;

  const countDecision = (reason: string): void => {
    decisions[reason] = (decisions[reason] ?? 0) + 1;
  };

  while (pending.length > 0) {
    const due = untaken.find((b) => !b.taken && b.nominalStartMs <= t);
    if (due !== undefined) {
      if (arm === 'policy') {
        // A paused session must not allocate (sessionCallable = false), even with eligible patients.
        const paused = selectNext(
          {
            entries: pending.map(toCandidate),
            rotationPointer: pointer,
            sessionCallable: false,
            doctorOccupied: false,
          },
          policy,
          t,
        );
        must(paused.candidateId === null && paused.pointerAfter === pointer, 'a paused session allocated a patient');
      }
      due.taken = true;
      breaksTaken.push({ startMs: t, endMs: t + due.durationMs });
      t += due.durationMs;
      continue;
    }

    const eligible = pending.filter((p) => p.eligibleAtMs <= t);
    if (eligible.length === 0) {
      let next = Math.min(...pending.map((p) => p.eligibleAtMs));
      for (const b of untaken) if (!b.taken && b.nominalStartMs > t) next = Math.min(next, b.nominalStartMs);
      must(next > t, 'event clock did not advance');
      t = next;
      continue;
    }

    let chosen: SimPatient;
    let reason: CallReason;
    if (arm === 'fcfs') {
      chosen = minBy(eligible, byFcfs) as SimPatient;
      reason = 'FCFS';
    } else if (arm === 'fcfs_priority') {
      chosen = minBy(eligible, byFcfsPriority) as SimPatient;
      reason = chosen.priorityClass === null ? 'FCFS' : 'FCFS_PRIORITY';
    } else {
      const entries = pending.map(toCandidate);
      const sel = selectNext(
        { entries, rotationPointer: pointer, sessionCallable: true, doctorOccupied: false },
        policy,
        t,
      );
      checkDecision(sel, pending, t, policy, pointer);
      countDecision(sel.reason);
      must(sel.candidateId !== null, 'NO_ALLOCATION although patients were eligible and the doctor was free');
      chosen = pending.find((p) => p.id === sel.candidateId) as SimPatient;
      reason = sel.reason;
      pointer = sel.pointerAfter;

      // Non-preemption: while this consultation runs, no decision may allocate anyone, even a priority
      // patient who becomes eligible meanwhile. Probe the selector mid-consultation.
      const mid = t + Math.floor(chosen.durationMs / 2);
      const probe = selectNext(
        {
          entries: entries.filter((e) => e.id !== chosen.id),
          rotationPointer: pointer,
          sessionCallable: true,
          doctorOccupied: true,
        },
        policy,
        mid,
      );
      must(
        probe.candidateId === null && probe.reason === 'NO_ALLOCATION' && probe.pointerAfter === pointer,
        'a call was allocated while the doctor was in service (preemption)',
      );
    }

    must(chosen.eligibleAtMs <= t, `${chosen.id} started before it was eligible`);
    const startMs = t;
    const endMs = t + chosen.durationMs;
    calls.push({
      id: chosen.id,
      group: chosen.group,
      origin: chosen.origin,
      priorityClass: chosen.priorityClass,
      eligibleAtMs: chosen.eligibleAtMs,
      startMs,
      endMs,
      waitMin: (startMs - chosen.eligibleAtMs) / MINUTE_MS,
      startDelayMin: chosen.scheduledAtMs === null ? null : (startMs - chosen.scheduledAtMs) / MINUTE_MS,
      reason,
    });
    pending = pending.filter((p) => p.id !== chosen.id);
    t = endMs;
  }

  const run: ArmRun = { arm, calls, breaks: breaksTaken, decisions, finalPointer: pointer };
  assertSchedule(run, session);
  return run;
}

/** Whole-schedule invariants, independent of how the schedule was produced. */
export function assertSchedule(run: ArmRun, session: SimSession): void {
  const byId = new Map(session.patients.map((p) => [p.id, p]));
  must(run.calls.length === session.patients.length, 'not every checked-in patient was served exactly once');
  const seen = new Set<string>();
  const ordered = [...run.calls].sort((a, b) => a.startMs - b.startMs);
  let prevEnd = Number.NEGATIVE_INFINITY;
  for (const c of ordered) {
    must(!seen.has(c.id), `${c.id} served twice`);
    seen.add(c.id);
    const p = byId.get(c.id);
    must(p !== undefined, `${c.id} is not a session patient`);
    if (p === undefined) continue;
    must(c.startMs >= prevEnd, `two patients in service at once (${c.id})`);
    must(c.startMs >= p.eligibleAtMs, `${c.id} started before eligible`);
    must(c.endMs - c.startMs === p.durationMs, `${c.id} consultation was cut short or extended`);
    prevEnd = c.endMs;
  }
  for (const b of run.breaks) {
    for (const c of run.calls) {
      must(!(c.startMs < b.endMs && c.endMs > b.startMs), `consultation ${c.id} overlaps a doctor pause`);
    }
  }
}
