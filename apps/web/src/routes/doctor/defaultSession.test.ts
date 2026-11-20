import { describe, expect, it } from 'vitest';
import type { Session } from '@hqms/contracts';
import { pickDefaultSession } from './defaultSession';

const at = (hhmm: string) => new Date(`2026-11-11T${hhmm}:00+05:30`);

function session(id: string, from: string, to: string, status: Session['status']): Session {
  return {
    id,
    doctorId: '00000000-0000-4000-8000-0000000000d1',
    doctorName: 'Dr. Meenakshi Rao',
    department: 'General Medicine',
    room: 'Room 12',
    sessionDate: '2026-11-11',
    label: 'morning',
    startsAt: at(from).toISOString(),
    endsAt: at(to).toISOString(),
    slotMinutes: 12,
    status,
    policyVersion: 1,
    capacity: { bookedCapacity: 10, walkinCapacity: 5, bookedReserved: 0, walkinUsed: 0, bookedAvailable: 10, walkinAvailable: 5 },
    version: 1,
  } as Session;
}

describe('pickDefaultSession', () => {
  const morning = session('morning', '09:00', '13:00', 'closed');
  const afternoon = session('afternoon', '14:00', '17:00', 'unavailable');

  it('prefers the session whose window covers now, even when it is unavailable, over an earlier closed one', () => {
    expect(pickDefaultSession([morning, afternoon], at('14:30').getTime())?.id).toBe('afternoon');
  });

  it('takes the covering session whatever its status', () => {
    for (const status of ['scheduled', 'open', 'paused', 'unavailable', 'closed'] as const) {
      expect(pickDefaultSession([morning, { ...afternoon, status }], at('15:00').getTime())?.id).toBe('afternoon');
    }
  });

  it('otherwise takes the first open or paused session', () => {
    const lunch = at('13:30').getTime();
    const open = session('open-later', '14:00', '17:00', 'open');
    expect(pickDefaultSession([morning, open], lunch)?.id).toBe('open-later');
    const paused = session('paused-later', '14:00', '17:00', 'paused');
    expect(pickDefaultSession([morning, paused], lunch)?.id).toBe('paused-later');
  });

  it('otherwise takes the next upcoming session', () => {
    const early = at('07:00').getTime();
    expect(pickDefaultSession([session('m', '09:00', '13:00', 'scheduled'), session('a', '14:00', '17:00', 'scheduled')], early)?.id).toBe('m');
    expect(pickDefaultSession([morning, session('a', '14:00', '17:00', 'scheduled')], at('13:30').getTime())?.id).toBe('a');
  });

  it('otherwise takes the latest session, and null when there are none', () => {
    const evening = at('19:00').getTime();
    expect(pickDefaultSession([morning, session('a', '14:00', '17:00', 'closed')], evening)?.id).toBe('a');
    expect(pickDefaultSession([], evening)).toBeNull();
  });

  it('does not depend on the order of the list', () => {
    expect(pickDefaultSession([afternoon, morning], at('14:30').getTime())?.id).toBe('afternoon');
  });
});
