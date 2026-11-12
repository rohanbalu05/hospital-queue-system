import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, isEligible, projectEta, projectOrder, selectNext } from '../src/index.js';
import type { Candidate, Group, Policy, SelectionInput } from '../src/index.js';
import { MIN, at } from './helpers.js';

const RUNS = { numRuns: 300 };

// ---------------------------------------------------------------------------------------------
// Generators. Times are small whole-minute values so that ties (the interesting cases) are common.
// ---------------------------------------------------------------------------------------------

const policies: Policy[] = [
  DEFAULT_POLICY,
  { ...DEFAULT_POLICY, rotation: ['A', 'W'] },
  { ...DEFAULT_POLICY, rotation: ['A', 'A', 'A', 'W'] },
  { ...DEFAULT_POLICY, rotation: ['W', 'A', 'A', 'W', 'A'] },
  { ...DEFAULT_POLICY, rotation: ['W'] }, // degenerate: no A turn at all
];
const policyArb = fc.constantFrom(...policies);
const validPolicyArb = fc.constantFrom(...policies.slice(0, 4));

const rawCandidate = fc.record({
  group: fc.constantFrom<Group>('A', 'W'),
  state: fc.constantFrom('waiting', 'waiting', 'waiting', 'waiting', 'called', 'in_service', 'completed', 'skipped', 'absent', 'cancelled'),
  scheduled: fc.option(fc.integer({ min: -20, max: 100 }), { nil: null }),
  checkedIn: fc.integer({ min: -20, max: 100 }),
  eligible: fc.integer({ min: -20, max: 100 }),
  priority: fc.constantFrom(null, null, null, null, 1, 2, 3),
  seq: fc.integer({ min: 1, max: 6 }), // duplicates on purpose: id is the final tie-breaker
});

const entriesArb = fc.array(rawCandidate, { maxLength: 14 }).map((raws): Candidate[] =>
  raws.map((r, i) => ({
    id: `e${String(i).padStart(2, '0')}`,
    group: r.group,
    seq: r.seq,
    state: r.state as Candidate['state'],
    scheduledAt: r.group === 'A' && r.scheduled !== null ? at(r.scheduled) : null,
    checkedInAt: at(r.checkedIn),
    eligibleAt: at(r.eligible),
    priorityClass: r.priority as Candidate['priorityClass'],
  })),
);

interface Scenario {
  entries: Candidate[];
  pointer: number;
  nowMin: number;
  policy: Policy;
  keys: number[];
}

const scenarioArb = (pol: fc.Arbitrary<Policy> = policyArb): fc.Arbitrary<Scenario> =>
  fc.record({
    entries: entriesArb,
    pointer: fc.integer({ min: -4, max: 9 }),
    nowMin: fc.integer({ min: -10, max: 180 }),
    policy: pol,
    keys: fc.array(fc.integer(), { minLength: 14, maxLength: 14 }),
  });

const input = (s: Scenario, flags: Partial<SelectionInput> = {}): SelectionInput => ({
  entries: s.entries,
  rotationPointer: s.pointer,
  sessionCallable: true,
  doctorOccupied: false,
  ...flags,
});

const shuffled = (s: Scenario): Candidate[] =>
  s.entries
    .map((e, i) => [s.keys[i] ?? 0, e] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([, e]) => e);

// ---------------------------------------------------------------------------------------------
// Independent oracle for orderings.
// ---------------------------------------------------------------------------------------------

const ms = (v: Candidate['eligibleAt']): number => (typeof v === 'number' ? v : v.getTime());
const num = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);
const str = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const lastTie = (a: Candidate, b: Candidate): number => num(a.seq, b.seq) || str(a.id, b.id);
const oracle = {
  priority: (a: Candidate, b: Candidate) =>
    num(a.priorityClass ?? 99, b.priorityClass ?? 99) || num(ms(a.eligibleAt), ms(b.eligibleAt)) || lastTie(a, b),
  oldest: (a: Candidate, b: Candidate) => num(ms(a.eligibleAt), ms(b.eligibleAt)) || lastTie(a, b),
  appointment: (a: Candidate, b: Candidate) =>
    num(a.scheduledAt === null ? Infinity : ms(a.scheduledAt), b.scheduledAt === null ? Infinity : ms(b.scheduledAt)) ||
    num(ms(a.checkedInAt), ms(b.checkedInAt)) ||
    lastTie(a, b),
  walkIn: (a: Candidate, b: Candidate) => num(ms(a.checkedInAt), ms(b.checkedInAt)) || lastTie(a, b),
};
const minOf = (list: Candidate[], cmp: (a: Candidate, b: Candidate) => number): Candidate | undefined =>
  [...list].sort(cmp)[0];

describe('selectNext properties', () => {
  it('is deterministic, including under shuffled input order', () => {
    fc.assert(
      fc.property(scenarioArb(), fc.boolean(), fc.boolean(), (s, callable, occupied) => {
        const now = at(s.nowMin);
        const flags = { sessionCallable: callable, doctorOccupied: occupied };
        const first = selectNext(input(s, flags), s.policy, now);
        expect(selectNext(input(s, flags), s.policy, now)).toEqual(first);
        expect(selectNext({ ...input(s, flags), entries: shuffled(s) }, s.policy, now)).toEqual(first);
        expect(selectNext({ ...input(s, flags), entries: [...s.entries].reverse() }, s.policy, new Date(now))).toEqual(first);
      }),
      RUNS,
    );
  });

  it('does not mutate its input', () => {
    fc.assert(
      fc.property(scenarioArb(), (s) => {
        const before = structuredClone(s.entries);
        selectNext(input(s), s.policy, at(s.nowMin));
        expect(s.entries).toEqual(before);
      }),
      RUNS,
    );
  });

  it('only ever selects a present, waiting, eligible entry, and eligibleIds is exactly that set', () => {
    fc.assert(
      fc.property(scenarioArb(), (s) => {
        const now = at(s.nowMin);
        const d = selectNext(input(s), s.policy, now);
        const eligible = s.entries.filter((e) => isEligible(e, now));
        expect([...d.eligibleIds].sort()).toEqual(eligible.map((e) => e.id).sort());
        if (d.candidateId !== null) {
          const chosen = s.entries.find((e) => e.id === d.candidateId);
          expect(chosen).toBeDefined();
          expect(chosen?.state).toBe('waiting');
          expect(ms(chosen?.eligibleAt as number)).toBeLessThanOrEqual(now);
          expect(d.eligibleIds).toContain(d.candidateId);
        } else {
          expect(d.reason).toBe('NO_ALLOCATION');
        }
      }),
      RUNS,
    );
  });

  it('NO_ALLOCATION when the doctor is occupied or the session is not callable; the pointer is unchanged', () => {
    fc.assert(
      fc.property(scenarioArb(), fc.boolean(), (s, occupiedNotCallable) => {
        const flags = occupiedNotCallable
          ? { doctorOccupied: true }
          : { sessionCallable: false };
        const d = selectNext(input(s, flags), s.policy, at(s.nowMin));
        expect(d.candidateId).toBeNull();
        expect(d.reason).toBe('NO_ALLOCATION');
        expect(d.rotationSlot).toBeNull();
        expect(d.pointerAfter).toBe(d.pointerBefore);
      }),
      RUNS,
    );
  });

  it('NO_ALLOCATION when nothing is eligible, regardless of what else is present', () => {
    fc.assert(
      fc.property(scenarioArb(), (s) => {
        const now = at(s.nowMin);
        const none = s.entries.filter((e) => !isEligible(e, now));
        const d = selectNext({ ...input(s), entries: none }, s.policy, now);
        expect(d).toMatchObject({ candidateId: null, reason: 'NO_ALLOCATION', eligibleIds: [] });
        expect(d.pointerAfter).toBe(d.pointerBefore);
      }),
      RUNS,
    );
  });

  it('clinical priority wins when any eligible entry has one: best class, longest wait, sequence', () => {
    fc.assert(
      fc.property(scenarioArb(), (s) => {
        const now = at(s.nowMin);
        const eligible = s.entries.filter((e) => isEligible(e, now));
        const prioritized = eligible.filter((e) => e.priorityClass !== null);
        const d = selectNext(input(s), s.policy, now);
        fc.pre(prioritized.length > 0);
        expect(d.reason).toBe('CLINICAL_PRIORITY');
        expect(d.candidateId).toBe(minOf(prioritized, oracle.priority)?.id);
        expect(d.rotationSlot).toBeNull();
      }),
      RUNS,
    );
  });

  it('aging wins when no priority exists and the oldest eligible wait has reached the trigger', () => {
    fc.assert(
      fc.property(scenarioArb(), (s) => {
        const now = at(s.nowMin);
        const eligible = s.entries.filter((e) => isEligible(e, now));
        fc.pre(eligible.length > 0 && eligible.every((e) => e.priorityClass === null));
        const oldest = minOf(eligible, oracle.oldest) as Candidate;
        const aged = now - ms(oldest.eligibleAt) >= s.policy.agingTriggerMin * MIN;
        const d = selectNext(input(s), s.policy, now);
        if (aged) {
          expect(d.reason).toBe('AGING');
          expect(d.candidateId).toBe(oldest.id);
        } else {
          expect(d.reason).not.toBe('AGING');
        }
      }),
      { numRuns: 500 },
    );
  });

  it('priority and aging overrides never change the rotation pointer', () => {
    fc.assert(
      fc.property(scenarioArb(), (s) => {
        const d = selectNext(input(s), s.policy, at(s.nowMin));
        if (d.reason === 'CLINICAL_PRIORITY' || d.reason === 'AGING') {
          expect(d.pointerAfter).toBe(d.pointerBefore);
          expect(d.rotationSlot).toBeNull();
        }
      }),
      { numRuns: 500 },
    );
  });

  it('rotation serves the first position, from the pointer, whose group has an eligible entry (no credits kept)', () => {
    fc.assert(
      fc.property(scenarioArb(validPolicyArb), (s) => {
        const now = at(s.nowMin);
        const d = selectNext(input(s), s.policy, now);
        fc.pre(d.reason === 'ROTATION');
        const n = s.policy.rotation.length;
        const eligible = s.entries.filter((e) => isEligible(e, now));
        const slot = d.rotationSlot as number;
        const start = ((s.pointer % n) + n) % n;
        expect(d.pointerBefore).toBe(start);
        const distance = (slot - start + n) % n;
        // Every position before the served one was inspected and had no eligible candidate in its group.
        for (let step = 0; step < distance; step += 1) {
          const group = s.policy.rotation[(start + step) % n] as Group;
          expect(eligible.some((e) => e.group === group)).toBe(false);
        }
        const group = s.policy.rotation[slot] as Group;
        const chosen = s.entries.find((e) => e.id === d.candidateId) as Candidate;
        expect(chosen.group).toBe(group);
        // And the pointer lands exactly one past the position served: skipped positions earn nothing.
        expect(d.pointerAfter).toBe((slot + 1) % n);
        // The pick is the head of its group's order.
        const inGroup = eligible.filter((e) => e.group === group);
        expect(d.candidateId).toBe(minOf(inGroup, group === 'A' ? oracle.appointment : oracle.walkIn)?.id);
      }),
      { numRuns: 500 },
    );
  });

  it('every decision is one of the three explainable reasons with a non-empty explanation', () => {
    fc.assert(
      fc.property(scenarioArb(), (s) => {
        const d = selectNext(input(s), s.policy, at(s.nowMin));
        expect(d.explanation.length).toBeGreaterThan(0);
        expect(d.policyVersion).toBe(s.policy.version);
        if (d.reason === 'ROTATION') expect(d.explanation).toMatch(/^Called by rotation: /);
        if (d.reason === 'AGING') expect(d.explanation).toMatch(/^Aging: waited \d+ min$/);
        if (d.reason === 'CLINICAL_PRIORITY') expect(d.explanation).toMatch(/^Clinical priority \(class [123]\)$/);
      }),
      RUNS,
    );
  });

  it('ties are broken by sequence, then id, independent of input order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ seq: fc.integer({ min: 1, max: 4 }), key: fc.integer() }), { minLength: 1, maxLength: 8 }),
        fc.constantFrom<Group>('A', 'W'),
        (rows, group) => {
          const pool: Candidate[] = rows.map((r, i) => ({
            id: `t${i}`,
            group,
            seq: r.seq,
            state: 'waiting',
            scheduledAt: group === 'A' ? at(10) : null,
            checkedInAt: at(0),
            eligibleAt: at(0),
            priorityClass: null,
          }));
          const order = rows.map((r, i) => [r.key, pool[i] as Candidate] as const).sort((a, b) => a[0] - b[0]).map(([, e]) => e);
          const expected = [...pool].sort(lastTie)[0] as Candidate;
          const d = selectNext(
            { entries: order, rotationPointer: group === 'A' ? 0 : 2, sessionCallable: true, doctorOccupied: false },
            DEFAULT_POLICY,
            at(5),
          );
          expect(d.reason).toBe('ROTATION');
          expect(d.candidateId).toBe(expected.id);
        },
      ),
      RUNS,
    );
  });

  it('with both groups always available, the realized group sequence is exactly the rotation from the pointer', () => {
    fc.assert(
      fc.property(validPolicyArb, fc.integer({ min: -3, max: 12 }), (policy, pointer) => {
        const n = policy.rotation.length;
        const pool: Candidate[] = [];
        for (let i = 0; i < 3 * n; i += 1) {
          pool.push(
            { id: `a${i}`, group: 'A', seq: i, state: 'waiting', scheduledAt: at(i), checkedInAt: at(0), eligibleAt: at(0), priorityClass: null },
            { id: `w${i}`, group: 'W', seq: 100 + i, state: 'waiting', scheduledAt: null, checkedInAt: at(0), eligibleAt: at(0), priorityClass: null },
          );
        }
        let remaining = pool;
        let p = pointer;
        const start = ((pointer % n) + n) % n;
        // Stay under the aging trigger: decisions all at the same instant.
        for (let i = 0; i < 2 * n; i += 1) {
          const d = selectNext({ entries: remaining, rotationPointer: p, sessionCallable: true, doctorOccupied: false }, policy, at(5));
          expect(d.reason).toBe('ROTATION');
          const picked = remaining.find((e) => e.id === d.candidateId) as Candidate;
          expect(picked.group).toBe(policy.rotation[(start + i) % n]);
          remaining = remaining.filter((e) => e.id !== picked.id);
          p = d.pointerAfter;
        }
      }),
      RUNS,
    );
  });

  it('empty groups do not accumulate credits: after any run of walk-in-only calls the next appointments get exactly their normal slots', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9 }), fc.integer({ min: 0, max: 2 }), (walkInOnlyCalls, startPointer) => {
        const policy = DEFAULT_POLICY;
        const walkIns = (count: number, prefix: string): Candidate[] =>
          Array.from({ length: count }, (_, i) => ({
            id: `${prefix}${i}`, group: 'W' as const, seq: i, state: 'waiting' as const,
            scheduledAt: null, checkedInAt: at(0), eligibleAt: at(0), priorityClass: null,
          }));
        let pointer = startPointer;
        let pool = walkIns(walkInOnlyCalls, 'w');
        for (let i = 0; i < walkInOnlyCalls; i += 1) {
          const d = selectNext({ entries: pool, rotationPointer: pointer, sessionCallable: true, doctorOccupied: false }, policy, at(1));
          expect(d.reason).toBe('ROTATION');
          expect(d.rotationSlot).toBe(2); // the W position, reached by skipping the empty A positions
          expect(d.pointerAfter).toBe(0); // past the W actually served; the skipped A turns earn no credit
          pool = pool.filter((e) => e.id !== d.candidateId);
          pointer = d.pointerAfter;
        }
        // Appointments and walk-ins now both wait: exactly A, A, W, A, A, W (no burst of saved A or W turns).
        let mixed: Candidate[] = [
          ...Array.from({ length: 4 }, (_, i): Candidate => ({
            id: `a${i}`, group: 'A', seq: i, state: 'waiting', scheduledAt: at(i), checkedInAt: at(0), eligibleAt: at(0), priorityClass: null,
          })),
          ...walkIns(2, 'x'),
        ];
        const groups: Group[] = [];
        for (let i = 0; i < 6; i += 1) {
          const d = selectNext({ entries: mixed, rotationPointer: pointer, sessionCallable: true, doctorOccupied: false }, policy, at(2));
          groups.push((mixed.find((e) => e.id === d.candidateId) as Candidate).group);
          mixed = mixed.filter((e) => e.id !== d.candidateId);
          pointer = d.pointerAfter;
        }
        expect(groups).toEqual(['A', 'A', 'W', 'A', 'A', 'W']);
      }),
      RUNS,
    );
  });

  it('non-preemption: an active (called or in-service) entry is never selected or replaced', () => {
    fc.assert(
      fc.property(scenarioArb(), (s) => {
        const d = selectNext(input(s), s.policy, at(s.nowMin));
        if (d.candidateId !== null) {
          const chosen = s.entries.find((e) => e.id === d.candidateId) as Candidate;
          expect(['called', 'in_service']).not.toContain(chosen.state);
        }
        // And while occupied, even a class-1 priority entry gets nothing.
        const withUrgent: Candidate[] = [
          ...s.entries,
          { id: 'urgent', group: 'W', seq: 99, state: 'waiting', scheduledAt: null, checkedInAt: at(-20), eligibleAt: at(-20), priorityClass: 1 },
        ];
        const occupied = selectNext({ ...input(s, { doctorOccupied: true }), entries: withUrgent }, s.policy, at(s.nowMin));
        expect(occupied.candidateId).toBeNull();
      }),
      RUNS,
    );
  });
});

describe('projectOrder properties', () => {
  it('is a deterministic permutation of the waiting ids', () => {
    fc.assert(
      fc.property(scenarioArb(validPolicyArb), fc.integer({ min: 1, max: 30 }), (s, service) => {
        const now = at(s.nowMin);
        const order = projectOrder({ entries: s.entries, rotationPointer: s.pointer }, s.policy, now, service);
        const waiting = s.entries.filter((e) => e.state === 'waiting').map((e) => e.id);
        expect([...order].sort()).toEqual([...waiting].sort());
        expect(projectOrder({ entries: shuffled(s), rotationPointer: s.pointer }, s.policy, now, service)).toEqual(order);
      }),
      RUNS,
    );
  });

  it('is a permutation even for a rotation with no A turn', () => {
    fc.assert(
      fc.property(scenarioArb(policyArb), (s) => {
        const order = projectOrder({ entries: s.entries, rotationPointer: s.pointer }, s.policy, at(s.nowMin), 12);
        const waiting = s.entries.filter((e) => e.state === 'waiting').map((e) => e.id);
        expect([...order].sort()).toEqual([...waiting].sort());
      }),
      RUNS,
    );
  });

  it('starts with what selectNext would call right now', () => {
    fc.assert(
      fc.property(scenarioArb(validPolicyArb), (s) => {
        const now = at(s.nowMin);
        const next = selectNext(input(s), s.policy, now);
        fc.pre(next.candidateId !== null);
        const order = projectOrder({ entries: s.entries, rotationPointer: s.pointer }, s.policy, now, 12);
        expect(order[0]).toBe(next.candidateId);
      }),
      RUNS,
    );
  });
});

describe('projectEta properties', () => {
  it('always stamps computedAt = now and gives a sane range when ok', () => {
    fc.assert(
      fc.property(
        scenarioArb(validPolicyArb),
        fc.constantFrom<'scheduled' | 'open' | 'paused' | 'unavailable' | 'closed'>('open', 'open', 'paused', 'unavailable', 'closed', 'scheduled'),
        fc.option(fc.integer({ min: -10, max: 240 }), { nil: null }),
        fc.double({ min: 1, max: 40, noNaN: true }),
        fc.integer({ min: 0, max: 12 }),
        fc.option(fc.record({ started: fc.option(fc.integer({ min: -60, max: 180 }), { nil: null }), called: fc.option(fc.integer({ min: -60, max: 180 }), { nil: null }) }), { nil: null }),
        (s, status, pauseMin, mean, samples, active) => {
          const waiting = s.entries.filter((e) => e.state === 'waiting');
          fc.pre(waiting.length > 0);
          const now = at(s.nowMin);
          const eta = projectEta({
            targetEntryId: (waiting[0] as Candidate).id,
            entries: s.entries,
            rotationPointer: s.pointer,
            active: active === null ? null : { startedAt: active.started === null ? null : at(active.started), calledAt: active.called === null ? null : at(active.called) },
            session: { status, pauseUntil: pauseMin === null ? null : at(pauseMin) },
            estimator: { meanMinutes: mean, samples },
            policy: s.policy,
            now,
          });
          expect(eta.computedAt).toBe(new Date(now).toISOString());
          expect(eta.estimatorMeanMinutes).toBe(mean);
          if (status === 'unavailable' || status === 'closed' || status === 'scheduled') expect(eta.status).toBe('withheld');
          if (status === 'paused' && pauseMin === null) expect(eta).toMatchObject({ status: 'withheld', note: 'Estimate paused' });
          if (eta.status === 'ok') {
            expect(eta.lowMinutes).toBeGreaterThanOrEqual(0);
            expect(eta.highMinutes as number).toBeGreaterThanOrEqual(eta.lowMinutes as number);
            expect(Number.isInteger(eta.lowMinutes)).toBe(true);
            expect(Number.isInteger(eta.highMinutes)).toBe(true);
          } else {
            expect(eta.lowMinutes).toBeNull();
            expect(eta.highMinutes).toBeNull();
          }
        },
      ),
      RUNS,
    );
  });
});
