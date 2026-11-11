# Runbook

Operations guide for the local demo and the compose demo stack, with notes for the hosted Google Cloud reference (which is
a design in this build, not a deployment; see `docs/construction/rollout-plan.md`). Commands assume the repository root.

Rule for this document, as for the whole project: nothing here is a measured result unless it says so and names the
evidence file. RPO and RTO below are **targets**; the measured values belong to the T5 recovery drill
(`docs/evidence/T5-*.md`, pending).

## 1. Processes and ports

| Process | Role | Port | Notes |
| --- | --- | --- | --- |
| `postgres` | PostgreSQL 16, databases `hqms` and `hqms_test` | 5432 | The only stateful service besides the document store |
| `api` | NestJS modular monolith: REST, auth, SSE, display | 3000 | Applies migrations and the demo seed on start in the compose demo only |
| `worker` | Operational jobs: call timeout, reservation release, outbox dispatch | none | Postgres-backed leases (`FOR UPDATE SKIP LOCKED`) |
| `worker-documents` | `ocr_document` and `reconcile_uploads` only | none | Shares the document storage with the api |
| `web` | Static React build behind nginx; proxies `/api/*` to the api | 5173 (80 in container) | Proxy has SSE-safe settings for the live streams |

All provider adapters default to fakes or local ones (local login, local-disk storage, fake OCR, fake assistant). No keys are
needed.

## 2. Start, stop, reset

| Task | Command |
| --- | --- |
| First-time setup (idempotent) | `./init.sh` |
| Run api, worker and web from source | `pnpm dev` (web http://localhost:5173, api http://localhost:3000) |
| Run the document worker from source | `pnpm --filter @hqms/worker dev:documents` (then set `WORKER_JOB_TYPES=call_timeout,reservation_release` on the main worker so OCR never competes with queue timers) |
| Compose demo: build and start | `docker compose up -d --build --wait` |
| Compose demo: stop (keeps data) | `docker compose down` |
| Compose demo: wipe everything | `docker compose down -v` |
| Compose demo: status / logs | `docker compose ps` / `docker compose logs -f api worker worker-documents` |
| Wipe demo data (source run) | `pnpm db:reset` (refuses unless the database name has a `test` segment, `NODE_ENV=development` or `--force`), then `pnpm db:seed` |
| Apply new migrations | `pnpm db:migrate` (idempotent, checksummed, one transaction per file) |

If a host port is taken (for example a local Postgres on 5432 next to the compose Postgres), override it:
`HQMS_PG_PORT=5543 HQMS_API_PORT=3200 HQMS_WEB_PORT=5273 docker compose up -d --build --wait`.

Open the compose demo at `http://localhost:5173` (use `localhost`, not a LAN address). The api image runs with
`NODE_ENV=production`, which sets the session cookie `Secure`; Chrome, Edge and Firefox accept that on `http://localhost`,
Safari and plain-HTTP LAN addresses do not.

## 3. Health checks

| Check | Command | Healthy |
| --- | --- | --- |
| Postgres | `pg_isready -h localhost -p 5432` | accepting connections |
| API | `curl -fsS http://localhost:3000/health` | `{"status":"ok","db":"up"}`; 503 means the database is unreachable |
| Web proxy | `curl -fsS http://localhost:5173/healthz` then `curl -fsS http://localhost:5173/api/health` | `ok`, then the api body above |
| Compose | `docker compose ps` | every service `healthy` |
| Worker | compose healthcheck: database reachable and no job lease expired for more than 2 minutes; also section 6 queries | `healthy`; no old `pending` rows |
| Whole stack | `API_URL=http://localhost:3000 pnpm smoke` (compose: `API_URL=http://localhost:5173/api`) | `9/9 checks passed`, exit code 0 |

### Smoke test

`pnpm smoke` (`scripts/smoke.mjs`) checks `/health`, logs in as each demo role (patient, reception, doctor, follow-up,
admin) and reads `/me`, lists today's sessions as the doctor, reads the public `/display/sessions`, and confirms an
unauthenticated `/me` is refused. It needs the demo seed. It is read-only apart from creating login sessions and exits
non-zero on any failure. CI runs it against the built api bundle and against the compose stack. Run it after every deploy,
restore and rollback. Do not run it against a hosted environment that holds real data (it uses the public demo accounts, which
must not exist there; use a login of your own and the checks in rollout plan section 3 instead).

## 4. Logs and correlation ids

- The api and worker write structured logs to stdout (compose: `docker compose logs`). Level from `LOG_LEVEL`.
- Every API response carries `x-correlation-id`; a client may supply its own (8 to 64 characters of `A-Za-z0-9._-`). The same
  id is stored on the audit row of the operation, so one request can be followed from the client report to the log line to the
  audit trail:
  ```sql
  SELECT occurred_at, actor_role, operation, entity_type, entity_id, reason
    FROM audit_events WHERE correlation_id = '<id from the response header>' ORDER BY id;
  ```
- Logs avoid clinical text on purpose: request and response bodies, SQL values and OCR text are not logged; worker errors keep
  the SQLSTATE or constraint name and a text-free `last_error`. Do not add patient names, phone numbers or document text when
  copying log excerpts into tickets; use ids.
- Hospital-local time is Asia/Kolkata in the UI; logs and `timestamptz` columns are UTC.

## 5. Observability: what to look at

These are the signals the report (6.14) says to observe. Nothing below is instrumented as a dashboard in this build; each
is read with the queries in section 6.

| Signal | Where |
| --- | --- |
| Request latency, controlled conflicts (409), unexpected errors | api logs and response codes |
| Database lock waits and pool pressure | `pg_stat_activity` queries, section 6.6 |
| Active doctor allocations (must be at most one per doctor) | section 6.7 |
| Queue freshness | Target: a committed change reaches SSE clients within 2 s (report objective, measured in T3/T5, not asserted here); the snapshot at `GET /sessions/{id}/queue` carries the queue version |
| Job age and retries | section 6.1 and 6.2 |
| Outbox backlog | section 6.1 |
| Provider spend | not applicable with fake adapters; with real adapters, use the provider console (report Table 16) |

## 6. Common incidents

Run SQL with `psql "$DATABASE_URL"` (source run) or `docker compose exec postgres psql -U postgres -d hqms` (compose).
Queries are read-only unless marked **WRITE**.

### 6.1 Stuck jobs (pending work not running)

Symptom: calls stay `called` past the 2-minute timeout, a late reservation is not released, documents sit in `accepted`.

```sql
-- Jobs by type and state, with the oldest due time
SELECT job_type, state, count(*), min(run_at) AS oldest_run_at
  FROM jobs GROUP BY 1, 2 ORDER BY 1, 2;

-- Due and not picked up (older than a minute is suspicious)
SELECT id, job_type, state, attempts, run_at, now() - run_at AS overdue, left(last_error, 120) AS last_error
  FROM jobs WHERE state IN ('pending', 'failed') AND run_at < now() - interval '1 minute' ORDER BY run_at;

-- Leases that expired while running (crashed or hung runner; it is re-claimed automatically)
SELECT id, job_type, attempts, lease_owner, lease_expires_at
  FROM jobs WHERE state = 'running' AND lease_expires_at < now();

-- Outbox backlog
SELECT count(*) FILTER (WHERE dispatched_at IS NULL) AS undispatched,
       min(occurred_at) FILTER (WHERE dispatched_at IS NULL) AS oldest
  FROM outbox_events;
```

Actions, in order: confirm the matching worker is running and healthy (`docker compose ps`, `docker compose logs worker`);
the `worker` serves `call_timeout`, `reservation_release` and the outbox, `worker-documents` serves `ocr_document` and
`reconcile_uploads`, so an overdue job type tells you which one to look at. Restart the service
(`docker compose restart worker`). Handlers re-check state under the locks and are idempotent, so a restart and a repeated
delivery are harmless. A `running` job whose lease expired is re-claimed by the next poll; if its last attempt crashed it is
buried as `dead`.

### 6.2 Dead jobs

A job is `dead` when attempts reached `max_attempts` or the error is permanent. It stays visible; nothing retries it.

```sql
SELECT id, job_type, attempts, max_attempts, left(last_error, 200) AS last_error, finished_at, payload
  FROM jobs WHERE state = 'dead' ORDER BY finished_at DESC LIMIT 50;
```

Read `last_error` first and fix the cause (provider down, object missing, bad payload). Only then requeue. **WRITE** (one job
at a time; the entity's state is re-checked by the handler, so a stale requeue is a no-op):

```sql
UPDATE jobs
   SET state = 'pending', attempts = 0, run_at = now(), lease_owner = NULL, lease_expires_at = NULL,
       finished_at = NULL, updated_at = now()
 WHERE id = '<job id>' AND state = 'dead';
```

Do not requeue `call_timeout` jobs for sessions that are over: the handler cancels them, but check the entry first. Never
delete job rows; they are part of the evidence trail.

### 6.3 OCR provider down or failing

Core booking and queue use are unaffected (NFR-07). Documents move to `ocr_failed` with a text-free `last_error`; the
`DocumentOCRFailed` event carries the attempt and whether it was final. The draft is never an instruction, so nothing reaches
the assistant from a failed document.

```sql
SELECT status, count(*), min(updated_at) FROM documents GROUP BY 1 ORDER BY 1;
SELECT id, ocr_attempts, left(last_error, 120) AS last_error, updated_at
  FROM documents WHERE status = 'ocr_failed' ORDER BY updated_at;
```

1. Check the provider (`OCR_PROVIDER`; the fake adapter does not fail unless a fixture asks for it). With a real provider,
   check its status page and the timeout setting `OCR_TIMEOUT_SEC`.
2. Once it is back, retry through the application's document retry action (staff, controlled retry, `ocr_failed` only). If
   that route is not available in your build, enqueue the retry job directly. **WRITE** (dedupe key from `apps/worker/README.md`;
   `<n>` is the document's current `version`):
   ```sql
   INSERT INTO jobs (job_type, payload, dedupe_key)
   VALUES ('ocr_document', jsonb_build_object('documentId', '<document id>'), 'ocr_document:<document id>:retry:<n>')
   ON CONFLICT (dedupe_key) DO NOTHING;
   ```
3. Documents stuck in `processing` more than 30 minutes with no live job are moved to `ocr_failed` ("processing stalled") by the
   hourly `reconcile_uploads` job; documents stuck in `accepted` more than 5 minutes get their job re-enqueued the same way.

### 6.4 Live queue screens go stale (SSE)

Clients show a stale banner and fall back to `GET /sessions/{id}/queue` (snapshot recovery); correctness does not depend on the
stream. To find the cause:

1. `curl -sN http://localhost:5173/api/display/events` should print `retry: 3000` immediately and a `ping` event every 15 s.
   If nothing arrives through the proxy but it does directly on `:3000`, the proxy is buffering: confirm `infra/nginx.conf`
   still has `proxy_buffering off` and the long `proxy_read_timeout` for `/api/sessions/*/events` and `/api/display/events`.
2. The api has one batched poller (default every 500 ms, `SSE_POLL_MS`) comparing `sessions.queue_version` for watched sessions.
   Check that the version moves when the queue changes:
   ```sql
   SELECT id, status, queue_version, updated_at FROM sessions WHERE session_date = (now() AT TIME ZONE 'Asia/Kolkata')::date;
   ```
   If the version moves but clients do not update, restart the api (clients reconnect on their own and take a fresh snapshot).
3. Hosted: a load balancer idle timeout shorter than 15 s breaks streams; use a longer one.

### 6.5 Capacity dispute (a session looks overbooked or a place is missing)

The design makes oversubscription impossible through the guard lock plus constraints; this check proves it for the data you
have. Counters must equal the allocations they summarise. Returns no rows when consistent:

```sql
SELECT sc.session_id, sc.booked_capacity, sc.booked_reserved, sc.walkin_capacity, sc.walkin_used,
       count(*) FILTER (WHERE a.kind = 'booked' AND a.state IN ('reserved', 'consumed')) AS booked_counted,
       count(*) FILTER (WHERE a.kind = 'walkin' AND a.state IN ('reserved', 'consumed')) AS walkin_counted
  FROM session_capacity sc LEFT JOIN capacity_allocations a ON a.session_id = sc.session_id
 GROUP BY sc.session_id, sc.booked_capacity, sc.booked_reserved, sc.walkin_capacity, sc.walkin_used
HAVING sc.booked_reserved <> count(*) FILTER (WHERE a.kind = 'booked' AND a.state IN ('reserved', 'consumed'))
    OR sc.walkin_used     <> count(*) FILTER (WHERE a.kind = 'walkin' AND a.state IN ('reserved', 'consumed'));
```

For one session, the same check is the `capacityInvariant(tx, sessionId)` function in `packages/db/src/capacity.ts`
(`ok`, `counters`, `counted`). Then explain a single place from the audit trail (admin screen, or
`SELECT * FROM audit_events WHERE entity_id = '<appointment or session id>' ORDER BY id`). Remember the rules that surprise
people: a consumed place is never reopened (a late admission uses a walk-in place and does not take a second one), and a
reservation is released only after the late grace (15 minutes). If the query returns rows, stop booking for that session
(set it `unavailable` or `closed`), keep the output, and escalate; do not hand-edit counters.

### 6.6 Database lock waits or slow requests

```sql
-- What is running, and for how long
SELECT pid, state, wait_event_type, wait_event,
       now() - xact_start AS xact_age, now() - query_start AS query_age, left(query, 120) AS query
  FROM pg_stat_activity
 WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'
 ORDER BY xact_start NULLS LAST;

-- Who blocks whom
SELECT blocked.pid AS blocked_pid, blocking.pid AS blocking_pid,
       left(blocked.query, 80) AS blocked_query, left(blocking.query, 80) AS blocking_query
  FROM pg_stat_activity blocked
  JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS b(pid) ON true
  JOIN pg_stat_activity blocking ON blocking.pid = b.pid;
```

Transactions are short and take locks in one order (doctor, then session, then capacity guard), so waits should be brief and
a deadlock is retried by the api with the same idempotency key. A transaction that has been open for minutes is the problem:
look at its `query`, and only if it is clearly abandoned terminate it with `SELECT pg_terminate_backend(<pid>);` (**WRITE**;
the open transaction rolls back, which is safe). No external call is made while a lock is held, so a long-held lock points
at the database or a stuck connection, not at a provider.

### 6.7 More than one active allocation for a doctor

Should never return a row (partial unique index plus the guard):

```sql
SELECT doctor_id, count(*) FROM queue_entries WHERE state IN ('called', 'in_service') GROUP BY 1 HAVING count(*) > 1;
```

### 6.8 Login problems

Ten failed logins in 60 s for one IP and email return 429 with `Retry-After`; the limiter is in memory, so restarting the api
clears it. "Login works but pages return 401" means the cookie is not being sent: use the web origin and `/api` proxy, and see
the `Secure` cookie note in section 2.

### 6.9 Other

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `init.sh` cannot start Postgres | No `service` and no Docker | Start Postgres 16 yourself on 5432 and re-run |
| `relation ... does not exist` | Migrations not applied | `pnpm db:migrate` (compose: restart `api`) |
| Migration checksum error | An applied file was edited | Restore the original; add a new numbered migration |
| Seed refused ("refusing to seed demo accounts") | `NODE_ENV=production` without `ALLOW_DEMO_SEED=true` | Correct in the demo stack; **never** override on real data |
| Tests fail with connection errors | `hqms_test` missing | `./init.sh` creates both databases |
| `pnpm verify:fast` matches nothing | Base ref missing | `git fetch origin` or set `HQMS_BASE_REF` |
| Document upload fails with 413 behind the proxy | Body over 12 MB | The application limit is 10 MB and 10 pages; proxy allows 12 MB for multipart overhead |

## 7. Backup and restore

Backup is two things that must be taken together: the database and the document storage (object references in `documents`
point at files). Take the database dump first, then the storage archive, so every referenced object exists in the archive.
Objects written between the two are orphans and are cleaned by `reconcile_uploads`.

### 7.1 Local source run

```bash
mkdir -p backup
pg_dump -h localhost -U postgres -Fc hqms > backup/hqms-$(date -u +%Y%m%dT%H%M%SZ).dump
tar czf backup/storage-$(date -u +%Y%m%dT%H%M%SZ).tgz -C var/storage .     # STORAGE_DIR, default ./var/storage
```

### 7.2 Compose demo

```bash
mkdir -p backup
docker compose exec -T postgres pg_dump -U postgres -Fc hqms > backup/hqms.dump
docker run --rm -v "$(docker compose config --format json | jq -r .name)_storage:/data:ro" -v "$PWD/backup:/backup" \
  --entrypoint tar postgres:16 czf /backup/storage.tgz -C /data .
```

(`jq` only resolves the compose project name; the volume is `<project>_storage`, see `docker volume ls`.)

### 7.3 Restore

1. Stop writers: `docker compose stop web api worker worker-documents` (source run: stop `pnpm dev`). Keep Postgres up.
2. Restore into an empty database (a safe drill is a scratch name first, `hqms_restore_check`, then compare):
   ```bash
   docker compose exec -T postgres psql -U postgres -c "DROP DATABASE IF EXISTS hqms WITH (FORCE)" -c "CREATE DATABASE hqms"
   docker compose exec -T postgres pg_restore -U postgres -d hqms --no-owner < backup/hqms.dump
   # source run: pg_restore -h localhost -U postgres -d hqms --no-owner backup/hqms.dump
   ```
3. Restore the storage volume (compose: `docker run --rm -v <project>_storage:/data -v "$PWD/backup:/backup" --entrypoint sh postgres:16 -c "rm -rf /data/* && tar xzf /backup/storage.tgz -C /data && chown -R 1000:1000 /data"`; the `node` user in the images has uid 1000).
4. Start the api (it applies any newer migrations) and the workers: `docker compose up -d`.
5. **Post-restore reconciliation (report 6.14), before staff resume calling patients:**
   1. Run the upload reconciler now rather than waiting for the hour: it re-checks `uploaded` rows against the objects present
      and re-enqueues stalled OCR. **WRITE** (dedupe key makes a repeat a no-op):
      ```sql
      INSERT INTO jobs (job_type, payload, dedupe_key)
      VALUES ('reconcile_uploads', '{}'::jsonb, 'reconcile_uploads:manual-' || to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS'));
      ```
   2. Check pending jobs make sense against the restored data (section 6.1); jobs for entities that no longer exist are
      cancelled by their handlers.
   3. Verify the capacity invariant (section 6.5) and the single-allocation check (section 6.7): both must return no rows.
   4. Check the migration level matches the build: `SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1;`.
   5. Run `pnpm smoke`.
   6. Refresh client snapshots: tell staff to reload their queue screens (the restored `queue_version` may be lower than what
      a browser holds; a reload fetches `GET /sessions/{id}/queue` fresh and re-subscribes), and reload the waiting-room display.
   7. Only then let doctors resume calling. Record the time restored data ends (latest `audit_events.occurred_at`) as the
      measured recovery point, and the elapsed time from outage start to this step as the measured recovery time.
6. Hosted reference: Cloud SQL point-in-time recovery to a new instance, restore the bucket object versions as needed, point
   the api at the new instance, then steps 5.1 to 5.7. A daily backup alone cannot establish a 15-minute recovery point; PITR
   with transaction-log retention is required (report 6.14).

What the compose restore was run against in this build: the dump and restore commands above were executed once on a freshly
started compose stack with the seed data (a scratch database restored from the dump and queried). No failure, timing or loss
exercise has been run yet; that is T5.

## 8. RPO and RTO

| Term | Definition used here | Target (NFR-05, hosted reference) | Measured |
| --- | --- | --- | --- |
| RPO, recovery point objective | Maximum committed data that may be lost: time between the last committed change and the latest change present after recovery | 15 minutes or less | **measured in T5** (`docs/evidence/T5-*.md`): pending |
| RTO, recovery time objective | Elapsed time from the start of the outage until staff can safely resume operations (restore finished and section 7.3 step 5 complete, not merely the database up) | 60 minutes or less | **measured in T5**: pending |

These are targets for the hosted reference, not claims. The local compose demo has no backup schedule, so it has no RPO at all
beyond the last manual dump. NFR-04 (99.5% availability in declared operating hours, 72 minutes of downtime in a 30-day,
8-hour/day planning month) is likewise a target; no achieved uptime is claimed, and neither a single host nor a short load test
demonstrates it.

## 9. Rollback

Application rollback does not roll back the schema: migrations are forward-only (report 6.13).

1. Redeploy the previous image tag for api, worker and web (compose demo: check out the previous commit and
   `docker compose up -d --build`). Because the schema only moves forward through additive, compatible steps (expand then
   contract), the previous release runs against the newer schema. If a release contains a contract migration (dropping or
   narrowing something), it is not rollback-safe: plan the restore path in advance.
2. Do not edit or delete applied migration files (checksum error). Fix forward with a new numbered file.
3. If data was damaged, restore (section 7.3) rather than hand-editing, then reconcile.
4. After any rollback: `pnpm smoke`, section 6.1 queries (jobs drain), reload client snapshots, and only then resume calling.
5. Record the rollback (from version, to version, reason, time) in the change log. See rollout plan section 6.

## 10. Configuration

All settings are environment variables listed in `.env.example`; provider adapters and their keys are described in
`docs/construction/config-management.md`. Never put secrets in the repository or an image. The compose demo uses public
demo values and the demo seed (password `demo1234`); that is acceptable only because it holds no real data.
