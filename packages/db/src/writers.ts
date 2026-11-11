import type { DomainEventType, EntityType } from '@hqms/contracts';
import { NotFoundError } from './errors.js';
import type { Tx } from './tx.js';

/*
 * Audit, outbox and job writers. All take a Tx so the intent commits (or rolls back) together with
 * the domain change. They never call anything outside the database.
 */

export interface AuditInput {
  /** NULL for system/worker actions. */
  actorId: string | null;
  /** A role, or 'system'. */
  actorRole: string;
  operation: string;
  entityType: string;
  entityId: string;
  previous?: unknown;
  next?: unknown;
  reason?: string | null;
  policyVersion?: number | null;
  correlationId?: string | null;
}

/** Append an audit_events row; returns its id. */
export async function writeAudit(tx: Tx, a: AuditInput): Promise<number> {
  const res = await tx.query<{ id: number }>(
    `INSERT INTO audit_events
       (actor_id, actor_role, operation, entity_type, entity_id, previous, next, reason, policy_version, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
     RETURNING id`,
    [
      a.actorId,
      a.actorRole,
      a.operation,
      a.entityType,
      a.entityId,
      a.previous === undefined ? null : JSON.stringify(a.previous),
      a.next === undefined ? null : JSON.stringify(a.next),
      a.reason ?? null,
      a.policyVersion ?? null,
      a.correlationId ?? null,
    ],
  );
  return res.rows[0]!.id;
}

export interface OutboxInput {
  eventType: DomainEventType;
  entityType: EntityType;
  entityId: string;
  entityVersion: number;
  sessionId?: string | null;
  patientId?: string | null;
  /** Minimal routing data only (queueVersion, token...). Never clinical text. */
  payload?: Record<string, string | number | boolean | null>;
}

/** Append an outbox_events row (domain event, report §6.7); returns its id and position. */
export async function writeOutbox(tx: Tx, e: OutboxInput): Promise<{ id: string; position: number }> {
  const res = await tx.query<{ id: string; position: number }>(
    `INSERT INTO outbox_events (event_type, entity_type, entity_id, entity_version, session_id, patient_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING id, position`,
    [
      e.eventType,
      e.entityType,
      e.entityId,
      e.entityVersion,
      e.sessionId ?? null,
      e.patientId ?? null,
      JSON.stringify(e.payload ?? {}),
    ],
  );
  return res.rows[0]!;
}

/**
 * Increment sessions.queue_version and return the new value. The session lock must be held
 * (UPDATE would otherwise take that row lock implicitly and break the lock order).
 */
export async function bumpQueueVersion(tx: Tx, sessionId: string): Promise<number> {
  tx.assertHolds('session', sessionId, 'bumpQueueVersion');
  const res = await tx.query<{ queue_version: number }>(
    `UPDATE sessions SET queue_version = queue_version + 1, updated_at = now() WHERE id = $1 RETURNING queue_version`,
    [sessionId],
  );
  if (res.rowCount === 0) throw new NotFoundError('session', sessionId);
  return res.rows[0]!.queue_version;
}

export interface JobInput {
  jobType: string;
  payload?: Record<string, unknown>;
  runAt?: Date | string;
  /** Stable identity for at-least-once delivery: a second enqueue with the same key is a no-op. */
  dedupeKey?: string;
  maxAttempts?: number;
}

/** Insert a jobs row; returns its id, or null when `dedupeKey` already exists. */
export async function enqueueJob(tx: Tx, j: JobInput): Promise<string | null> {
  const res = await tx.query<{ id: string }>(
    `INSERT INTO jobs (job_type, payload, run_at, dedupe_key, max_attempts)
     VALUES ($1, $2::jsonb, COALESCE($3::timestamptz, now()), $4, COALESCE($5, 5))
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [j.jobType, JSON.stringify(j.payload ?? {}), j.runAt ?? null, j.dedupeKey ?? null, j.maxAttempts ?? null],
  );
  return res.rows[0]?.id ?? null;
}
