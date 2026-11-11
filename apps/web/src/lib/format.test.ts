import { describe, expect, it } from 'vitest';
import { formatIST, formatMinuteRange } from './format';

describe('formatIST', () => {
  it('renders an instant in Asia/Kolkata regardless of the offset it carries', () => {
    expect(formatIST('2026-11-11T05:00:00Z')).toBe('10:30 am');
    expect(formatIST('2026-11-11T10:30:00+05:30')).toBe('10:30 am');
  });

  it('crosses the date line correctly (UTC evening is IST next morning)', () => {
    expect(formatIST('2026-11-11T20:00:00Z', 'date-time')).toBe('12 Nov, 1:30 am');
  });

  it('includes seconds for the stale banner', () => {
    expect(formatIST('2026-11-11T05:12:08Z', 'time-seconds')).toBe('10:42:08 am');
  });

  it('formats dates', () => {
    expect(formatIST('2026-11-11T05:00:00Z', 'date')).toBe('11 Nov 2026');
  });

  it('returns a dash for null, undefined and invalid input', () => {
    expect(formatIST(null)).toBe('-');
    expect(formatIST(undefined)).toBe('-');
    expect(formatIST('not a date')).toBe('-');
  });
});

describe('formatMinuteRange', () => {
  it('formats a range and collapses equal ends', () => {
    expect(formatMinuteRange(25, 40)).toBe('about 25–40 min');
    expect(formatMinuteRange(12, 12)).toBe('about 12 min');
  });
});
