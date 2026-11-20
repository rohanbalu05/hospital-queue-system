import { z } from 'zod';
import { Id, Instant, LocalDate } from './common.js';
import { AppointmentStatus, SessionLabel, SessionStatus } from './scheduling.js';
import { SessionAvailability } from './availability.js';

// ---------------------------------------------------------------------------
// Affected patients when a doctor is away or unavailable (B3, D-033)
// ---------------------------------------------------------------------------

/** Another doctor's session in the same department that can take a patient. */
export const AlternativeSession = z.object({
  sessionId: Id,
  doctorId: Id,
  doctorName: z.string(),
  department: z.string(),
  room: z.string(),
  sessionDate: LocalDate,
  label: SessionLabel,
  startsAt: Instant,
  endsAt: Instant,
  status: SessionStatus,
  /** First slot a booking/reschedule would be given now (same rule as booking), null if none. */
  nextSlotAt: Instant.nullable(),
  bookedAvailable: z.number().int().nonnegative(),
  walkinAvailable: z.number().int().nonnegative(),
});
export type AlternativeSession = z.infer<typeof AlternativeSession>;

/**
 * GET /appointments/{id}/alternatives (the owning patient, or staff in scope). Sessions of OTHER doctors in
 * the same department that are scheduled/open, not ended, with a free booked slot: today first, then the
 * next 7 days, earliest first, at most 6. One click books via POST /appointments/{id}/reschedule.
 */
export const AppointmentAlternatives = z.object({
  appointmentId: Id,
  /** Why the patient is being offered alternatives (status of the appointment's session). */
  sourceAvailability: SessionAvailability,
  alternatives: z.array(AlternativeSession),
});
export type AppointmentAlternatives = z.infer<typeof AppointmentAlternatives>;

/** Booked patient of the affected session who has not arrived yet. */
export const AffectedAppointment = z.object({
  appointmentId: Id,
  patientId: Id,
  patientName: z.string(),
  patientMrn: z.string(),
  patientPhone: z.string().nullable(),
  scheduledAt: Instant,
  status: AppointmentStatus,
  version: z.number().int().positive(),
  /** Patient has a login and so received the in-app notice. */
  hasLogin: z.boolean(),
});
export type AffectedAppointment = z.infer<typeof AffectedAppointment>;

/** Checked-in patient of the affected session still in the building (waiting, skipped or absent; visit open). */
export const AffectedQueueEntry = z.object({
  queueEntryId: Id,
  visitId: Id,
  patientId: Id,
  patientName: z.string(),
  patientMrn: z.string(),
  token: z.string(),
  group: z.enum(['A', 'W']),
  state: z.enum(['waiting', 'skipped', 'absent']),
  checkedInAt: Instant,
  version: z.number().int().positive(),
});
export type AffectedQueueEntry = z.infer<typeof AffectedQueueEntry>;

/** GET /sessions/{id}/affected (reception in scope, admin). */
export const AffectedPatients = z.object({
  sessionId: Id,
  doctorName: z.string(),
  department: z.string(),
  availability: SessionAvailability,
  notArrived: z.array(AffectedAppointment),
  inQueue: z.array(AffectedQueueEntry),
  /** Candidate target sessions (same department, other doctors), today first. */
  alternatives: z.array(AlternativeSession),
});
export type AffectedPatients = z.infer<typeof AffectedPatients>;

/**
 * POST /sessions/{id}/affected/move (reception in scope of BOTH doctors, admin). Idempotency-Key.
 * Source session must be `unavailable` or `paused` (away). Each item is its own short transaction
 * (lock order: doctors by id, sessions by id, capacities), so capacity rules apply per item and a full
 * target skips the rest with CAPACITY_FULL instead of failing the batch.
 *  - appointmentIds (booked, not arrived): rescheduled into the target (booked place, first valid slot,
 *    follow-up link kept).
 *  - queueEntryIds (checked in): transferred. Old entry -> cancelled, old visit -> transferred; a new visit
 *    (kind `transfer`, transferred_from_visit_id) and entry in the target keep the patient's group and
 *    original check-in/eligibility times, consuming a place of the same kind (A -> booked, W -> walk-in).
 * Every moved patient is notified. Never silent (report §6.6: do not silently change the doctor).
 */
export const MoveAffectedRequest = z
  .object({
    targetSessionId: Id,
    appointmentIds: z.array(Id).max(50).default([]),
    queueEntryIds: z.array(Id).max(50).default([]),
  })
  .refine((v) => v.appointmentIds.length + v.queueEntryIds.length > 0, {
    message: 'Choose at least one patient to move',
  });
export type MoveAffectedRequest = z.infer<typeof MoveAffectedRequest>;

export const MoveOutcome = z.object({
  kind: z.enum(['appointment', 'queue_entry']),
  sourceId: Id,
  outcome: z.enum(['moved', 'skipped']),
  /** Error code when skipped (CAPACITY_FULL, CONFLICT, INVALID_TRANSITION, ...). */
  code: z.string().nullable(),
  message: z.string().nullable(),
  newAppointmentId: Id.nullable(),
  newQueueEntryId: Id.nullable(),
  token: z.string().nullable(),
  scheduledAt: Instant.nullable(),
});
export type MoveOutcome = z.infer<typeof MoveOutcome>;

export const MoveAffectedResult = z.object({
  sourceSessionId: Id,
  targetSessionId: Id,
  moved: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  results: z.array(MoveOutcome),
});
export type MoveAffectedResult = z.infer<typeof MoveAffectedResult>;
