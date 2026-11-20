import { describe, expect, it } from 'vitest';
import type { Session } from '@hqms/contracts';
import { ApiRequestError } from '@/lib/api';
import { createFailureWords, istInstant, overlapWords, repeatDates, sessionActions, sessionStatusWords } from './sessions-logic';

const NOW = new Date('2026-11-20T04:35:00Z').getTime(); // 10:05 am IST
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

function session(over: Partial<Session> = {}): Session {
  return {
    id: uuid(1),
    doctorId: uuid(0xd1),
    doctorName: 'Dr. Meenakshi Rao',
    department: 'General Medicine',
    room: '12',
    sessionDate: '2026-11-20',
    label: 'morning',
    startsAt: '2026-11-20T09:00:00+05:30',
    endsAt: '2026-11-20T13:00:00+05:30',
    slotMinutes: 20,
    status: 'open',
    policyVersion: 1,
    capacity: { bookedCapacity: 10, walkinCapacity: 5, bookedReserved: 3, walkinUsed: 0, bookedAvailable: 7, walkinAvailable: 5 },
    version: 1,
    ...over,
  };
}
const avail = (state: 'not_started' | 'available' | 'away' | 'unavailable' | 'ended', over: Record<string, unknown> = {}) => ({
  state,
  since: null,
  expectedBackAt: null,
  overdue: false,
  reason: null,
  ...over,
});

describe('istInstant and repeatDates', () => {
  it('builds an instant in hospital time from a date and a clock time', () => {
    expect(istInstant('2026-11-20', '09:00')).toBe('2026-11-20T09:00:00+05:30');
  });

  it('lists the chosen date and then the next N days', () => {
    expect(repeatDates('2026-11-27', 0)).toEqual(['2026-11-27']);
    expect(repeatDates('2026-11-27', 3)).toEqual(['2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30']);
    expect(repeatDates('2026-12-30', 2)).toEqual(['2026-12-30', '2026-12-31', '2027-01-01']);
  });
});

describe('sessionStatusWords', () => {
  it('uses the availability words', () => {
    expect(sessionStatusWords(session({ status: 'scheduled', availability: avail('not_started') }), NOW)).toBe('Not started');
    expect(sessionStatusWords(session({ availability: avail('available') }), NOW)).toBe('Available');
    expect(sessionStatusWords(session({ status: 'unavailable', availability: avail('unavailable') }), NOW)).toBe('Unavailable');
    expect(sessionStatusWords(session({ status: 'closed', availability: avail('ended') }), NOW)).toBe('Ended');
  });

  it('says when an away doctor is expected back, and when no time was given', () => {
    const away = session({ status: 'paused', availability: avail('away', { expectedBackAt: '2026-11-20T10:35:00+05:30' }) });
    expect(sessionStatusWords(away, NOW)).toBe('Away until 10:35 am');
    expect(sessionStatusWords(session({ status: 'paused', availability: avail('away') }), NOW)).toBe('Away');
    expect(
      sessionStatusWords(session({ status: 'paused', availability: avail('away', { expectedBackAt: '2026-11-20T09:50:00+05:30', overdue: true }) }), NOW),
    ).toBe('Away, back time has passed');
  });

  it('falls back to the session status when the server sent no availability, and calls a finished window Ended', () => {
    expect(sessionStatusWords(session({ status: 'scheduled' }), NOW)).toBe('Not started');
    expect(sessionStatusWords(session({ status: 'open' }), NOW)).toBe('Available');
    expect(sessionStatusWords(session({ status: 'paused' }), NOW)).toBe('Away');
    expect(sessionStatusWords(session({ status: 'unavailable' }), NOW)).toBe('Unavailable');
    expect(sessionStatusWords(session({ status: 'closed' }), NOW)).toBe('Ended');
    expect(sessionStatusWords(session({ status: 'open', endsAt: '2026-11-20T09:30:00+05:30' }), NOW)).toBe('Ended');
  });
});

describe('sessionActions', () => {
  it('offers Open for a session that has not started', () => {
    expect(sessionActions(session({ status: 'scheduled' }), NOW)).toEqual({ open: true, close: false, reopen: false });
  });
  it('offers Close for open and paused sessions', () => {
    expect(sessionActions(session({ status: 'open' }), NOW)).toEqual({ open: false, close: true, reopen: false });
    expect(sessionActions(session({ status: 'paused' }), NOW)).toEqual({ open: false, close: true, reopen: false });
  });
  it('offers Reopen and Close for an unavailable session that has not ended', () => {
    expect(sessionActions(session({ status: 'unavailable' }), NOW)).toEqual({ open: false, close: true, reopen: true });
  });
  it('offers no Reopen once the session window has ended', () => {
    const ended = session({ status: 'unavailable', endsAt: '2026-11-20T09:30:00+05:30' });
    expect(sessionActions(ended, NOW)).toEqual({ open: false, close: true, reopen: false });
  });
  it('offers nothing for a closed session, or a scheduled one whose window has passed', () => {
    expect(sessionActions(session({ status: 'closed' }), NOW)).toEqual({ open: false, close: false, reopen: false });
    expect(sessionActions(session({ status: 'scheduled', endsAt: '2026-11-20T09:30:00+05:30' }), NOW)).toEqual({ open: false, close: false, reopen: false });
  });
});

describe('overlap and failure words', () => {
  const details = { reason: 'SESSION_OVERLAP', overlappingSessionId: uuid(9), startsAt: '2026-11-20T09:00:00+05:30', endsAt: '2026-11-20T13:00:00+05:30' };
  const overlap = new ApiRequestError({ status: 409, code: 'CONFLICT', message: 'overlap', details });

  it('names the overlapping session in plain words', () => {
    expect(overlapWords(details, 'Dr. Meenakshi Rao')).toBe(
      'Dr. Meenakshi Rao already has a session from 9:00 am to 1:00 pm on Fri, 20 Nov. Choose times that do not overlap it.',
    );
  });

  it('turns a 409 overlap into one short line per day, and passes other errors through in words', () => {
    expect(createFailureWords(overlap)).toBe('overlaps Morning 9:00 am to 1:00 pm');
    expect(createFailureWords(new ApiRequestError({ status: 500, code: 'INTERNAL', message: 'boom' }))).toBe(
      'not created. The server had a problem and could not finish.',
    );
    expect(createFailureWords(new ApiRequestError({ status: 0, code: 'NETWORK', message: 'Cannot reach the server. Check the connection and try again.' }))).toBe(
      'not created. Cannot reach the server. Check the connection and try again.',
    );
  });
});
