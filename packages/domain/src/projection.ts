import type { Policy } from './policy.js';
import { normalizePointer } from './policy.js';
import { selectNext } from './select.js';
import type { Candidate, Selection } from './select.js';
import { MINUTE_MS, cmpNum, cmpStr, toMs } from './types.js';
import type { Instant } from './types.js';

export interface ProjectedStep {
  candidateId: string;
  /** Simulated start of this consultation, epoch milliseconds. */
  startAtMs: number;
  selection: Selection;
}

export interface ProjectionInput {
  entries: readonly Candidate[];
  rotationPointer: number;
}

/**
 * Simulates repeated selection for the waiting entries: the doctor is free at `startMs`, each served
 * patient takes `serviceMin`, and simulated time advances so that eligibility and aging change the
 * order exactly as they would live. When nobody is eligible yet the clock jumps to the next
 * eligible time. Priority classes already on the entries are honoured; future changes are unknown.
 */
export function simulatePolicyOrder(
  input: ProjectionInput,
  policy: Policy,
  startMs: number,
  serviceMin: number,
): ProjectedStep[] {
  if (!(serviceMin > 0) || !Number.isFinite(serviceMin)) {
    throw new RangeError('serviceMin must be a positive finite number');
  }
  let remaining = input.entries.filter((e) => e.state === 'waiting');
  let pointer = normalizePointer(input.rotationPointer, policy.rotation.length);
  let clock = startMs;
  const steps: ProjectedStep[] = [];

  while (remaining.length > 0) {
    const selection = selectNext(
      { entries: remaining, rotationPointer: pointer, sessionCallable: true, doctorOccupied: false },
      policy,
      clock,
    );
    if (selection.candidateId === null) {
      // Nobody eligible at this simulated time: idle until the next entry becomes eligible.
      let next = Number.POSITIVE_INFINITY;
      for (const e of remaining) {
        const at = toMs(e.eligibleAt);
        if (at > clock && at < next) next = at;
      }
      if (next === Number.POSITIVE_INFINITY) break; // misconfigured rotation; cannot place the rest
      clock = next;
      continue;
    }
    const id = selection.candidateId;
    steps.push({ candidateId: id, startAtMs: clock, selection });
    remaining = remaining.filter((e) => e.id !== id);
    pointer = selection.pointerAfter;
    clock += serviceMin * MINUTE_MS;
  }
  return steps;
}

/**
 * Waiting ids in projected policy order, for `projectedPosition`. The doctor is treated as free at
 * `now`; each served patient advances simulated time by `avgServiceMin`. Always a permutation of
 * the waiting ids.
 */
export function projectOrder(
  input: ProjectionInput,
  policy: Policy,
  now: Instant,
  avgServiceMin: number,
): string[] {
  const steps = simulatePolicyOrder(input, policy, toMs(now), avgServiceMin);
  const ordered = steps.map((s) => s.candidateId);
  if (ordered.length === input.entries.filter((e) => e.state === 'waiting').length) return ordered;
  // Only reachable with a rotation lacking a group: append the rest in a stable order.
  const placed = new Set(ordered);
  const rest = input.entries
    .filter((e) => e.state === 'waiting' && !placed.has(e.id))
    .sort((a, b) => cmpNum(toMs(a.eligibleAt), toMs(b.eligibleAt)) || cmpNum(a.seq, b.seq) || cmpStr(a.id, b.id));
  return [...ordered, ...rest.map((e) => e.id)];
}
