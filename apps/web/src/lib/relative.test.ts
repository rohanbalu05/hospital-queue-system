import { describe, expect, it } from 'vitest';
import { relativeTime, relativeWithClock } from './relative';

const NOW = new Date('2026-11-11T04:35:00Z'); // 10:05 am IST

describe('relativeTime', () => {
  it('says just now inside the first minute, and for an instant slightly in the future', () => {
    expect(relativeTime('2026-11-11T04:34:30Z', NOW)).toBe('just now');
    expect(relativeTime('2026-11-11T04:36:00Z', NOW)).toBe('just now');
  });
  it('counts minutes up to an hour, then hours within the same IST day', () => {
    expect(relativeTime('2026-11-11T04:30:00Z', NOW)).toBe('5 min ago');
    expect(relativeTime('2026-11-11T03:30:00Z', NOW)).toBe('1 h ago');
    expect(relativeTime('2026-11-10T19:00:00Z', NOW)).toBe('9 h ago'); // 12:30 am IST today
  });
  it('uses IST, not UTC, to decide what yesterday is', () => {
    // 10:30 pm IST on 10 Nov is 17:00Z: yesterday for a viewer at 10:05 am IST on 11 Nov.
    expect(relativeTime('2026-11-10T17:00:00Z', NOW)).toBe('Yesterday');
  });
  it('falls back to the IST date after that', () => {
    expect(relativeTime('2026-11-03T03:40:00Z', NOW)).toBe('3 Nov 2026');
  });
  it('pairs the relative text with the IST clock time', () => {
    expect(relativeWithClock('2026-11-11T04:30:00Z', NOW)).toBe('5 min ago, 10:00 am');
  });
});
