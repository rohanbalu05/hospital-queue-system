# @hqms/worker

Postgres-backed job runner and outbox dispatcher (no Redis, no Nest). Run: `pnpm --filter @hqms/worker dev` (tsx) or `build` then `start`.

Env: `DATABASE_URL` (required), `WORKER_ID`, `WORKER_POLL_MS=500`, `WORKER_CONCURRENCY=4`, `WORKER_LEASE_SEC=30`,
`WORKER_JOB_TYPES` (comma list; lets a second process serve only document jobs), `WORKER_DISPATCH_OUTBOX=true`.
Documents: `OBJECT_STORAGE=local-disk|gcs`, `STORAGE_DIR=./var/storage`, `OCR_PROVIDER=fake|google-vision`, `OCR_TIMEOUT_SEC=90`,
`WORKER_RECONCILE_SEED_SEC=600`. The fake adapters are the default; no keys are needed.

Separate document worker (report 6.2, bounded concurrency, no outbox loop): `pnpm --filter @hqms/worker start:documents`
(`dev:documents` under tsx) = `WORKER_JOB_TYPES=ocr_document,reconcile_uploads WORKER_DISPATCH_OUTBOX=false`. Run it next to the
main worker, which then should set `WORKER_JOB_TYPES=call_timeout,reservation_release,dispatch_outbox` so OCR never competes
with queue timers.

## Enqueueing (API side, inside the same transaction as the state change)

Use `enqueueJob(tx, { jobType, payload, runAt, dedupeKey })` from `@hqms/db`. A repeated `dedupeKey` is a no-op.

| jobType               | payload                                                             | runAt                                | dedupeKey                                                                                    |
| --------------------- | ------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `call_timeout`        | `{ queueEntryId, calledAt }` (ISO instant, the entry's `called_at`) | `calledAt + policy.calledTimeoutSec` | `call_timeout:{queueEntryId}:{callCount}`                                                    |
| `reservation_release` | `{ appointmentId }`                                                 | `scheduledAt + policy.lateGraceMin`  | `reservation_release:{appointmentId}` (a reschedule creates a new appointment, so a new job) |
| `ocr_document`        | `{ documentId }`                                                    | now                                  | `ocr_document:{documentId}`; a controlled retry after `ocr_failed` uses `ocr_document:{documentId}:retry:{documentVersion}` |
| `reconcile_uploads`   | `{}`                                                                | hourly                               | `reconcile_uploads:{yyyy-mm-dd-hh}` (UTC)                                                    |

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

## Document jobs (FR-12, FR-13, NFR-07)

`ocr_document`: tx1 locks the document row and moves `accepted|ocr_failed -> processing` (`ocr_attempts + 1`), commits; then,
with no transaction and no lock, reads the object and calls `OcrProvider` (abandoned after `OCR_TIMEOUT_SEC`); tx2 locks the
row again and, only if still `processing`, inserts ONE `ocr_drafts` row, sets `ocr_ready`, writes audit + `DocumentOCRCompleted`
(no text in the event). A provider failure sets `ocr_failed` with a text-free `last_error` + `DocumentOCRFailed` (payload
`attempt`, `final`) and rethrows: transient errors back off and go `dead` after `max_attempts`, permanent ones (object
missing, hash/size mismatch, provider not configured) go `dead` at once. The document stays `ocr_failed`, visible, until staff
retry (enqueue a new job with the `:retry:` dedupe key above). A re-claimed attempt (attempt > 1) also resumes a document left in
`processing` by a crashed worker. Redelivery on `ocr_ready|verified|rejected` is a no-op. The draft is never an instruction.

`reconcile_uploads` (self-rescheduling: each run enqueues next hour's job with its dedupe key; every worker serving it also
seeds this hour's job at start-up and every `WORKER_RECONCILE_SEED_SEC`, a no-op thanks to the dedupe key):
(a) `uploaded` older than 15 min: object present with the recorded size -> `accepted` + `ocr_document`; missing / wrong size ->
`rejected` (`object missing`); (b) objects under `documents/` with no `documents` row and older than 1 h are deleted;
(c) `accepted` for 5+ min with no pending/running/failed `ocr_document` job -> enqueue (`ocr_document:{id}:reconcile:{hour}`);
(d) `processing` for 30+ min with no live job -> `ocr_failed` (`processing stalled`). Logs carry counts only.
