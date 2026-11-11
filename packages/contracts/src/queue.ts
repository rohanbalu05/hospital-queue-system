import { z } from 'zod';
import { ExpectedVersion, Id, Instant } from './common.js';
import { SessionStatus } from './scheduling.js';

export const QueueGroup = z.enum(['A', 'W']);
export type QueueGroup = z.infer<typeof QueueGroup>;

export const QueueEntryState = z.enum(['waiting', 'called', 'in_service', 'completed', 'skipped', 'absent', 'cancelled']);
export type QueueEntryState = z.infer<typeof QueueEntryState>;

export const VisitKind = z.enum(['appointment', 'walkin', 'late_admission']);
export type VisitKind = z.infer<typeof VisitKind>;

export const DecisionReason = z.enum(['CLINICAL_PRIORITY', 'AGING', 'ROTATION', 'NO_ALLOCATION']);
export type DecisionReason = z.infer<typeof DecisionReason>;

/** Display token: group letter + 3-digit sequence, e.g. A-014. */
export const Token = z.string().regex(/^[AW]-\d{3}$/);

// ---------------------------------------------------------------------------
// Arrival
// ---------------------------------------------------------------------------

/**
 * POST /appointments/{id}/check-in (reception; Idempotency-Key).
 * Within grace (scheduled + 15 min): group A. After grace: 409 LATE_ARRIVAL_REQUIRES_REVIEW unless
 * `admitLate: true`, which consumes walk-in capacity and uses walk-in ordering (kind late_admission).
 */
export const CheckInRequest = z.object({ admitLate: z.boolean().optional() });
export type CheckInRequest = z.infer<typeof CheckInRequest>;

/** POST /sessions/{id}/walk-ins (reception; Idempotency-Key). */
export const AdmitWalkInRequest = z.object({ patientId: Id });
export type AdmitWalkInRequest = z.infer<typeof AdmitWalkInRequest>;

export const ArrivalResult = z.object({
  visitId: Id,
  queueEntryId: Id,
  token: Token,
  group: QueueGroup,
  kind: VisitKind,
  eligibleAt: Instant,
  queueVersion: z.number().int().nonnegative(),
});
export type ArrivalResult = z.infer<typeof ArrivalResult>;

// ---------------------------------------------------------------------------
// Queue entries and decisions
// ---------------------------------------------------------------------------

/** Staff view of an entry. Patients and displays get reduced projections below. */
export const QueueEntry = z.object({
  id: Id,
  visitId: Id,
  sessionId: Id,
  doctorId: Id,
  patientId: Id,
  patientName: z.string(),
  token: Token,
  group: QueueGroup,
  seq: z.number().int().positive(),
  state: QueueEntryState,
  scheduledAt: Instant.nullable(),
  checkedInAt: Instant,
  eligibleAt: Instant,
  priorityClass: z.number().int().min(1).max(3).nullable(),
  priorityReason: z.string().nullable(),
  calledAt: Instant.nullable(),
  /** Consultation start (visits.started_at) when in service. */
  startedAt: Instant.nullable().optional(),
  callCount: z.number().int().nonnegative(),
  /** Minutes waited since eligibleAt at snapshot time (null if not waiting). */
  waitingMinutes: z.number().nullable(),
  /** 1-based position in projected policy order (waiting entries only). */
  projectedPosition: z.number().int().positive().nullable(),
  version: z.number().int().positive(),
});
export type QueueEntry = z.infer<typeof QueueEntry>;

export const QueueDecision = z.object({
  id: Id,
  sessionId: Id,
  doctorId: Id,
  queueEntryId: Id.nullable(),
  token: Token.nullable(),
  reason: DecisionReason,
  rotationSlot: z.number().int().nonnegative().nullable(),
  pointerBefore: z.number().int().nonnegative(),
  pointerAfter: z.number().int().nonnegative(),
  policyVersion: z.number().int().positive(),
  queueVersion: z.number().int().nonnegative(),
  /** Plain words for the doctor, e.g. "Called by rotation: 2nd appointment of A, A, W". */
  explanation: z.string(),
  decidedAt: Instant,
  decidedBy: Id,
});
export type QueueDecision = z.infer<typeof QueueDecision>;

/** POST /sessions/{id}/call-next (doctor assigned to the session, or reception for that doctor). Idempotency-Key. */
export const CallNextRequest = z.object({});
export const CallNextResult = z.object({
  decision: QueueDecision,
  entry: QueueEntry.nullable(), // null when NO_ALLOCATION
});
export type CallNextResult = z.infer<typeof CallNextResult>;

/** POST /visits/{id}/start, /visits/{id}/complete */
export const VisitActionRequest = ExpectedVersion;
/** Response of visit and queue-entry commands: the updated entry plus the new queue version. */
export const QueueCommandResult = z.object({
  entry: z.lazy(() => QueueEntry),
  queueVersion: z.number().int().nonnegative(),
});
/** POST /queue-entries/{id}/skip (manual, before timeout), /re-enter, /absent */
export const QueueEntryActionRequest = ExpectedVersion.extend({ reason: z.string().max(300).optional() });

/** POST /queue-entries/{id}/priority (doctor only; clinical actor). class null clears. */
export const SetPriorityRequest = ExpectedVersion.extend({
  priorityClass: z.number().int().min(1).max(3).nullable(),
  reason: z.string().min(3).max(300),
});
export type SetPriorityRequest = z.infer<typeof SetPriorityRequest>;

/** POST /sessions/{id}/pause, /resume, /unavailable */
export const PauseSessionRequest = z.object({
  /** Omit for unknown duration -> ETA withheld (FR-10). */
  until: Instant.optional(),
  reason: z.string().max(300).optional(),
});
export type PauseSessionRequest = z.infer<typeof PauseSessionRequest>;
export const MarkUnavailableRequest = z.object({ reason: z.string().min(3).max(300) });

// ---------------------------------------------------------------------------
// ETA (FR-10)
// ---------------------------------------------------------------------------

export const EtaStatus = z.enum(['ok', 'withheld', 'unsupported']);
export const Eta = z.object({
  status: EtaStatus,
  /** Present when status = ok. Range in minutes from computedAt. */
  lowMinutes: z.number().nonnegative().nullable(),
  highMinutes: z.number().nonnegative().nullable(),
  /** Why withheld/unsupported, e.g. "Doctor paused (unknown duration)". */
  note: z.string().nullable(),
  computedAt: Instant,
  estimatorMeanMinutes: z.number().positive(),
  estimatorSamples: z.number().int().nonnegative(),
  /** Machine-readable uncertainty status (FR-10): cold_start (<5 samples, ±50%), warm (±30%), widened_overrun (active consultation exceeded the mean). Null when not ok. */
  uncertainty: z.enum(['cold_start', 'warm', 'widened_overrun']).nullable(),
});
export type Eta = z.infer<typeof Eta>;

// ---------------------------------------------------------------------------
// Snapshots (FR-09): GET /sessions/{id}/queue (role-scoped)
// ---------------------------------------------------------------------------

/**
 * Workload pressure of a session (report 6.6 "demand exceeds capacity: expose workload pressure"; 6.4 records
 * priority starvation). Computed from the same projection as the ETA. `reasons` are plain-language sentences.
 */
export const QueuePressure = z.object({
  level: z.enum(['normal', 'high', 'overloaded']),
  reasons: z.array(z.string()),
});
export type QueuePressure = z.infer<typeof QueuePressure>;

export const StaffQueueSnapshot = z.object({
  view: z.literal('staff'),
  sessionId: Id,
  doctorId: Id,
  status: SessionStatus,
  pauseUntil: Instant.nullable(),
  policyVersion: z.number().int().positive(),
  rotationPointer: z.number().int().nonnegative(),
  rotation: z.array(QueueGroup),
  queueVersion: z.number().int().nonnegative(),
  capturedAt: Instant,
  /** Current called/in-service entry for this doctor (may belong to another overlapping session). */
  active: QueueEntry.nullable(),
  /** Waiting entries in projected policy order. */
  waiting: z.array(QueueEntry),
  /** Skipped/absent entries eligible for re-entry. */
  skipped: z.array(QueueEntry),
  completedCount: z.number().int().nonnegative(),
  lastDecision: QueueDecision.nullable(),
  capacity: z.object({
    bookedCapacity: z.number().int(),
    walkinCapacity: z.number().int(),
    bookedReserved: z.number().int(),
    walkinUsed: z.number().int(),
  }),
  pressure: QueuePressure,
});
export type StaffQueueSnapshot = z.infer<typeof StaffQueueSnapshot>;

/** Patient sees only their own entry plus aggregate position. */
export const PatientQueueSnapshot = z.object({
  view: z.literal('patient'),
  sessionId: Id,
  status: SessionStatus,
  queueVersion: z.number().int().nonnegative(),
  capturedAt: Instant,
  myEntry: z
    .object({
      queueEntryId: Id,
      token: Token,
      group: QueueGroup,
      state: QueueEntryState,
      position: z.number().int().positive().nullable(),
      eta: Eta,
    })
    .nullable(),
  nowCalling: Token.nullable(),
});
export type PatientQueueSnapshot = z.infer<typeof PatientQueueSnapshot>;

/** GET /display/sessions?date= : public waiting-room display. Tokens only, never names (FR-09, NFR-06). */
export const DisplayColumn = z.object({
  sessionId: Id,
  doctorLabel: z.string(), // e.g. "Dr. Rao · ENT"
  room: z.string(),
  status: SessionStatus,
  nowCalling: Token.nullable(),
  next: z.array(Token).max(3),
  queueVersion: z.number().int().nonnegative(),
});
export const DisplaySnapshot = z.object({
  view: z.literal('display'),
  capturedAt: Instant,
  columns: z.array(DisplayColumn),
});
export type DisplaySnapshot = z.infer<typeof DisplaySnapshot>;

export const QueueSnapshot = z.discriminatedUnion('view', [StaffQueueSnapshot, PatientQueueSnapshot, DisplaySnapshot]);
export type QueueSnapshot = z.infer<typeof QueueSnapshot>;

/**
 * SSE message on GET /sessions/{id}/events (and GET /display/events).
 * `event: queue` with data = QueueVersionNotice. Clients refetch the snapshot when version > held version.
 * Heartbeat every 15 s as `event: ping`.
 */
export const QueueVersionNotice = z.object({
  sessionId: Id,
  queueVersion: z.number().int().nonnegative(),
  eventType: z.string(),
  committedAt: Instant,
});
export type QueueVersionNotice = z.infer<typeof QueueVersionNotice>;
