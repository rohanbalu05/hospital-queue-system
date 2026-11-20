import { z } from 'zod';
import { Id, Instant } from './common.js';

// ---------------------------------------------------------------------------
// Notifications (B2, D-034)
// ---------------------------------------------------------------------------

export const NotificationSeverity = z.enum(['info', 'warning', 'urgent']);
export type NotificationSeverity = z.infer<typeof NotificationSeverity>;

/**
 * In-app notice for the signed-in user (any role). Rows are written by the worker's outbox dispatcher from
 * committed domain events; text is built from routing data only (names, times, tokens, rooms), never clinical.
 * GET /notifications -> Notification[] (own, newest first, max 100).
 */
export const Notification = z.object({
  id: Id,
  kind: z.string(),
  body: z.string(),
  createdAt: Instant,
  readAt: Instant.nullable(),
  /** In-app path to open (see NOTIFICATION_LINKS), null when there is nothing to open. */
  link: z.string().nullable().optional(),
  severity: NotificationSeverity.optional(),
});
export type Notification = z.infer<typeof Notification>;

/** GET /notifications/unread-count (own). Cheap; the bell polls it and refetches on live notices. */
export const UnreadCount = z.object({ unreadCount: z.number().int().nonnegative() });
export type UnreadCount = z.infer<typeof UnreadCount>;

/** POST /notifications/read-all (own) -> number of rows marked read. POST /notifications/{id}/read already exists. */
export const ReadAllResult = z.object({ updated: z.number().int().nonnegative() });
export type ReadAllResult = z.infer<typeof ReadAllResult>;

/** In-app paths the worker writes into `notifications.link`. The web app must route every one of them. */
export const NOTIFICATION_LINKS = {
  patientToday: () => '/patient',
  patientVisit: (sessionId: string) => `/patient/visit/${sessionId}`,
  /** Visits page with the rebook panel open for one appointment (doctor unavailable). */
  patientRebook: (appointmentId: string) => `/patient/visits?rebook=${appointmentId}`,
  /** Follow-ups page: the care team's reply is waiting (PR-14). */
  patientFollowUps: () => '/patient/follow-ups',
  /** Admin sessions page (e.g. a session reopened). */
  adminSessions: () => '/admin',
  receptionSession: (sessionId: string) => `/reception?session=${sessionId}`,
  doctorSession: (sessionId: string) => `/doctor?session=${sessionId}`,
} as const;

// ---------------------------------------------------------------------------
// Outbound delivery log (SMS / email through the NotificationProvider adapter; fake by default)
// ---------------------------------------------------------------------------

export const DeliveryChannel = z.enum(['in_app', 'sms', 'email']);
export type DeliveryChannel = z.infer<typeof DeliveryChannel>;

export const DeliveryStatus = z.enum(['queued', 'sent', 'failed']);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

/**
 * GET /admin/notifications?limit=&channel=&status=&sessionId= (admin): the "Notifications sent" log.
 * One row per recipient per channel per event. Addresses are masked (phone: last 4 digits; email: first
 * letter + domain).
 */
export const NotificationDelivery = z.object({
  id: Id,
  channel: DeliveryChannel,
  status: DeliveryStatus,
  /** Patient name or staff display name. */
  recipientName: z.string(),
  recipientRole: z.string(),
  /** Masked phone/email; "in-app" for in-app rows. */
  address: z.string(),
  body: z.string(),
  eventType: z.string().nullable(),
  sessionId: Id.nullable(),
  provider: z.string().nullable(),
  providerMessageId: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  createdAt: Instant,
  sentAt: Instant.nullable(),
});
export type NotificationDelivery = z.infer<typeof NotificationDelivery>;

export const NotificationDeliveryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  channel: DeliveryChannel.optional(),
  status: DeliveryStatus.optional(),
  sessionId: Id.optional(),
});
export type NotificationDeliveryQuery = z.infer<typeof NotificationDeliveryQuery>;
