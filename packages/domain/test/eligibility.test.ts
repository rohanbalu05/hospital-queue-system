import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  classifyArrival,
  computeEligibleAt,
  isEligible,
  normalizePointer,
  rotationLabel,
  validatePolicy,
} from '../src/index.js';
import type { Policy, QueueEntryState } from '../src/index.js';
import { MIN, at } from './helpers.js';

describe('DEFAULT_POLICY (Table 7)', () => {
  it('holds the approved initial values', () => {
    expect(DEFAULT_POLICY).toEqual({
      version: 1,
      rotation: ['A', 'A', 'W'],
      earlyEligibilityMin: 10,
      lateGraceMin: 15,
      agingTriggerMin: 45,
      calledTimeoutSec: 120,
      ewmaAlpha: 0.2,
      initialEstimateMin: 12,
      defaultBookedCapacity: 10,
      defaultWalkinCapacity: 5,
    });
    expect(rotationLabel(DEFAULT_POLICY)).toBe('A, A, W');
    expect(validatePolicy(DEFAULT_POLICY)).toEqual([]);
    expect(Object.isFrozen(DEFAULT_POLICY)).toBe(true);
  });

  it('validatePolicy reports unusable policies', () => {
    const bad: Policy = {
      ...DEFAULT_POLICY,
      rotation: [],
      ewmaAlpha: 0,
      initialEstimateMin: 0,
      agingTriggerMin: 0,
      earlyEligibilityMin: -1,
      lateGraceMin: -1,
      calledTimeoutSec: 0,
    };
    expect(validatePolicy(bad).length).toBeGreaterThanOrEqual(8);
    expect(validatePolicy({ ...DEFAULT_POLICY, rotation: ['A', 'A'] })).toEqual(['rotation must contain W']);
  });

  it('normalizePointer wraps and survives bad input', () => {
    expect(normalizePointer(0, 3)).toBe(0);
    expect(normalizePointer(4, 3)).toBe(1);
    expect(normalizePointer(-1, 3)).toBe(2);
    expect(normalizePointer(1.9, 3)).toBe(1);
    expect(normalizePointer(5, 0)).toBe(0);
  });
});

describe('classifyArrival', () => {
  const scheduledAt = at(60);
  const p = DEFAULT_POLICY;

  it('treats arrival exactly at scheduled + 15 min as on time', () => {
    expect(classifyArrival({ scheduledAt, arrivedAt: scheduledAt + 15 * MIN }, p)).toBe('on_time');
  });

  it('requires review one millisecond after the grace', () => {
    expect(classifyArrival({ scheduledAt, arrivedAt: scheduledAt + 15 * MIN + 1 }, p)).toBe('late_requires_review');
    expect(classifyArrival({ scheduledAt, arrivedAt: scheduledAt + 16 * MIN }, p)).toBe('late_requires_review');
  });

  it('keeps early arrivals, however early, on time', () => {
    expect(classifyArrival({ scheduledAt, arrivedAt: scheduledAt - 90 * MIN }, p)).toBe('on_time');
    expect(classifyArrival({ scheduledAt, arrivedAt: scheduledAt }, p)).toBe('on_time');
  });

  it('accepts Date objects', () => {
    expect(classifyArrival({ scheduledAt: new Date(scheduledAt), arrivedAt: new Date(scheduledAt + 20 * MIN) }, p)).toBe(
      'late_requires_review',
    );
  });
});

describe('computeEligibleAt', () => {
  const p = DEFAULT_POLICY;
  const scheduledAt = at(60);

  it('appointment checking in before the early window waits for scheduled - 10 min', () => {
    expect(computeEligibleAt({ kind: 'appointment', scheduledAt, checkedInAt: at(20) }, p)).toBe(at(50));
  });

  it('appointment checking in exactly at scheduled - 10 min is eligible then', () => {
    expect(computeEligibleAt({ kind: 'appointment', scheduledAt, checkedInAt: at(50) }, p)).toBe(at(50));
  });

  it('appointment checking in inside the window is eligible at check-in', () => {
    expect(computeEligibleAt({ kind: 'appointment', scheduledAt, checkedInAt: at(55) }, p)).toBe(at(55));
    expect(computeEligibleAt({ kind: 'appointment', scheduledAt, checkedInAt: at(70) }, p)).toBe(at(70));
  });

  it('walk-in and late admission use the accepted check-in time', () => {
    expect(computeEligibleAt({ kind: 'walkin', acceptedAt: at(33) }, p)).toBe(at(33));
    expect(computeEligibleAt({ kind: 'late_admission', acceptedAt: new Date(at(80)) }, p)).toBe(at(80));
  });

  it('re-entry gets fresh eligibility at the re-entry time', () => {
    expect(computeEligibleAt({ kind: 're_entry', reEnteredAt: at(90) }, p)).toBe(at(90));
  });

  it('respects a different early window from the policy', () => {
    expect(computeEligibleAt({ kind: 'appointment', scheduledAt, checkedInAt: at(0) }, { ...p, earlyEligibilityMin: 20 })).toBe(
      at(40),
    );
  });
});

describe('isEligible', () => {
  const states: QueueEntryState[] = ['waiting', 'called', 'in_service', 'completed', 'skipped', 'absent', 'cancelled'];

  it('only waiting entries are eligible', () => {
    for (const state of states) {
      expect(isEligible({ state, eligibleAt: at(0) }, at(5))).toBe(state === 'waiting');
    }
  });

  it('is inclusive at the eligible time and false one millisecond before', () => {
    expect(isEligible({ state: 'waiting', eligibleAt: at(5) }, at(5))).toBe(true);
    expect(isEligible({ state: 'waiting', eligibleAt: at(5) + 1 }, at(5))).toBe(false);
  });

  it('accepts Date and number mixes', () => {
    expect(isEligible({ state: 'waiting', eligibleAt: new Date(at(5)) }, at(6))).toBe(true);
    expect(isEligible({ state: 'waiting', eligibleAt: at(5) }, new Date(at(4)))).toBe(false);
  });
});
