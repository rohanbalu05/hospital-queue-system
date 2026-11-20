import { describe, expect, it } from 'vitest';
import {
  AffectedPatients,
  MoveAffectedRequest,
  Notification,
  SessionAvailability,
  StepAwayRequest,
  deriveAvailability,
  sessionLabelFor,
  type AvailabilitySource,
} from '../src/index.js';

const now = new Date('2026-11-20T05:00:00.000Z'); // 10:30 IST
const base: AvailabilitySource = {
  status: 'open',
  endsAt: '2026-11-20T07:30:00.000Z',
  pausedAt: null,
  pauseUntil: null,
  pauseReason: null,
};

describe('deriveAvailability (D-032)', () => {
  it('maps every session status to one availability state', () => {
    expect(deriveAvailability({ ...base, status: 'scheduled' }, now, { includeReason: true }).state).toBe('not_started');
    expect(deriveAvailability(base, now, { includeReason: true }).state).toBe('available');
    expect(deriveAvailability({ ...base, status: 'closed' }, now, { includeReason: true }).state).toBe('ended');
    expect(deriveAvailability({ ...base, endsAt: '2026-11-20T04:00:00.000Z' }, now, { includeReason: true }).state).toBe('ended');
  });

  it('away carries since, expected return and overdue; the reason is staff-only', () => {
    const away: AvailabilitySource = {
      ...base,
      status: 'paused',
      pausedAt: '2026-11-20T04:50:00.000Z',
      pauseUntil: '2026-11-20T05:05:00.000Z',
      pauseReason: 'Called to the ward',
    };
    const staff = deriveAvailability(away, now, { includeReason: true });
    expect(staff).toEqual({
      state: 'away',
      since: '2026-11-20T04:50:00.000Z',
      expectedBackAt: '2026-11-20T05:05:00.000Z',
      overdue: false,
      reason: 'Called to the ward',
    });
    expect(SessionAvailability.parse(staff)).toEqual(staff);
    expect(deriveAvailability(away, now, { includeReason: false }).reason).toBeNull();
    const late = deriveAvailability(away, new Date('2026-11-20T05:06:00.000Z'), { includeReason: false });
    expect(late.overdue).toBe(true);
  });

  it('unavailable keeps since; unknown return is never overdue', () => {
    const u = deriveAvailability(
      { ...base, status: 'unavailable', pausedAt: '2026-11-20T04:55:00.000Z', pauseReason: 'Unwell' },
      now,
      { includeReason: false },
    );
    expect(u).toMatchObject({ state: 'unavailable', since: '2026-11-20T04:55:00.000Z', reason: null, overdue: false });
    const unknown = deriveAvailability({ ...base, status: 'paused', pausedAt: now }, now, { includeReason: true });
    expect(unknown).toMatchObject({ state: 'away', expectedBackAt: null, overdue: false });
  });
});

describe('new request and response schemas', () => {
  it('step away accepts an expected return and a reason, rejects a blank reason', () => {
    expect(StepAwayRequest.parse({ until: '2026-11-20T05:15:00.000Z', reason: 'Ward round' }).reason).toBe('Ward round');
    expect(StepAwayRequest.safeParse({ reason: '  ' }).success).toBe(false);
  });

  it('bulk move needs at least one patient', () => {
    const target = '6f1c7a3e-1b2c-4d5e-8f90-1a2b3c4d5e6f';
    expect(MoveAffectedRequest.safeParse({ targetSessionId: target }).success).toBe(false);
    expect(MoveAffectedRequest.parse({ targetSessionId: target, appointmentIds: [target] }).queueEntryIds).toEqual([]);
  });

  it('older notification rows without link/severity still parse', () => {
    expect(
      Notification.parse({ id: '6f1c7a3e-1b2c-4d5e-8f90-1a2b3c4d5e6f', kind: 'SessionPaused', body: 'x', createdAt: now.toISOString(), readAt: null }),
    ).toBeTruthy();
    expect(AffectedPatients.shape.notArrived).toBeTruthy();
  });
});

describe('sessionLabelFor (D-037)', () => {
  it('labels by IST start time', () => {
    expect(sessionLabelFor('2026-11-20T04:30:00.000Z')).toBe('morning'); // 10:00 IST
    expect(sessionLabelFor('2026-11-19T23:30:00.000Z')).toBe('morning'); // 05:00 IST
    expect(sessionLabelFor('2026-11-20T06:30:00.000Z')).toBe('afternoon'); // 12:00 IST
    expect(sessionLabelFor('2026-11-20T11:29:00.000Z')).toBe('afternoon'); // 16:59 IST
    expect(sessionLabelFor('2026-11-20T11:30:00.000Z')).toBe('evening'); // 17:00 IST
    expect(sessionLabelFor('2026-11-20T15:30:00.000Z')).toBe('night'); // 21:00 IST
    expect(sessionLabelFor('2026-11-20T20:30:00.000Z')).toBe('night'); // 02:00 IST
  });
});
