import { isEligible } from './eligibility.js';
import { normalizePointer, rotationLabel } from './policy.js';
import type { Policy } from './policy.js';
import { MINUTE_MS, cmpNum, cmpStr, toMs } from './types.js';
import type { DecisionReason, Group, Instant, PriorityClass, QueueEntryState } from './types.js';

/** One queue entry as the selector sees it. */
export interface Candidate {
  id: string;
  group: Group;
  /** Stable entry sequence; the last tie-breaker (then id). */
  seq: number;
  state: QueueEntryState;
  /** Appointment scheduled time; null for walk-ins and late admissions. */
  scheduledAt: Instant | null;
  /** Accepted check-in time. */
  checkedInAt: Instant;
  eligibleAt: Instant;
  /** Authorized clinical priority class, 1 = most urgent; null = none. */
  priorityClass: PriorityClass | null;
}

export interface SelectionInput {
  entries: readonly Candidate[];
  /** Index into policy.rotation of the next position to inspect. */
  rotationPointer: number;
  /** False when the session is paused, unavailable, closed or not yet open. */
  sessionCallable: boolean;
  /** True when the doctor already has a called or in-service entry (non-preemptive). */
  doctorOccupied: boolean;
}

export interface Selection {
  candidateId: string | null;
  reason: DecisionReason;
  /** Rotation position that was served; null for overrides and NO_ALLOCATION. */
  rotationSlot: number | null;
  pointerBefore: number;
  pointerAfter: number;
  /** Plain words, as the doctor console shows them. */
  explanation: string;
  /** Every entry that was eligible at the decision time, oldest eligible first. */
  eligibleIds: string[];
  policyVersion: number;
}

interface Item {
  c: Candidate;
  scheduled: number;
  checkedIn: number;
  eligible: number;
}

function toItem(c: Candidate): Item {
  return {
    c,
    scheduled: c.scheduledAt === null ? Number.POSITIVE_INFINITY : toMs(c.scheduledAt),
    checkedIn: toMs(c.checkedInAt),
    eligible: toMs(c.eligibleAt),
  };
}

// Comparators. Every one ends in (seq, id) so the order is total and independent of input order.
const tail = (a: Item, b: Item): number => cmpNum(a.c.seq, b.c.seq) || cmpStr(a.c.id, b.c.id);

/** Oldest eligible wait first. */
const byEligibleWait = (a: Item, b: Item): number => cmpNum(a.eligible, b.eligible) || tail(a, b);

/** Best clinical class, then longest eligible wait. */
const byPriority = (a: Item, b: Item): number =>
  cmpNum(a.c.priorityClass ?? 99, b.c.priorityClass ?? 99) || byEligibleWait(a, b);

/** Appointment order: scheduled time, check-in time, sequence. */
const byAppointmentOrder = (a: Item, b: Item): number =>
  cmpNum(a.scheduled, b.scheduled) || cmpNum(a.checkedIn, b.checkedIn) || tail(a, b);

/** Walk-in order: accepted check-in time, sequence. */
const byWalkInOrder = (a: Item, b: Item): number => cmpNum(a.checkedIn, b.checkedIn) || tail(a, b);

/** Linear scan for the minimum: O(n), no auxiliary structure. */
function best(items: readonly Item[], cmp: (a: Item, b: Item) => number): Item | undefined {
  let winner: Item | undefined;
  for (const item of items) {
    if (winner === undefined || cmp(item, winner) < 0) winner = item;
  }
  return winner;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

const NOUN: Record<Group, { turn: string; none: string }> = {
  A: { turn: 'appointment', none: 'no appointments waiting' },
  W: { turn: 'walk-in', none: 'no walk-ins waiting' },
};

function rotationExplanation(policy: Policy, slot: number, skipped: readonly Group[]): string {
  const group = policy.rotation[slot] as Group;
  const total = policy.rotation.filter((g) => g === group).length;
  const nth = policy.rotation.slice(0, slot + 1).filter((g) => g === group).length;
  const noun = NOUN[group].turn;
  const served = total === 1 ? `${noun} turn` : `${ordinal(nth)} ${noun}`;
  let text = `Called by rotation: ${served} of ${rotationLabel(policy)}`;
  const seen = new Set<Group>();
  for (const g of skipped) {
    if (seen.has(g)) continue;
    seen.add(g);
    text += `; ${NOUN[g].turn} turn skipped (${NOUN[g].none})`;
  }
  return text;
}

/**
 * Report section 6.4 selection procedure. Pure and deterministic: the same entries (in any order),
 * pointer, flags, policy and decision time always give the same candidate, reason and explanation.
 *
 * Order of rules:
 * 1. Doctor occupied, session not callable or nothing eligible: NO_ALLOCATION (pointer unchanged).
 * 2. Authorized clinical priority: best class, longest eligible wait, sequence. Pointer unchanged.
 * 3. Aging: oldest eligible wait at or beyond the trigger, then sequence. Pointer unchanged.
 * 4. Rotation from the pointer; empty groups are skipped without saving credits and the pointer
 *    advances past the position actually served.
 */
export function selectNext(input: SelectionInput, policy: Policy, now: Instant): Selection {
  const nowMs = toMs(now);
  const n = policy.rotation.length;
  const pointer = normalizePointer(input.rotationPointer, n);

  const eligible = input.entries.filter((e) => isEligible(e, nowMs)).map(toItem);
  const eligibleIds = [...eligible].sort(byEligibleWait).map((i) => i.c.id);

  const none = (explanation: string): Selection => ({
    candidateId: null,
    reason: 'NO_ALLOCATION',
    rotationSlot: null,
    pointerBefore: pointer,
    pointerAfter: pointer,
    explanation,
    eligibleIds,
    policyVersion: policy.version,
  });
  const override = (item: Item, reason: DecisionReason, explanation: string): Selection => ({
    candidateId: item.c.id,
    reason,
    rotationSlot: null,
    pointerBefore: pointer,
    pointerAfter: pointer,
    explanation,
    eligibleIds,
    policyVersion: policy.version,
  });

  if (input.doctorOccupied) return none('Doctor already has an active call or consultation');
  if (!input.sessionCallable) return none('Session is not accepting new calls');
  if (eligible.length === 0) return none('No eligible patients are waiting');

  // Clinical priority.
  const prioritized = eligible.filter((i) => i.c.priorityClass !== null);
  const priority = best(prioritized, byPriority);
  if (priority !== undefined) {
    return override(priority, 'CLINICAL_PRIORITY', `Clinical priority (class ${priority.c.priorityClass})`);
  }

  // Aging: the oldest eligible wait, if it has reached the trigger.
  const oldest = best(eligible, byEligibleWait) as Item;
  const waitedMs = nowMs - oldest.eligible;
  if (waitedMs >= policy.agingTriggerMin * MINUTE_MS) {
    return override(oldest, 'AGING', `Aging: waited ${Math.floor(waitedMs / MINUTE_MS)} min`);
  }

  // Normal rotation.
  const appointments = eligible.filter((i) => i.c.group === 'A');
  const walkIns = eligible.filter((i) => i.c.group === 'W');
  const skipped: Group[] = [];
  for (let step = 0; step < n; step += 1) {
    const slot = (pointer + step) % n;
    const group = policy.rotation[slot] as Group;
    const winner =
      group === 'A' ? best(appointments, byAppointmentOrder) : best(walkIns, byWalkInOrder);
    if (winner !== undefined) {
      return {
        candidateId: winner.c.id,
        reason: 'ROTATION',
        rotationSlot: slot,
        pointerBefore: pointer,
        pointerAfter: (slot + 1) % n,
        explanation: rotationExplanation(policy, slot, skipped),
        eligibleIds,
        policyVersion: policy.version,
      };
    }
    skipped.push(group);
  }
  return none('Rotation has no turn for the groups that are waiting');
}
