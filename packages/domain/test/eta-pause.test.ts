import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, projectEta } from '../src/index.js';
import type { Candidate, EtaInput } from '../src/index.js';
import { MIN, at, cand } from './helpers.js';

const w = (id: string, seq: number): Candidate =>
  cand({ id, group: 'W', seq, checkedInAt: at(-30), eligibleAt: at(-30) });

const away = (over: Partial<EtaInput> & { pauseUntil: number; now: number; entries: Candidate[] }): EtaInput => ({
  targetEntryId: 'W1',
  rotationPointer: 0,
  active: null,
  session: { status: 'paused', pauseUntil: over.pauseUntil },
  estimator: { meanMinutes: 12, samples: 10 },
  policy: DEFAULT_POLICY,
  ...over,
});

describe('PR-10: the wait range never starts before the doctor is back', () => {
  it('review case: next in line, doctor back in 15 min -> low is at least 15 (was 7)', () => {
    const eta = projectEta(away({ entries: [w('W1', 1)], now: at(0), pauseUntil: at(15) }));
    expect(eta.status).toBe('ok');
    expect(eta.lowMinutes).toBe(15);
    expect(eta.highMinutes).toBeGreaterThanOrEqual(15);
    expect(eta.highMinutes).toBeGreaterThanOrEqual(eta.lowMinutes ?? 0);
  });

  it('a fractional return offset rounds the low bound up (never earlier than the return)', () => {
    const eta = projectEta(away({ entries: [w('W1', 1)], now: at(0), pauseUntil: at(0) + 8 * MIN + 12_000 }));
    expect(eta.lowMinutes).toBe(9);
  });

  it('a long wait behind others is not changed by the clamp', () => {
    const entries = [w('W1', 1), w('W2', 2), w('W3', 3), w('W4', 4)];
    const target = { ...away({ entries, now: at(0), pauseUntil: at(5) }), targetEntryId: 'W4' };
    const clamped = projectEta(target);
    // three consultations of 12 min before W4 after the doctor is back at +5: offset 41 -> low floor(41*0.7) = 28 > 5
    expect(clamped.lowMinutes).toBeGreaterThan(5);
    const unpaused = projectEta({ ...target, session: { status: 'open', pauseUntil: null } });
    expect(clamped.lowMinutes).toBeGreaterThanOrEqual(unpaused.lowMinutes ?? 0);
  });

  it('an open session is untouched (no pause, no clamp)', () => {
    const eta = projectEta({ ...away({ entries: [w('W1', 1)], now: at(0), pauseUntil: at(15) }), session: { status: 'open', pauseUntil: null } });
    expect(eta.lowMinutes).toBe(0);
  });

  it('property: for any known return, low >= minutes to return and high >= low', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 600 }), // seconds to return
        fc.integer({ min: 1, max: 5 }), // queue position
        fc.integer({ min: 0, max: 12 }), // samples
        (secs, pos, samples) => {
          const entries = Array.from({ length: pos }, (_, i) => w(`W${i + 1}`, i + 1));
          const eta = projectEta({
            ...away({ entries, now: at(0), pauseUntil: at(0) + secs * 1000 }),
            targetEntryId: `W${pos}`,
            estimator: { meanMinutes: 12, samples },
          });
          expect(eta.status).toBe('ok');
          expect(eta.lowMinutes ?? -1).toBeGreaterThanOrEqual(secs / 60 - 1e-9);
          expect(eta.highMinutes ?? -1).toBeGreaterThanOrEqual(eta.lowMinutes ?? 0);
        },
      ),
      { numRuns: 300 },
    );
  });
});
