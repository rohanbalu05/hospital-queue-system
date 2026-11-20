import type { QueueDecision, QueueEntry, SessionAvailability, StaffQueueSnapshot } from '@hqms/contracts';

/** Test and dev-board fixtures. Valid UUIDs, because the app parses every response with the contracts schemas. */
export const uid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export const SESSION_ID = uid(0x5e51);
export const DOCTOR_ID = uid(0xd1);

export function entry(n: number, overrides: Partial<QueueEntry> = {}): QueueEntry {
  const group = overrides.group ?? 'A';
  return {
    id: uid(0xe000 + n),
    visitId: uid(0xf000 + n),
    sessionId: SESSION_ID,
    doctorId: DOCTOR_ID,
    patientId: uid(0xa000 + n),
    patientName: 'Ananya Iyer',
    token: `${group}-${String(n).padStart(3, '0')}`,
    group,
    seq: n,
    state: 'waiting',
    scheduledAt: '2026-11-11T04:30:00.000Z',
    checkedInAt: '2026-11-11T04:20:00.000Z',
    eligibleAt: '2026-11-11T04:20:00.000Z',
    priorityClass: null,
    priorityReason: null,
    calledAt: null,
    callCount: 0,
    waitingMinutes: 12,
    projectedPosition: 1,
    version: 1,
    ...overrides,
  };
}

export function decision(overrides: Partial<QueueDecision> = {}): QueueDecision {
  return {
    id: uid(0xdec1),
    sessionId: SESSION_ID,
    doctorId: DOCTOR_ID,
    queueEntryId: uid(0xe000 + 14),
    token: 'A-014',
    reason: 'ROTATION',
    rotationSlot: 1,
    pointerBefore: 1,
    pointerAfter: 2,
    policyVersion: 1,
    queueVersion: 7,
    explanation: 'Called by rotation: 2nd appointment of A, A, W',
    decidedAt: '2026-11-11T04:42:00.000Z',
    decidedBy: uid(0x03),
    ...overrides,
  };
}

export const AVAILABLE: SessionAvailability = { state: 'available', since: null, expectedBackAt: null, overdue: false, reason: null };

/** Doctor stepped away at 10:30 am IST, expecting to be back about 10:45 am. */
export function awayAvailability(overrides: Partial<SessionAvailability> = {}): SessionAvailability {
  return {
    state: 'away',
    since: '2026-11-11T05:00:00.000Z',
    expectedBackAt: '2026-11-11T05:15:00.000Z',
    overdue: false,
    reason: 'Ward round',
    ...overrides,
  };
}

export function staffSnapshot(overrides: Partial<StaffQueueSnapshot> = {}): StaffQueueSnapshot {
  return {
    view: 'staff',
    pressure: { level: 'normal', reasons: [] },
    sessionId: SESSION_ID,
    doctorId: DOCTOR_ID,
    status: 'open',
    pauseUntil: null,
    availability: AVAILABLE,
    policyVersion: 1,
    rotationPointer: 2,
    rotation: ['A', 'A', 'W'],
    queueVersion: 7,
    capturedAt: '2026-11-11T04:42:30.000Z',
    active: null,
    waiting: [],
    skipped: [],
    completedCount: 0,
    lastDecision: null,
    capacity: { bookedCapacity: 10, walkinCapacity: 5, bookedReserved: 8, walkinUsed: 2 },
    ...overrides,
  };
}
