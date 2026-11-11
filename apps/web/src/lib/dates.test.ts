import { describe, expect, it } from 'vitest';
import { addDays, formatLocalDate, istDate, nextDays } from './dates';

describe('dates (Asia/Kolkata)', () => {
  it('uses the hospital date, not the UTC date', () => {
    // 20:00 UTC on 11 Nov is 01:30 IST on 12 Nov.
    expect(istDate(new Date('2026-11-11T20:00:00Z'))).toBe('2026-11-12');
    expect(istDate(new Date('2026-11-11T04:00:00Z'))).toBe('2026-11-11');
  });
  it('adds days across month ends', () => {
    expect(addDays('2026-11-29', 3)).toBe('2026-12-02');
  });
  it('lists the next 7 days starting today', () => {
    const days = nextDays(7, new Date('2026-11-11T04:00:00Z'));
    expect(days).toHaveLength(7);
    expect(days[0]).toBe('2026-11-11');
    expect(days[6]).toBe('2026-11-17');
  });
  it('formats a local date', () => {
    expect(formatLocalDate('2026-11-12')).toBe('Thu, 12 Nov');
  });
});
