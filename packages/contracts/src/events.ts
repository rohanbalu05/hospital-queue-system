import { z } from 'zod';
import { Id, Instant } from './common.js';

/**
 * Domain events (report §6.7), written to outbox_events in the same transaction as the state change.
 * Envelope carries event id, entity id/version, timestamp and minimal routing data. Never clinical text.
 */
export const DomainEventType = z.enum([
  'AppointmentBooked',
  'AppointmentRescheduled',
  'AppointmentCancelled',
  'ReservationReleased',
  'VisitCheckedIn',
  'QueuePatientCalled',
  'QueuePatientSkipped',
  'QueueEntryReentered',
  'QueuePriorityChanged',
  'SessionPaused',
  'SessionResumed',
  'SessionUnavailable',
  'ConsultationStarted',
  'ConsultationCompleted',
  'DocumentUploaded',
  'DocumentOCRCompleted',
  'DocumentOCRFailed',
  'InstructionVerified',
  'FollowUpOpened',
  'FollowUpAcknowledged',
  'FollowUpResolved',
  'ReturnAppointmentBooked',
]);
export type DomainEventType = z.infer<typeof DomainEventType>;

export const EntityType = z.enum([
  'appointment',
  'visit',
  'queue_entry',
  'session',
  'document',
  'instruction_version',
  'follow_up_task',
  'message',
]);
export type EntityType = z.infer<typeof EntityType>;

export const DomainEventEnvelope = z.object({
  id: Id,
  type: DomainEventType,
  entityType: EntityType,
  entityId: Id,
  entityVersion: z.number().int().nonnegative(),
  occurredAt: Instant,
  /** Routing only. */
  sessionId: Id.nullable(),
  patientId: Id.nullable(),
  /** Minimal routing data (e.g. queueVersion, token). No names, no clinical text. */
  payload: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type DomainEventEnvelope = z.infer<typeof DomainEventEnvelope>;

/** Job types handled by apps/worker. */
export const JobType = z.enum([
  'call_timeout', // payload { queueEntryId, calledAt } -> SKIPPED after 2 min if still called
  'reservation_release', // payload { appointmentId } -> missed + release after grace if not checked in
  'ocr_document', // payload { documentId }
  'dispatch_outbox', // fan-out outbox -> notifications
  'reconcile_uploads', // periodic: orphaned objects / missing OCR jobs
]);
export type JobType = z.infer<typeof JobType>;
