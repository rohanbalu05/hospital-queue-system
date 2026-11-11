# HQMS Phase 2 build plan

Orchestrator: main session (Opus). Builders: `.claude/agents/*` (Sonnet, worktree isolation), max 4 at once.
Integration branch: `claude/wonderful-galileo-2es87v` (called "main" below; see DECISIONS D-001).

Sources: `docs/spec/phase1-report.md` (binding), `docs/spec/phase2-syllabus.md`, `docs/spec/phase1-presentation-script.md` Q&A.

## Package map

| Package | Path | Owner | Depends on |
| --- | --- | --- | --- |
| `@hqms/contracts` | `packages/contracts` | orchestrator | zod |
| `@hqms/domain` | `packages/domain` | domain-engineer | nothing (pure TS) |
| `@hqms/db` | `packages/db` | db-engineer | pg, `@hqms/contracts` (types) |
| `@hqms/api` | `apps/api` | api-engineer | contracts, domain, db |
| `@hqms/worker` | `apps/worker` | worker-engineer | contracts, domain, db |
| `@hqms/web` | `apps/web` | ui-engineer | contracts |
| tests | `tests/` | test-engineer | everything (black box via HTTP + pg) |

Dependency rules (dependency-cruiser): domain imports nothing outside itself; apps never import each other; web imports only contracts; db never imports apps.

## Shared contracts every builder relies on

- **Schema:** `db/migrations/0001_init.sql` (orchestrator). New tables/columns go in `0002+` files owned by db-engineer; others ask via their report.
- **DB helper** (`@hqms/db`, db-engineer, Wave 0):
  - `createPool(url?)`, `getPool()`.
  - `withTransaction(pool, fn, opts?)`: BEGIN … COMMIT on one checked-out client; bounded retry (default 3) on `40001`/`40P01`; `opts.idempotency = { actorId, operation, key, requestHash }` → returns stored response on replay, throws `IdempotencyConflictError` (→409) if the hash differs; stores the response in the same transaction.
  - Lock helpers enforcing the order **doctor → session → capacity guard**: `lockDoctor(tx, doctorId)`, `lockSession(tx, sessionId)`, `lockCapacity(tx, sessionId)`; calling them out of order throws `LockOrderError` (checked per transaction).
  - `writeAudit(tx, {...})`, `writeOutbox(tx, {...})` (also bumps nothing; callers bump `sessions.queue_version`), `enqueueJob(tx, {...})`.
  - Repositories: plain functions taking `tx`, raw SQL, returning camelCase rows typed with `@hqms/contracts` types.
  - Migration runner `pnpm db:migrate` (`schema_migrations` table, checksums, one tx per file) and `pnpm db:seed` (idempotent demo data, password `demo1234`).
- **Domain** (`@hqms/domain`): `selectNext(state, policy, decisionTime)` → `{ candidateId | null, reason, pointerAfter, explanation }`; `isEligible`, state machines for appointment, visit, queue entry, follow-up task, document; `ewmaUpdate`; `projectEta(...)` → `{ status: 'ok'|'withheld'|'unsupported', lowMin, highMin, computedAt }`.
- **Errors:** every 4xx/5xx body matches `ApiError` in contracts (`{ error: { code, message, details? } }`). Stale/conflict → 409, validation → 400, authz → 403/404 (404 when the resource must not be disclosed).

## Waves

### W0 Foundation (orchestrator + 4 builders)

Orchestrator: PLAN/feature_list/PROGRESS/DECISIONS; minimal root scaffold; `packages/contracts`; `db/migrations/0001_init.sql`; `docs/gates/G0.md`.

| Builder | Tasks | Exclusive paths |
| --- | --- | --- |
| devops-engineer | 1 root scripts verify / verify:fast / test:concurrency / e2e / dev / db:*; 2 ESLint strict flat config + Prettier; 3 dependency-cruiser rules; 4 Semgrep config + script; 5 docker-compose.yml, infra/, init.sh, .env.example, GitHub Actions CI; 6 docs/construction/construction-plan.md + config-management.md, README quick start | root config files (`package.json`, `tsconfig*.json`, `eslint.config.*`, `.dependency-cruiser.cjs`, `.semgrep/`, `vitest.*`, `.prettierrc`), `.github/`, `infra/`, `docker-compose.yml`, `init.sh`, `.env.example`, `scripts/`, `docs/construction/`, `README.md` |
| db-engineer | 1 `@hqms/db` pool + config; 2 migration runner + `schema_migrations`; 3 `withTransaction` + lock-order helpers + bounded retry; 4 idempotency records (replay/409); 5 audit/outbox/job writers + base repositories; 6 idempotent seed (1 hospital, 5 depts, 10 doctors, 2 sessions/day × today+6 days, 22 staff, 40 patients, demo accounts) + integration tests on real Postgres | `packages/db/`, `db/seed/`, `db/migrations/0002+` |
| domain-engineer | 1 policy types + Table 7 defaults; 2 eligibility (early 10, late grace 15, re-entry); 3 `selectNext` (priority → aging → A,A,W rotation, tie-breakers, pointer rules); 4 Table 8 golden test + fast-check properties (determinism, pointer preservation on overrides, no credits for empty groups, non-preemption); 5 lifecycle state machines; 6 EWMA + ETA projection (simulated time, pause → withheld) | `packages/domain/` |
| ui-engineer | 1 Vite + React + TS + Tailwind + shadcn/ui setup; 2 hospital-ui tokens, Atkinson Hyperlegible via @fontsource; 3 app shell + role routing + API client (TanStack Query, contracts types, cookie auth); 4 login screen; 5 shared queue primitives (token tag A/W/P, lane, capacity bar, stale banner); 6 Playwright screenshot harness for 1440/390 | `apps/web/` |

### W1 Core (M1–M2)

| Builder | Tasks | FRs |
| --- | --- | --- |
| api-engineer #1 | NestJS app bootstrap, config, error filter mapping ApiError, zod validation pipe; IdentityProvider(local, argon2, httpOnly cookie) + `identity-platform` stub; guards (role, assignment, ownership, default deny); `/auth/login`, `/auth/logout`, `/me`; patients (assisted registration, own-record reads); authz integration tests | FR-01, NFR-06 |
| api-engineer #2 | scheduling: doctors/sessions list, session capacity update (reject invalid reductions), `POST /appointments` (idempotent), cancel, reschedule, `POST /appointments/{id}/check-in`, `POST /sessions/{id}/walk-ins`, late-arrival rules; integration tests | FR-02–05 |
| ui-engineer | patient booking flow (390 px first, keyboard), my appointments, reception arrivals desk (search, check in, admit walk-in), screenshots | FR-03–05, NFR-08 |
| test-engineer | T1: last-slot race (N parallel real connections), reschedule rollback, idempotent retry; evidence `docs/evidence/T1-booking-collision.md` | FR-03–04, NFR-03 |

Gate 1: T1 + Table 8 golden green.

### W2 Queue + live (M3–M4)

| Builder | Tasks | FRs |
| --- | --- | --- |
| api-engineer | call-next (doctor → session locks, outstanding-allocation check, domain selector, decision row), start/complete (EWMA update), skip/re-entry/mark absent, pause/resume/unavailable, authorized priority, `GET /sessions/{id}/queue` snapshot, `GET /sessions/{id}/events` SSE, public display endpoint, ETA | FR-06–10, FR-15 |
| worker-engineer | job runner (`FOR UPDATE SKIP LOCKED` leases, attempts, backoff, dead state), timers: 2-min call timeout → skipped, late-grace reservation release, outbox → notifications | FR-08, NFR-07 |
| ui-engineer | doctor console (Now panel, Call next + reason, waiting list, pause), reception queue board lanes, waiting-room display (1920×1080, reconnecting) | FR-08–10 |
| test-engineer | T2 concurrent call-next incl. overlapping sessions; e2e book → check-in → call → complete (keyboard) | FR-06–08, NFR-03, NFR-08 |

Gate 2: T2 + full visit e2e.

### W3 Follow-up loop (M5–M6)

| Builder | Tasks | FRs |
| --- | --- | --- |
| api-engineer | follow-up tasks (create, acknowledge, disposition, overdue view), documents (upload limits, private storage adapter, download authz), OCR draft review + instruction verification versions, assistant endpoint (LlmProvider fake, cites version, escalates), return booking linked to task, audit/report endpoints | FR-11–15 |
| worker-engineer | OCR job (OcrProvider fake, retries, failure state), assistant job if async, upload reconciler | FR-12, NFR-07 |
| ui-engineer | follow-up inbox + task detail + book return, doctor review inbox (draft vs instruction), patient documents + assistant + follow-ups, admin sessions/policy/reports | FR-11–15 |
| test-engineer | T4: unverified text never reaches assistant, unsupported question → owned task, cross-patient document access denied | FR-11–14, NFR-06–07 |

Gate 3: T4 green.

### W4 Evidence (M7–M8), HARD gate

test-engineer: T3 (snapshot/ETA), T5 (load via autocannon, failure injection, restore drill), T6 (audit, keyboard walkthrough), seeded FCFS-vs-policy simulation, unit-test coverage report. devops-engineer: runbook, rollout-plan.md, uat-checklist.md, static-analysis.md, dynamic-analysis.md. Reviewers. Orchestrator: `docs/evidence/SUMMARY.md`, `docs/gates/G4.md`.

## Per-wave routine

Merge branches one at a time → `pnpm verify` → reviewers (spec, concurrency-security, ui) → fix P0/P1 → flip `passes` only for criteria green this session → PROGRESS.md → tag `wave-N` → `docs/gates/G<N>.md` → push.
