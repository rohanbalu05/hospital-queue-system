import { describe, expect, it } from 'vitest';
import type { Eta, SessionAvailability } from '@hqms/contracts';
import { availabilityWords, awayWaitLine } from './availability';

const base: SessionAvailability = { state: 'available', since: null, expectedBackAt: null, overdue: false, reason: null };
const away = (over: Partial<SessionAvailability> = {}): SessionAvailability => ({ ...base, state: 'away', since: '2026-11-11T04:20:00Z', expectedBackAt: '2026-11-11T05:15:00Z', ...over });
const eta = (over: Partial<Eta> = {}): Eta => ({
  status: 'ok',
  lowMinutes: 40,
  highMinutes: 55,
  note: null,
  computedAt: '2026-11-11T04:35:00Z',
  estimatorMeanMinutes: 12,
  estimatorSamples: 4,
  uncertainty: 'warm',
  ...over,
});

describe('availabilityWords', () => {
  it('says nothing while the doctor is available, not started or the session ended', () => {
    for (const state of ['available', 'not_started', 'ended'] as const) {
      expect(availabilityWords({ ...base, state }, 'Dr. Rao', 'in_queue')).toBeNull();
    }
  });

  it('away: names the expected return in IST, keeps the place and shows the updated wait', () => {
    const w = availabilityWords(away(), 'Dr. Meenakshi Rao', 'in_queue', eta());
    expect(w?.tone).toBe('warning');
    expect(w?.title).toBe('Dr. Meenakshi Rao has stepped away and is expected back about 10:45 am');
    expect(w?.lines).toEqual(['Your place in the queue is kept.', 'Updated wait: about 40–55 min from 10:05 am.']);
  });

  it('away with the estimate withheld shows the ETA note instead of a range', () => {
    const w = availabilityWords(away(), 'Dr. Meenakshi Rao', 'in_queue', eta({ status: 'withheld', lowMinutes: null, highMinutes: null, note: 'The doctor is away longer than expected' }));
    expect(w?.lines).toContain('The doctor is away longer than expected');
    expect(w?.lines.join(' ')).not.toContain('about');
  });

  it('away and overdue says it is taking longer than expected, without a stale time', () => {
    const w = availabilityWords(away({ overdue: true }), 'Dr. Meenakshi Rao', 'in_queue');
    expect(w?.title).toBe('Dr. Meenakshi Rao has stepped away and is taking longer than expected to return');
    expect(w?.title).not.toContain('10:45');
  });

  it('away without a return time says so', () => {
    expect(availabilityWords(away({ expectedBackAt: null }), 'Dr. Meenakshi Rao', 'booked')?.title).toContain('has not given a return time');
  });

  it('a booked patient who has not arrived is told the appointment is kept, with no wait range', () => {
    const w = availabilityWords(away(), 'Dr. Meenakshi Rao', 'booked', eta());
    expect(w?.lines).toEqual(['Your appointment is kept.']);
  });

  it('unavailable is urgent; booked patients choose, checked-in patients are sent to reception', () => {
    const gone = { ...base, state: 'unavailable' as const };
    const booked = availabilityWords(gone, 'Dr. Arvind Kulkarni', 'booked');
    expect(booked?.tone).toBe('urgent');
    expect(booked?.title).toBe('Dr. Arvind Kulkarni is not available for the rest of this session');
    const queued = availabilityWords(gone, 'Dr. Arvind Kulkarni', 'in_queue');
    expect(queued?.lines).toEqual(['Please see reception: they will move you to another doctor.']);
  });
});

describe('awayWaitLine', () => {
  it('is null without an estimate', () => {
    expect(awayWaitLine(null)).toBeNull();
  });
});
