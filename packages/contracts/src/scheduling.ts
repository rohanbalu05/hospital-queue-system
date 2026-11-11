import { z } from 'zod';
import { ExpectedVersion, Id, Instant, LocalDate } from './common.js';

/** Table 7, versioned. A session keeps its policy version for its whole life. */
export const QueuePolicy = z.object({
  id: Id,
  version: z.number().int().positive(),
  rotation: z.array(z.enum(['A', 'W'])).min(1), // default ['A','A','W']
  earlyEligibilityMin: z.number().int().nonnegative(), // 10
  lateGraceMin: z.number().int().nonnegative(), // 15
  agingTriggerMin: z.number().int().positive(), // 45
  calledTimeoutSec: z.number().int().positive(), // 120
  ewmaAlpha: z.number().gt(0).lte(1), // 0.2
  initialEstimateMin: z.number().positive(), // 12
  defaultBookedCapacity: z.number().int().nonnegative(), // 10
  defaultWalkinCapacity: z.number().int().nonnegative(), // 5
  createdAt: Instant,
});
export type QueuePolicy = z.infer<typeof QueuePolicy>;

export const SessionStatus = z.enum(['scheduled', 'open', 'paused', 'unavailable', 'closed']);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const SessionLabel = z.enum(['morning', 'afternoon', 'evening']);

export const Capacity = z.object({
  bookedCapacity: z.number().int().nonnegative(),
  walkinCapacity: z.number().int().nonnegative(),
  bookedReserved: z.number().int().nonnegative(),
  walkinUsed: z.number().int().nonnegative(),
  bookedAvailable: z.number().int().nonnegative(),
  walkinAvailable: z.number().int().nonnegative(),
});
export type Capacity = z.infer<typeof Capacity>;

export const Session = z.object({
  id: Id,
  doctorId: Id,
  doctorName: z.string(),
  department: z.string(),
  room: z.string(),
  sessionDate: LocalDate,
  label: SessionLabel,
  startsAt: Instant,
  endsAt: Instant,
  slotMinutes: z.number().int().positive(),
  status: SessionStatus,
  policyVersion: z.number().int().positive(),
  capacity: Capacity,
  version: z.number().int().positive(),
});
export type Session = z.infer<typeof Session>;

/** GET /sessions?date=&doctorId=&department= */
export const SessionListQuery = z.object({
  date: LocalDate.optional(),
  from: LocalDate.optional(),
  to: LocalDate.optional(),
  doctorId: Id.optional(),
  department: z.string().optional(),
});

/** PATCH /sessions/{id}/capacity (admin). Reductions below current usage -> 409 INVALID_CAPACITY_REDUCTION. */
export const UpdateCapacityRequest = ExpectedVersion.extend({
  bookedCapacity: z.number().int().min(0).max(100),
  walkinCapacity: z.number().int().min(0).max(100),
});
export type UpdateCapacityRequest = z.infer<typeof UpdateCapacityRequest>;

/** POST /sessions (admin). */
export const CreateSessionRequest = z.object({
  doctorId: Id,
  sessionDate: LocalDate,
  label: SessionLabel,
  startsAt: Instant,
  endsAt: Instant,
  bookedCapacity: z.number().int().min(0).max(100).optional(),
  walkinCapacity: z.number().int().min(0).max(100).optional(),
});

export const AppointmentStatus = z.enum(['booked', 'checked_in', 'completed', 'cancelled', 'missed', 'rescheduled']);
export type AppointmentStatus = z.infer<typeof AppointmentStatus>;

export const Appointment = z.object({
  id: Id,
  patientId: Id,
  sessionId: Id,
  doctorId: Id,
  doctorName: z.string(),
  department: z.string(),
  scheduledAt: Instant,
  status: AppointmentStatus,
  rescheduledFromId: Id.nullable(),
  followUpTaskId: Id.nullable(),
  version: z.number().int().positive(),
  createdAt: Instant,
});
export type Appointment = z.infer<typeof Appointment>;

/**
 * POST /appointments (header Idempotency-Key required).
 * Patients book for themselves (patientId must be their own or omitted); reception books for any patient.
 * scheduledAt is assigned by the server (next free slot) unless given and free.
 */
export const BookAppointmentRequest = z.object({
  sessionId: Id,
  patientId: Id.optional(),
  /** Set only by follow-up staff for a return visit (FR-14). */
  followUpTaskId: Id.optional(),
});
export type BookAppointmentRequest = z.infer<typeof BookAppointmentRequest>;

/** POST /appointments/{id}/cancel */
export const CancelAppointmentRequest = ExpectedVersion.extend({ reason: z.string().max(300).optional() });

/** POST /appointments/{id}/reschedule: reserve target and release original in one transaction. */
export const RescheduleAppointmentRequest = ExpectedVersion.extend({ targetSessionId: Id });
export type RescheduleAppointmentRequest = z.infer<typeof RescheduleAppointmentRequest>;

/** GET /appointments?patientId= (patients: own only) */
export const AppointmentListQuery = z.object({ patientId: Id.optional(), sessionId: Id.optional() });

/** GET /sessions/{id}/slots -> available slot times for booking UI. */
export const SlotAvailability = z.object({
  sessionId: Id,
  slots: z.array(z.object({ scheduledAt: Instant, available: z.boolean() })),
  capacity: Capacity,
});
export type SlotAvailability = z.infer<typeof SlotAvailability>;

export type SessionListQuery = z.infer<typeof SessionListQuery>;
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;
export type CancelAppointmentRequest = z.infer<typeof CancelAppointmentRequest>;
export type AppointmentListQuery = z.infer<typeof AppointmentListQuery>;
