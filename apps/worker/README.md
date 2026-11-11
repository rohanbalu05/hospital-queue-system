# @hqms/worker

Postgres-backed job runner and outbox dispatcher (no Redis, no Nest). Run: `pnpm --filter @hqms/worker dev` (tsx) or `build` then `start`.

Env: `DATABASE_URL` (required), `WORKER_ID`, `WORKER_POLL_MS=500`, `WORKER_CONCURRENCY=4`, `WORKER_LEASE_SEC=30`,
`WORKER_JOB_TYPES` (comma list; lets a second process serve only document jobs), `WORKER_DISPATCH_OUTBOX=true`.

## Enqueueing (API side, inside the same transaction as the state change)

Use `enqueueJob(tx, { jobType, payload, runAt, dedupeKey })` from `@hqms/db`. A repeated `dedupeKey` is a no-op.

| jobType               | payload                                                             | runAt                                | dedupeKey                                                                                    |
| --------------------- | ------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `call_timeout`        | `{ queueEntryId, calledAt }` (ISO instant, the entry's `called_at`) | `calledAt + policy.calledTimeoutSec` | `call_timeout:{queueEntryId}:{callCount}`                                                    |
| `reservation_release` | `{ appointmentId }`                                                 | `scheduledAt + policy.lateGraceMin`  | `reservation_release:{appointmentId}` (a reschedule creates a new appointment, so a new job) |
| `ocr_document`        | `{ documentId }`                                                    | now                                  | `ocr_document:{documentId}` (stub until W3)                                                  |
| `reconcile_uploads`   | `{}`                                                                | periodic                             | `reconcile_uploads:{yyyy-mm-dd-hh}` (stub until W3)                                          |

Handlers re-check state under the doctor -> session (-> capacity) locks, so an early or duplicate job is harmless:
too early returns `{ retryAt }` (no attempt used), wrong state is a no-op.

## Outcomes

`succeeded`, `cancelled` (entity gone), `failed` (retry at `now + min(300, 2^attempts)` s, `last_error` kept),
`dead` (attempts >= max_attempts or a permanent error; stays visible). A crashed worker's job (lease expired while
`running`) is re-claimed; if its last attempt crashed it is buried as `dead`.

## Outbox

Every undispatched `outbox_events` row becomes at most one in-app `notifications` row per patient login (unique on
`recipient_user_id, event_id`), then `dispatched_at` is set. The SSE stream must read `outbox_events` by `position`
and must not depend on `dispatched_at`.
