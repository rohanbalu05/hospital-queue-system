# Decisions log

Choices made during the build that the spec or CLAUDE.md did not settle. Newest last. HQ reviews on return.

## D-001 Integration branch is the session branch, not `main`
This cloud session may only push `claude/wonderful-galileo-2es87v`. That branch plays the role KICKOFF calls "main": builders' worktree branches merge into it, `pnpm verify` runs on it, tags `wave-N` point at it. HQ merges it into `main` (PR) after review.

## D-002 Shared `@hqms/db` package (`packages/db`)
Table 14 has no shared persistence package, but both `apps/api` and `apps/worker` need the same pool, `withTransaction`, lock-order helpers, idempotency, audit/outbox/job writers and repositories. Duplicating the lock-order contract in two apps would break "every writer follows the same contract". `packages/db` holds them; `db/migrations` stays the schema source. dependency-cruiser keeps it free of app imports.

## D-003 Work pulled forward into Wave 0
To use the 4-builder budget and unblock W1, Wave 0 runs devops-engineer, db-engineer (transaction helper, idempotency, runner, seed), domain-engineer (whole policy package; it depends on nothing) and ui-engineer (scaffold, tokens, shell, login). The orchestrator wrote a 3-file root scaffold (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`) so worktrees can install; devops owns those files from then on.

## D-004 `packages/domain` has zero runtime or type dependencies
Domain re-declares its literal types (groups, states, reasons) instead of importing `@hqms/contracts`. Keeps it trivially framework-free; a contract test in `apps/api` checks the literals match.

## D-005 One active doctor allocation enforced on `queue_entries`
Table 13's "partial unique index over active called/in-service allocations" is `UNIQUE (doctor_id) WHERE state IN ('called','in_service')` on `queue_entries` (doctor_id is denormalised onto the entry). The doctor guard is `SELECT … FOR UPDATE` on the `doctors` row; the session guard is the `sessions` row; the capacity guard is the `session_capacity` row.

## D-006 Clinical sessions table is `sessions`; login sessions are `auth_sessions`
Matches the Table 10 routes (`/sessions/{id}/…`).

## D-007 Enumerations as `text` + `CHECK`
Easier to evolve with plain SQL migrations than Postgres enum types.

## D-008 Lockfile conflicts are regenerated
Parallel builders each touch `pnpm-lock.yaml`. On merge conflict the orchestrator takes either side and reruns `pnpm install` to regenerate, then runs `pnpm verify`.

## D-009 Estimator context is per doctor
EWMA state (`service_estimates`) is keyed by doctor, carried across that doctor's sessions, starting at 12 min. Report says "relevant doctor/session context"; per-doctor gives the estimator more samples at 10–15 visits per session.

## D-010 Internal packages ship TypeScript source
`@hqms/contracts`, `@hqms/domain`, `@hqms/db` export `./src/index.ts` directly (no build step). Vite and Vitest compile them natively; `apps/api` and `apps/worker` run through a TS-aware runtime (SWC/tsx) in dev and bundle for the Docker image. Avoids stale `dist/` during parallel builds. Relative imports use `.js` suffixes (NodeNext).

## D-011 zod 3 for contracts
`zod@^3.24` (widely known API, stable with NestJS pipes). Upgrade to zod 4 is a later, isolated change.

## D-012 Auth on state-changing POSTs
Every state-changing POST that creates something (book, check-in, walk-in, call-next, follow-up task, return booking, verify) accepts an `Idempotency-Key` header; book/check-in/walk-in/call-next/return-booking require it. Idempotency is scoped to (actor, operation, key) with a SHA-256 of the canonical request body.

## D-013 Routes at the API root; web proxies `/api`
The API serves Table 10 paths unprefixed on :3000 (`POST /appointments`). The web app calls `/api/...`; Vite dev server (and the nginx container in Compose) proxies `/api/*` → `http://api:3000/*` stripping the prefix, so the session cookie is same-origin (`httpOnly; SameSite=Lax; Path=/`).

## D-014 Shared library choices
- Password hashing: `@node-rs/argon2` (argon2id, prebuilt binaries, no node-gyp) in both seed and API.
- Playwright: `@playwright/test@1.63.0` to match the pre-installed Chromium in cloud sessions.
- Domain property tests: `fast-check`. Tests: Vitest 2.

## D-015 Queue-policy interpretations (domain-engineer, W0)
- Rotation pointer = 0-based index of the next position to inspect; `pointerAfter = (servedSlot + 1) % n`; overrides and NO_ALLOCATION keep it. Table 8 pointer trace is 1, 1, 2, 0, 0.
- NO_ALLOCATION check order: doctor occupied → session not callable → nothing eligible.
- Final tie-breaker after the report's keys is `seq`, then `id`, so output is independent of input order.
- Queue-entry machine: `called → in_service | skipped`; `skipped | absent → waiting (re-entry) | cancelled`; `waiting → called | absent | cancelled`. Manual `/skip` is `called → skipped`.
- Re-entry: the domain gives fresh eligibility; the API applies late rules by calling `classifyArrival` with the re-entry time (after grace → staff review + walk-in ordering).
- ETA: `scheduled`/`unavailable`/`closed` sessions and paused-with-unknown-end are `withheld` ("Estimate paused"); an overrun pause (`pauseUntil <= now`) is also withheld. Called-not-started residual = remaining call-timeout + m. Overrun consultation (elapsed > m): point residual 0 but upper bound widened by m, noted. Range ±50% when < 5 samples, else ±30%; note always says "model estimate, not a measured confidence interval".
- `ewmaUpdate` throws on invalid alpha or negative duration; API sanitises durations.

## D-016 Web stack versions
React 19, Tailwind 4, react-router 7, Vite 5.4 (Vitest 2 bundles Vite 5), shadcn new-york style restyled to the hospital-ui tokens. Hospital display name "BMSIT Teaching Hospital, Yelahanka" (matches seed).

## D-017 Guard locks use `FOR NO KEY UPDATE` (db-engineer, W0)
FK inserts take `FOR KEY SHARE` on `doctors`/`sessions`; with `FOR UPDATE` guards a booking (holding capacity, inserting an appointment → KEY SHARE on doctor) and a call-next (holding doctor, waiting for session) deadlock. `FOR NO KEY UPDATE` still makes guard lockers exclude each other and doesn't conflict with KEY SHARE. A regression test in `packages/db/test/locks.test.ts` reproduces the deadlock with `FOR UPDATE`.
Also: idempotency advisory lock is rank 0 (taken before the doctor); ids within one rank must ascend in a transaction (lock multi-row sets in one batch call); writers assert the lock they need. MRNs come from sequence `patient_mrn_seq` (migration 0002) so registration takes no guard lock.

## D-018 Wave 1 composition
W1 = api-engineer (bootstrap, identity, authz, scheduling, arrivals), ui-engineer (patient booking, reception desk), worker-engineer (job runner + call_timeout / reservation_release timers + outbox dispatcher, pulled forward from W2 because it only needs `@hqms/db`). test-engineer joins after the API merges (T1 over HTTP) and meanwhile builds the seeded FCFS-vs-policy simulation (only needs `@hqms/domain`).

## D-019 Wave tags are local only
The session's git proxy only accepts pushes to the session branch, so `wave-N` tags exist in the local clone and are recorded with their commit hashes in PROGRESS.md. HQ can recreate them (`git tag wave-N <hash>`) after merging. wave-0 = the G0 build-state commit.

## D-020 API implementation choices (api-engineer, W1)
- No emitted decorator metadata: every Nest constructor param uses explicit `@Inject(TOKEN)`, so esbuild (tsx dev, tsup build, Vitest) is enough; no SWC.
- Check-in / walk-in accept `scheduled|open|paused` sessions on the session's own IST date (patients arrive before the doctor opens); `unavailable|closed` → 409 SESSION_NOT_CALLABLE. Booking needs `scheduled|open` and a session that hasn't ended.
- Staff patient lookup is hospital-wide for staff roles (reception must find anyone to register/book); appointments, sessions and arrivals are scoped by assigned doctor (403 outside scope); patients get 404 for anything not their own (no existence disclosure).
- Booking assigns the first free slot; repeat check-in returns the existing arrival (200) with no new audit/outbox/version bump.
- Cancel/reschedule/check-in mark the pending `reservation_release` job `cancelled`; the worker also re-checks state.
- Login rate limit in memory, 10 failures / 60 s per IP+email → 429; responses `Cache-Control: no-store`; error filter never logs bodies or SQL values.
- Open (W2): an appointment already marked `missed` by the worker cannot be checked in; per report §6.2 ("a late return does not retain guaranteed admission") it should be admissible only as a late admission (walk-in capacity + order). W2 adds the `missed → checked_in` edge restricted to the late-admission path.

## D-021 List responses are plain JSON arrays; staff appointment reads carry patient fields
All list endpoints return a JSON array (no `{items}` envelope) until pagination is needed. `Appointment` gains optional `patientName`, `patientMrn`, `patientPhone` (staff reads only, never on patient reads) and `queueEntryId`/`token` once checked in, so the reception desk can render today's list and tokens after reload.

## D-022 Wave 0–1 review dispositions
Spec reviewer and concurrency-security reviewer ran on W0–W1 (no P0 invariant breaks found by either).
- **feature_list corrections (spec P0):** FR-01-a (document half), FR-04-c (completed-visit case) and FR-05-b (late admission after the worker marks `missed`) flipped back to `passes:false` until their tests exist.
- **Fix in W2 (api):** past-slot booking (first free slot must be ≥ now − late grace… chosen rule: `slot + lateGrace > now`, else CAPACITY_FULL); one active appointment per patient per session (migration 0003 partial unique index + reschedule updates the old row first) and walk-in refused when the patient holds an active appointment there; `missed → checked_in` only via late admission; `ReservationReleased` emitted on late admission; patient-facing notification wording distinguishes cancel/reschedule from timer release; staff 404-for-missing vs 403-for-out-of-scope kept, but patient search restricted to reception/admin with q ≥ 3 chars and audited; doctor/followup read a patient only when linked by appointment/visit/task in their scope.
- **Late admission releases the booked place (spec P1-6):** kept. The booked reservation is by definition missed after grace (report §6.2: "A missed reservation may be released after the grace rule"); the patient consumes a walk-in place instead, so one person never holds two places.
- **ETA uncertainty:** `Eta.uncertainty` enum added to contracts (cold_start / warm / widened_overrun), domain to populate it.
- **Event list extension (spec P2-7):** QueueEntryReentered, QueuePriorityChanged, SessionPaused/Resumed/Unavailable, DocumentOCRFailed, FollowUpAcknowledged are additions beyond §6.7 for the operations the FRs require; same envelope rules.
- **Hardening queued (db/worker fix pass):** lockSession asserts doctor held, lockCapacity asserts session held; job claim excludes exhausted running jobs; `UNIQUE (lower(email))`; worker logs SQLSTATE/constraint not raw messages; per-IP login limiter; seed refuses NODE_ENV=production; composite ownership FKs for instruction_versions/messages before W3.
- **Accepted:** business errors don't store idempotency records (a retry re-executes; documented). Outbox `position` is not commit order — SSE uses `sessions.queue_version` + snapshot, never position.

## D-023 Provider adapters live in `packages/providers` (`@hqms/providers`)
`ObjectStorage` (local-disk default, gcs stub), `OcrProvider` (fake default: deterministic text from fixtures, google-vision stub) and `LlmProvider` (fake default: templated answers citing the instruction version, gemini stub; model id from `LLM_MODEL`, default `gemini-3.5-flash-lite`) are needed by both the API (upload, assistant) and the worker (OCR). One shared package keeps one adapter contract; selection by env (`OBJECT_STORAGE`, `OCR_PROVIDER`, `LLM_PROVIDER`). No provider is called inside a DB transaction.

## D-024 W3 started early in parallel with W2 api
worker-engineer (providers package, OCR job, upload reconciler) and ui-engineer (follow-up inbox, review inbox, patient documents/assistant/follow-ups, admin) start before the W2 API merges because they don't touch `apps/api`. W3 api work starts after W2 api merges.

## D-025 Queue API choices (api-engineer, W2)
(API code comments cite these as "D-023" — read D-025.)
- First call-next on a `scheduled` session dated today auto-opens it (audited `session.open`).
- Check order: doctor occupied → session callable → selection (D-015). NO_ALLOCATION records a decision row, no audit row, no queue bump.
- Late re-entry (group A past grace) needs `admitLate: true`; the entry converts to W ordering (`checked_in_at` = now, visit kind `late_admission`), keeps its token, and does NOT take a second walk-in place — the patient's place was consumed at first check-in and consumed places never reopen.
- `expectedVersion` on start/complete is the queue-entry version (what clients see).
- Roles: start/complete and priority doctor-only; open/pause/resume/unavailable doctor+reception+admin; close doctor+admin.
- Display `nowCalling` = entry in state `called` only.
- Consultation duration sanitised (>0, ≤180 min) before the EWMA; invalid → no update.
- Skip and start cancel the pending `call_timeout` job; absent emits `QueuePatientSkipped` with `kind:'absent'`; open/close emit no outbox event (no event type in §6.7) but audit + bump.
- SSE: one batched poller per API instance (500 ms) over watched sessions' `queue_version`; immediate version on connect; ping 15 s; no LISTEN/NOTIFY needed for the 2 s objective.
- Past-slot booking fixed (slot + grace > now); one active appointment per patient per session (migration 0003); patient search reception/admin only, ≥3 chars, audited by length only.

## D-026 Follow-up loop API choices (api-engineer, W3)
- Migration 0005 adds `instruction_versions.title` (immutable with the version) so retitling v2 cannot rewrite what v1 showed.
- `PatientScope`: staff see a patient only when linked by appointment/visit to a doctor in their scope (admin all); out of scope → 404.
- Reception may upload and read document metadata and retry OCR for in-scope patients, but cannot download files, read OCR drafts or read instructions (clinical content); doctor/followup/admin can. Only doctors verify (FR-01-b).
- Completing a consultation does not auto-create a follow-up task; the doctor creates it explicitly.
- Assistant escalation owner = the follow-up user assigned to one of the patient's doctors with the fewest open tasks (else unassigned); due in 24 h; provider reason text goes to audit only (≤200 chars); the patient sees fixed wording. Provider error, timeout (`ASSISTANT_TIMEOUT_MS`, 15 s), no context, or a citation outside the supplied current versions all escalate.
- Return booking shares one private booking path with normal booking; lock order doctor → session → capacity → task row; both links written in the same transaction.
- PDF page count from `/Type /Page` objects with `/Count` fallback; undeterminable → refused (400).
- Report: wait = latest call decision − `eligible_at`; group P = any entry with a priority class; target rows carry null sample size and "Phase 1 target, not measured here".

## D-027 Black-box test database isolation
`tests/` suites recreate a scratch DB; parallel runs (orchestrator + builders) must set `BLACKBOX_DB_NAME` to a unique name. Two flaky failures this session (ECONNREFUSED, "database does not exist") were caused by concurrent runs sharing `hqms_test_blackbox`, not by the app.
