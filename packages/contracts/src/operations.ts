import { z } from 'zod';
import { Instant } from './common.js';

// ---------------------------------------------------------------------------
// Persona-review operations fixes (B6, D-038)
// ---------------------------------------------------------------------------

/**
 * GET /health (public): liveness for probes, always HTTP 200 while the database answers (503 otherwise).
 * `status` is `degraded` when no worker has sent a heartbeat for WORKER_STALE_SEC (default 60) — timers,
 * notifications and OCR would silently stop (PR-01/PR-02). No data beyond status words.
 */
export const HealthStatus = z.object({
  status: z.enum(['ok', 'degraded']),
  db: z.literal('up'),
  worker: z.enum(['up', 'down']),
});
export type HealthStatus = z.infer<typeof HealthStatus>;

/** GET /admin/system (admin): background-work health for the admin home panel. */
export const SystemStatus = z.object({
  checkedAt: Instant,
  worker: z.object({
    status: z.enum(['up', 'down']),
    lastSeenAt: Instant.nullable(),
    instances: z.array(
      z.object({
        workerId: z.string(),
        jobTypes: z.array(z.string()),
        dispatchOutbox: z.boolean(),
        startedAt: Instant,
        lastSeenAt: Instant,
        up: z.boolean(),
      }),
    ),
  }),
  jobs: z.object({
    /** Pending/failed jobs whose run_at is more than 60 s in the past (should already have run). */
    overdue: z.number().int().nonnegative(),
    oldestOverdueSeconds: z.number().int().nonnegative().nullable(),
    running: z.number().int().nonnegative(),
    deadLast24h: z.number().int().nonnegative(),
    byType: z.array(z.object({ jobType: z.string(), overdue: z.number().int(), dead24h: z.number().int() })),
  }),
  outbox: z.object({ undispatched: z.number().int().nonnegative(), oldestSeconds: z.number().int().nonnegative().nullable() }),
  notifications: z.object({ queued: z.number().int().nonnegative(), failedLast24h: z.number().int().nonnegative() }),
});
export type SystemStatus = z.infer<typeof SystemStatus>;

/**
 * POST /sessions/{id}/reopen (ADMIN only; Idempotency-Key): undo a mistaken "unavailable for the rest of the
 * session" (PR-30). unavailable -> open while the session has not ended. Patients already moved stay moved;
 * the rest are told the doctor is available again (SessionResumed with payload reopened=true). Audited with reason.
 */
export const ReopenSessionRequest = z.object({ reason: z.string().trim().min(3).max(300) });
export type ReopenSessionRequest = z.infer<typeof ReopenSessionRequest>;

/**
 * GET /sessions/{id}/alternatives (reception, admin) -> AlternativeSession[] (affected.ts): today's in-window
 * sessions of OTHER doctors in the same department, in the caller's scope, scheduled/open/paused, with a free
 * walk-in or booked place — shown when this session's walk-in places are full (PR-23) or it is unavailable.
 */
export const SESSION_ALTERNATIVES_LIMIT = 6;

/**
 * POST /sessions (admin) rejects a session that overlaps another session of the same doctor (PR-41):
 * 409 CONFLICT with details SessionOverlap. Checked under the doctor lock.
 */
export const SessionOverlap = z.object({
  reason: z.literal('SESSION_OVERLAP'),
  overlappingSessionId: z.string().uuid(),
  startsAt: Instant,
  endsAt: Instant,
});
export type SessionOverlap = z.infer<typeof SessionOverlap>;
