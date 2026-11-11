import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, projectOrder, selectNext } from '../src/index.js';
import type { Candidate, Policy, SelectionInput } from '../src/index.js';
import { MIN, at, cand } from './helpers.js';

const free = (entries: Candidate[], rotationPointer = 0): SelectionInput => ({
  entries,
  rotationPointer,
  sessionCallable: true,
  doctorOccupied: false,
});

const a = (id: string, scheduled: number, checkedIn: number, seq: number, extra: Partial<Candidate> = {}): Candidate =>
  cand({ id, group: 'A', seq, scheduledAt: at(scheduled), checkedInAt: at(checkedIn), eligibleAt: at(checkedIn), ...extra });
const w = (id: string, checkedIn: number, seq: number, extra: Partial<Candidate> = {}): Candidate =>
  cand({ id, group: 'W', seq, checkedInAt: at(checkedIn), eligibleAt: at(checkedIn), ...extra });

describe('selectNext: no allocation', () => {
  const entries = [a('A1', 0, 0, 1), w('W1', 0, 2)];

  it('doctor occupied: nothing is selected even with priority waiting (non-preemption)', () => {
    const d = selectNext(
      { entries: [...entries, w('P', 0, 3, { priorityClass: 1 })], rotationPointer: 1, sessionCallable: true, doctorOccupied: true },
      DEFAULT_POLICY,
      at(5),
    );
    expect(d).toMatchObject({ candidateId: null, reason: 'NO_ALLOCATION', pointerBefore: 1, pointerAfter: 1, rotationSlot: null });
    expect(d.explanation).toMatch(/active call or consultation/);
    expect(d.eligibleIds).toHaveLength(3);
  });

  it('session not callable', () => {
    const d = selectNext({ ...free(entries), sessionCallable: false }, DEFAULT_POLICY, at(5));
    expect(d.reason).toBe('NO_ALLOCATION');
    expect(d.explanation).toMatch(/not accepting new calls/);
  });

  it('nothing eligible, including entries whose eligible time has not come', () => {
    const d = selectNext(free([a('A1', 30, 0, 1, { eligibleAt: at(20) })]), DEFAULT_POLICY, at(5));
    expect(d).toMatchObject({ candidateId: null, reason: 'NO_ALLOCATION', eligibleIds: [] });
    expect(d.explanation).toMatch(/No eligible patients/);
    expect(selectNext(free([]), DEFAULT_POLICY, at(5)).reason).toBe('NO_ALLOCATION');
  });

  it('ignores called, in-service and other non-waiting entries', () => {
    const d = selectNext(
      free([
        a('A1', 0, 0, 1, { state: 'called' }),
        a('A2', 0, 0, 2, { state: 'in_service' }),
        w('W1', 0, 3, { state: 'absent' }),
        w('W2', 0, 4, { state: 'skipped' }),
        w('W3', 0, 5, { state: 'cancelled' }),
        w('W4', 0, 6, { state: 'completed' }),
      ]),
      DEFAULT_POLICY,
      at(5),
    );
    expect(d.candidateId).toBeNull();
  });

  it('a rotation without a turn for the waiting group yields NO_ALLOCATION instead of looping', () => {
    const onlyA: Policy = { ...DEFAULT_POLICY, rotation: ['A'] };
    const d = selectNext(free([w('W1', 0, 1)]), onlyA, at(5));
    expect(d).toMatchObject({ candidateId: null, reason: 'NO_ALLOCATION' });
    expect(d.explanation).toMatch(/no turn/);
  });
});

describe('selectNext: tie-breakers', () => {
  it('appointments: scheduled time, then check-in time, then sequence', () => {
    // Earlier scheduled time wins even when checked in later.
    expect(selectNext(free([a('late', 10, 0, 1), a('early', 5, 4, 2)]), DEFAULT_POLICY, at(5)).candidateId).toBe('early');
    // Same scheduled time: earlier check-in.
    expect(selectNext(free([a('x', 10, 4, 1), a('y', 10, 2, 2)]), DEFAULT_POLICY, at(5)).candidateId).toBe('y');
    // Same schedule and check-in: lower seq, regardless of array order.
    expect(selectNext(free([a('s2', 10, 2, 2), a('s1', 10, 2, 1)]), DEFAULT_POLICY, at(5)).candidateId).toBe('s1');
  });

  it('appointments with the same everything fall back to id', () => {
    expect(selectNext(free([a('b', 10, 2, 1), a('a', 10, 2, 1)]), DEFAULT_POLICY, at(5)).candidateId).toBe('a');
  });

  it('walk-ins: accepted check-in time, then sequence', () => {
    const p = { ...DEFAULT_POLICY, rotation: ['W'] as const };
    expect(selectNext(free([w('w2', 3, 1), w('w1', 1, 2)]), p, at(5)).candidateId).toBe('w1');
    expect(selectNext(free([w('wb', 1, 2), w('wa', 1, 1)]), p, at(5)).candidateId).toBe('wa');
  });

  it('priority: best class, then longest eligible wait, then sequence', () => {
    const pool = [
      w('c2-old', 0, 1, { priorityClass: 2 }),
      w('c1-new', 4, 2, { priorityClass: 1 }),
      w('c1-old', 2, 3, { priorityClass: 1 }),
      w('c1-old-seq', 2, 0, { priorityClass: 1 }),
      a('plain', 0, 0, 5),
    ];
    const d = selectNext(free(pool), DEFAULT_POLICY, at(10));
    expect(d.candidateId).toBe('c1-old-seq');
    expect(selectNext(free(pool.filter((e) => e.id !== 'c1-old-seq')), DEFAULT_POLICY, at(10)).candidateId).toBe('c1-old');
    expect(selectNext(free(pool.filter((e) => !e.id.startsWith('c1'))), DEFAULT_POLICY, at(10)).candidateId).toBe('c2-old');
  });

  it('priority works across groups and with class 3', () => {
    const d = selectNext(free([a('A1', 0, 0, 1), w('P3', 5, 2, { priorityClass: 3 })]), DEFAULT_POLICY, at(6));
    expect(d.candidateId).toBe('P3');
    expect(d.explanation).toBe('Clinical priority (class 3)');
  });

  it('a priority entry that is not yet eligible does not pre-empt', () => {
    const d = selectNext(free([a('A1', 0, 0, 1), w('P1', 30, 2, { priorityClass: 1 })]), DEFAULT_POLICY, at(6));
    expect(d.candidateId).toBe('A1');
  });
});

describe('selectNext: aging', () => {
  it('triggers at exactly 45 minutes and not at 44:59', () => {
    const pool = [w('old', 0, 1), a('A1', 100, 40, 2, { eligibleAt: at(40) })];
    const at44 = selectNext(free(pool, 0), DEFAULT_POLICY, at(0) + 44 * MIN + 59_000);
    expect(at44.reason).toBe('ROTATION');
    const at45 = selectNext(free(pool, 0), DEFAULT_POLICY, at(45));
    expect(at45).toMatchObject({
      candidateId: 'old',
      reason: 'AGING',
      rotationSlot: null,
      pointerBefore: 0,
      pointerAfter: 0,
      explanation: 'Aging: waited 45 min',
    });
  });

  it('floors the minutes and picks the oldest wait, then sequence', () => {
    const pool = [w('newer', 5, 1), w('oldest-hi-seq', 0, 9), w('oldest-lo-seq', 0, 2)];
    const d = selectNext(free(pool, 2), DEFAULT_POLICY, at(47) + 30_000);
    expect(d).toMatchObject({ candidateId: 'oldest-lo-seq', reason: 'AGING', pointerAfter: 2, explanation: 'Aging: waited 47 min' });
  });

  it('beats the rotation even when the rotation would serve the other group', () => {
    const pool = [a('A1', 100, 40, 1, { eligibleAt: at(40) }), w('oldW', 0, 2)];
    const d = selectNext(free(pool, 0), DEFAULT_POLICY, at(50));
    expect(d.candidateId).toBe('oldW');
    expect(d.reason).toBe('AGING');
  });

  it('is beaten by clinical priority', () => {
    const pool = [w('old', 0, 1), w('P', 40, 2, { priorityClass: 2 })];
    expect(selectNext(free(pool), DEFAULT_POLICY, at(60)).reason).toBe('CLINICAL_PRIORITY');
  });

  it('uses eligible time, not check-in time, for the wait', () => {
    // Checked in 60 min ago but only eligible 10 min ago.
    const early = a('A1', 60, 0, 1, { eligibleAt: at(50) });
    const d = selectNext(free([early]), DEFAULT_POLICY, at(60));
    expect(d.reason).toBe('ROTATION');
  });
});

describe('selectNext: rotation', () => {
  it('follows A, A, W from the pointer with abundant candidates', () => {
    let pool = [a('A1', 0, 0, 1), a('A2', 1, 0, 2), a('A3', 2, 0, 3), a('A4', 3, 0, 4), w('W1', 0, 5), w('W2', 0, 6)];
    let pointer = 0;
    const order: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const d = selectNext(free(pool, pointer), DEFAULT_POLICY, at(5));
      order.push(d.candidateId as string);
      pool = pool.filter((e) => e.id !== d.candidateId);
      pointer = d.pointerAfter;
    }
    expect(order).toEqual(['A1', 'A2', 'W1', 'A3', 'A4', 'W2']);
  });

  it('starts from a non-zero pointer', () => {
    const d = selectNext(free([a('A1', 0, 0, 1), w('W1', 0, 2)], 2), DEFAULT_POLICY, at(5));
    expect(d).toMatchObject({ candidateId: 'W1', rotationSlot: 2, pointerBefore: 2, pointerAfter: 0 });
  });

  it('empty W: the W position is skipped and the pointer lands past the A actually served', () => {
    const d = selectNext(free([a('A1', 0, 0, 1)], 2), DEFAULT_POLICY, at(5));
    expect(d).toMatchObject({ candidateId: 'A1', rotationSlot: 0, pointerBefore: 2, pointerAfter: 1 });
    expect(d.explanation).toBe('Called by rotation: 1st appointment of A, A, W; walk-in turn skipped (no walk-ins waiting)');
  });

  it('normalizes an out-of-range pointer', () => {
    const d = selectNext(free([a('A1', 0, 0, 1), w('W1', 0, 2)], 5), DEFAULT_POLICY, at(5));
    expect(d.pointerBefore).toBe(2);
    expect(d.candidateId).toBe('W1');
  });

  it('works with other rotations and ordinals', () => {
    const p: Policy = { ...DEFAULT_POLICY, version: 2, rotation: ['A', 'W', 'A', 'W', 'A', 'W', 'A', 'W', 'A', 'W', 'A', 'W', 'A'] };
    const d = selectNext(free([a('A1', 0, 0, 1)], 12), p, at(5));
    expect(d.explanation).toBe('Called by rotation: 7th appointment of A, W, A, W, A, W, A, W, A, W, A, W, A');
    expect(d.policyVersion).toBe(2);
    const p2: Policy = { ...DEFAULT_POLICY, rotation: ['W', 'W', 'W', 'W', 'W', 'W', 'W', 'W', 'W', 'W', 'W', 'W', 'A'] };
    const wl = Array.from({ length: 1 }, () => w('W1', 0, 1));
    expect(selectNext(free(wl, 10), p2, at(5)).explanation).toMatch(/^Called by rotation: 11th walk-in of /);
    expect(selectNext(free(wl, 1), p2, at(5)).explanation).toMatch(/^Called by rotation: 2nd walk-in of /);
    expect(selectNext(free(wl, 2), p2, at(5)).explanation).toMatch(/^Called by rotation: 3rd walk-in of /);
    // 12th is the 12th W; 12, 13 and 11 are the English exceptions.
    expect(selectNext(free(wl, 11), p2, at(5)).explanation).toMatch(/^Called by rotation: 12th walk-in of /);
  });

  it('a late admission (group W, no scheduled time) follows walk-in order', () => {
    const late = cand({ id: 'late', group: 'W', seq: 1, scheduledAt: null, checkedInAt: at(20), eligibleAt: at(20) });
    const walk = w('walk', 22, 2);
    const p = { ...DEFAULT_POLICY, rotation: ['W'] as const };
    expect(selectNext(free([walk, late]), p, at(30)).candidateId).toBe('late');
  });

  it('an appointment entry with a null scheduled time sorts after dated ones', () => {
    const noDate = cand({ id: 'nodate', group: 'A', seq: 1, scheduledAt: null, checkedInAt: at(0), eligibleAt: at(0) });
    expect(selectNext(free([noDate, a('dated', 30, 4, 2)]), DEFAULT_POLICY, at(5)).candidateId).toBe('dated');
  });
});

describe('projectOrder', () => {
  it('lists waiting ids in A, A, W order and ignores other states', () => {
    const entries = [
      a('A1', 0, 0, 1),
      a('A2', 1, 0, 2),
      a('A3', 2, 0, 3),
      w('W1', 0, 4),
      w('W2', 1, 5),
      a('busy', 0, 0, 6, { state: 'called' }),
    ];
    expect(projectOrder({ entries, rotationPointer: 0 }, DEFAULT_POLICY, at(5), 12)).toEqual(['A1', 'A2', 'W1', 'A3', 'W2']);
  });

  it('honours the pointer, priority and entries that become eligible later', () => {
    const entries = [
      a('A1', 0, 0, 1),
      w('W1', 0, 2),
      w('P', 3, 3, { priorityClass: 1 }),
      a('A-future', 90, 0, 4, { eligibleAt: at(80) }),
    ];
    // Priority first, then pointer 2 serves W, then A, then the future appointment once eligible.
    expect(projectOrder({ entries, rotationPointer: 2 }, DEFAULT_POLICY, at(5), 12)).toEqual(['P', 'W1', 'A1', 'A-future']);
  });

  it('aging over simulated time can reorder the queue', () => {
    // Rotation A, A, A, W: without aging W1 would be served fourth. W1 has waited since 09:00.
    const policy: Policy = { ...DEFAULT_POLICY, rotation: ['A', 'A', 'A', 'W'] };
    const entries = [
      a('A1', 0, 20, 1, { eligibleAt: at(20) }),
      a('A2', 1, 20, 2, { eligibleAt: at(20) }),
      a('A3', 2, 20, 3, { eligibleAt: at(20) }),
      a('A4', 3, 20, 4, { eligibleAt: at(20) }),
      w('W1', 0, 5),
    ];
    // Decisions at 30 (A1, W1 waited 30), 42 (A2, waited 42), 54 (W1 has waited 54 >= 45: aging overtakes A3).
    expect(projectOrder({ entries, rotationPointer: 0 }, policy, at(30), 12)).toEqual(['A1', 'A2', 'W1', 'A3', 'A4']);
    // Starting later, W1 has already crossed the trigger at the first decision and goes first.
    expect(projectOrder({ entries, rotationPointer: 0 }, policy, at(46), 12)).toEqual(['W1', 'A1', 'A2', 'A3', 'A4']);
    // Control: a fast clock (2-minute consultations) never lets W1 age, so rotation order holds.
    expect(projectOrder({ entries, rotationPointer: 0 }, policy, at(30), 2)).toEqual(['A1', 'A2', 'A3', 'W1', 'A4']);
  });

  it('rejects a non-positive service estimate', () => {
    expect(() => projectOrder({ entries: [], rotationPointer: 0 }, DEFAULT_POLICY, at(0), 0)).toThrow(RangeError);
    expect(() => projectOrder({ entries: [], rotationPointer: 0 }, DEFAULT_POLICY, at(0), Number.NaN)).toThrow(RangeError);
  });

  it('still returns every waiting id when the rotation lacks a group', () => {
    const onlyA: Policy = { ...DEFAULT_POLICY, rotation: ['A'] };
    const entries = [a('A1', 0, 0, 1), w('W2', 2, 3), w('W1', 1, 2)];
    expect(projectOrder({ entries, rotationPointer: 0 }, onlyA, at(5), 12)).toEqual(['A1', 'W1', 'W2']);
  });
});
