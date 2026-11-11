import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, computeEligibleAt, selectNext } from '../src/index.js';
import type { Candidate, Selection } from '../src/index.js';
import { at, cand } from './helpers.js';

/**
 * Report Table 8 (selection trace), reproduced as five consecutive decisions with the doctor
 * becoming free between them and nobody crossing the 45-minute aging threshold.
 *
 *  1  A1, A2, W1 eligible, no override      -> A1  pointer after: Second A (index 1)
 *  2  P1 receives authorized priority       -> P1  pointer unchanged (index 1)
 *  3  A2 and W1 remain eligible             -> A2  pointer after: W (index 2)
 *  4  W1 remains eligible                   -> W1  pointer after: First A (index 0)
 *  5  only W2 eligible                      -> W2 after empty A positions, pointer First A (index 0)
 *
 * Clock origin 09:00. Decisions at 09:06, 09:18, 09:30, 09:42, 09:54.
 */
const policy = DEFAULT_POLICY;

function buildEntries(): Candidate[] {
  const a1Sched = at(0);
  const a2Sched = at(10);
  const a1CheckIn = at(-5);
  const a2CheckIn = at(-2);
  return [
    cand({
      id: 'A1',
      group: 'A',
      seq: 1,
      scheduledAt: a1Sched,
      checkedInAt: a1CheckIn,
      eligibleAt: computeEligibleAt({ kind: 'appointment', scheduledAt: a1Sched, checkedInAt: a1CheckIn }, policy),
    }),
    cand({
      id: 'A2',
      group: 'A',
      seq: 2,
      scheduledAt: a2Sched,
      checkedInAt: a2CheckIn,
      eligibleAt: computeEligibleAt({ kind: 'appointment', scheduledAt: a2Sched, checkedInAt: a2CheckIn }, policy),
    }),
    cand({
      id: 'W1',
      group: 'W',
      seq: 3,
      checkedInAt: at(2),
      eligibleAt: computeEligibleAt({ kind: 'walkin', acceptedAt: at(2) }, policy),
    }),
    // P1 is a walk-in who checks in at 09:10; the doctor assigns clinical priority class 1 before decision 2.
    cand({
      id: 'P1',
      group: 'W',
      seq: 4,
      checkedInAt: at(10),
      eligibleAt: computeEligibleAt({ kind: 'walkin', acceptedAt: at(10) }, policy),
      priorityClass: 1,
    }),
    // W2 arrives at 09:45, after decision 4.
    cand({
      id: 'W2',
      group: 'W',
      seq: 5,
      checkedInAt: at(45),
      eligibleAt: computeEligibleAt({ kind: 'walkin', acceptedAt: at(45) }, policy),
    }),
  ];
}

describe('Table 8 golden trace', () => {
  it('reproduces the five decisions with the report pointer values', () => {
    // The entry pool is fixed; eligibility over time and the doctor freeing between decisions do the rest.
    let remaining = buildEntries();
    let pointer = 0; // First A
    const trace: Selection[] = [];
    const decisionTimes = [6, 18, 30, 42, 54];

    for (const minute of decisionTimes) {
      const now = at(minute);

      // While the doctor is occupied nothing is allocated, whatever is waiting (non-preemptive).
      const occupied = selectNext(
        { entries: remaining, rotationPointer: pointer, sessionCallable: true, doctorOccupied: true },
        policy,
        now,
      );
      expect(occupied.reason).toBe('NO_ALLOCATION');
      expect(occupied.candidateId).toBeNull();
      expect(occupied.pointerAfter).toBe(pointer);

      // The doctor becomes available.
      const decision = selectNext(
        { entries: remaining, rotationPointer: pointer, sessionCallable: true, doctorOccupied: false },
        policy,
        now,
      );
      trace.push(decision);
      remaining = remaining.filter((e) => e.id !== decision.candidateId);
      pointer = decision.pointerAfter;
    }

    expect(trace.map((d) => d.candidateId)).toEqual(['A1', 'P1', 'A2', 'W1', 'W2']);
    expect(trace.map((d) => d.reason)).toEqual(['ROTATION', 'CLINICAL_PRIORITY', 'ROTATION', 'ROTATION', 'ROTATION']);
    expect(trace.map((d) => d.pointerBefore)).toEqual([0, 1, 1, 2, 0]);
    // Second A / unchanged / W / First A / First A
    expect(trace.map((d) => d.pointerAfter)).toEqual([1, 1, 2, 0, 0]);
    expect(trace.map((d) => d.rotationSlot)).toEqual([0, null, 1, 2, 2]);
    expect(trace.every((d) => d.policyVersion === 1)).toBe(true);
  });

  it('decision 1: A1, A2 and W1 are the eligible set', () => {
    const d = selectNext(
      { entries: buildEntries(), rotationPointer: 0, sessionCallable: true, doctorOccupied: false },
      policy,
      at(6),
    );
    expect([...d.eligibleIds].sort()).toEqual(['A1', 'A2', 'W1']);
    expect(d.explanation).toBe('Called by rotation: 1st appointment of A, A, W');
  });

  it('decision 2: authorized priority beats the rotation and leaves the pointer alone', () => {
    const d = selectNext(
      { entries: buildEntries().filter((e) => e.id !== 'A1'), rotationPointer: 1, sessionCallable: true, doctorOccupied: false },
      policy,
      at(18),
    );
    expect(d).toMatchObject({
      candidateId: 'P1',
      reason: 'CLINICAL_PRIORITY',
      rotationSlot: null,
      pointerBefore: 1,
      pointerAfter: 1,
      explanation: 'Clinical priority (class 1)',
    });
  });

  it('decision 3 and 4 explanations name the rotation turn', () => {
    const entries = buildEntries().filter((e) => e.id !== 'A1' && e.id !== 'P1');
    const d3 = selectNext({ entries, rotationPointer: 1, sessionCallable: true, doctorOccupied: false }, policy, at(30));
    expect(d3.explanation).toBe('Called by rotation: 2nd appointment of A, A, W');
    const d4 = selectNext(
      { entries: entries.filter((e) => e.id !== 'A2'), rotationPointer: 2, sessionCallable: true, doctorOccupied: false },
      policy,
      at(42),
    );
    expect(d4.explanation).toBe('Called by rotation: walk-in turn of A, A, W');
  });

  it('decision 5: only W2 eligible; the empty A positions are skipped without saving credits', () => {
    const entries = buildEntries().filter((e) => e.id === 'W2');
    const d = selectNext({ entries, rotationPointer: 0, sessionCallable: true, doctorOccupied: false }, policy, at(54));
    expect(d.candidateId).toBe('W2');
    expect(d.rotationSlot).toBe(2);
    expect(d.pointerAfter).toBe(0);
    expect(d.explanation).toBe(
      'Called by rotation: walk-in turn of A, A, W; appointment turn skipped (no appointments waiting)',
    );
  });

  it('nobody crosses the aging threshold in the trace', () => {
    // Longest wait at any decision is A2 at 30 min and W1 at 40 min, both under 45.
    expect(at(30) - at(0)).toBeLessThan(45 * 60_000);
    expect(at(42) - at(2)).toBeLessThan(45 * 60_000);
  });
});
