import { z } from 'zod';
import { Id, Instant, LocalDate } from './common.js';

/** GET /audit?entityType=&entityId=&from=&to= (admin). */
export const AuditEvent = z.object({
  id: z.number().int(),
  occurredAt: Instant,
  actorId: Id.nullable(),
  actorRole: z.string(),
  operation: z.string(),
  entityType: z.string(),
  entityId: Id,
  previous: z.unknown().nullable(),
  next: z.unknown().nullable(),
  reason: z.string().nullable(),
  policyVersion: z.number().int().nullable(),
  correlationId: z.string().nullable(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

export const AuditQuery = z.object({
  entityType: z.string().optional(),
  entityId: Id.optional(),
  from: Instant.optional(),
  to: Instant.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** A metric always says whether it is a target (from the report) or measured (from data). FR-15. */
export const Metric = z.object({
  name: z.string(),
  unit: z.string(),
  kind: z.enum(['target', 'measured']),
  value: z.number().nullable(),
  sampleSize: z.number().int().nonnegative().nullable(),
  note: z.string().nullable(),
});
export type Metric = z.infer<typeof Metric>;

/** GET /reports/operations?from=&to=&doctorId= (admin). */
export const OperationsReport = z.object({
  from: LocalDate,
  to: LocalDate,
  generatedAt: Instant,
  throughput: z.object({ completedVisits: z.number().int(), sessions: z.number().int() }),
  waitsByGroup: z.array(
    z.object({ group: z.enum(['A', 'W', 'P', 'all']), medianMinutes: z.number().nullable(), p95Minutes: z.number().nullable(), n: z.number().int() }),
  ),
  decisionsByReason: z.array(z.object({ reason: z.string(), count: z.number().int() })),
  metrics: z.array(Metric),
});
export type OperationsReport = z.infer<typeof OperationsReport>;

/** GET /notifications (own). */
export const Notification = z.object({
  id: Id,
  kind: z.string(),
  body: z.string(),
  createdAt: Instant,
  readAt: Instant.nullable(),
});
export type Notification = z.infer<typeof Notification>;
