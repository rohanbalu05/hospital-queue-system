# Hospital Appointment & Queue Management System (HQMS)

BEA (BCS703B) course project, Phase 2 build. One hospital, many doctors: capacity-checked booking, an explainable per-doctor queue, live status over SSE, and a closed follow-up loop (OCR draft → clinical verification → bounded assistant → owned staff task → linked return booking).

## Sources of truth (read in this order)

1. `docs/spec/phase1-report.md`: the approved design. FR-01..15, NFR-01..08, Table 7 (policy values), Table 8 (selection trace), section 6.4 (selection pseudocode), Table 10 (routes), event list, Table 13 (constraints and indexes) and Table 14 (repo layout) are **binding**.
2. `docs/spec/phase2-syllabus.md`: what Phase 2 is graded on, and the evidence files the build must produce.
3. `docs/spec/phase1-presentation-script.md`: Q&A answers that pin down edge cases (tie-breakers, skips, late arrivals, locks).
4. `PLAN.md`, `PROGRESS.md`, `DECISIONS.md` and `feature_list.json` are the run's state files. Read `PROGRESS.md` and `git log --oneline -30` first whenever you start or resume.

The report's rule applies everywhere: **never present a target as a measured result.** Evidence files separate "target" from "measured".

## Decisions already made (do not change without a DECISIONS.md entry)

- **Monorepo:** pnpm workspaces, Node 22, TypeScript strict everywhere. Package scope `@hqms/*`.
- **Layout:** `apps/web`, `apps/api`, `apps/worker`, `packages/domain`, `packages/contracts`, `db/migrations`, `tests`, `infra`, `docs` (report Table 14).
- **Frontend:** React + TypeScript + Vite, Tailwind CSS, shadcn/ui (Radix) components, TanStack Query, React Router. Fonts self-hosted via `@fontsource` (no external font CDN).
- **Backend:** NestJS modular monolith. **PostgreSQL 16 via node-postgres (`pg`) with raw SQL.** No ORM. Plain SQL migration files in `db/migrations` with a tiny runner.
- **Contracts:** `packages/contracts` holds zod schemas for every request, response and domain event. API and web both import them.
- **Domain:** `packages/domain` is pure TypeScript (queue policy, state machines, EWMA estimator). No framework, DB or I/O imports; enforced by dependency-cruiser.
- **Live updates:** SSE plus snapshot recovery (`GET /sessions/{id}/queue`, `GET /sessions/{id}/events`).
- **Background work:** Postgres-backed jobs and outbox with `FOR UPDATE SKIP LOCKED` leases. No Redis, no Kafka.
- **External providers sit behind adapters, and the FAKE adapter is the default:**
  - `IdentityProvider`: `local` (email + password, argon2, httpOnly session cookie) by default; `identity-platform` later.
  - `ObjectStorage`: `local-disk` by default; `gcs` later.
  - `OcrProvider`: `fake` (deterministic text from fixtures) by default; `google-vision` later.
  - `LlmProvider`: `fake` (templated answers that cite the verified instruction version) by default; `gemini` later. Model id from config, default `gemini-3.5-flash-lite`. (The report names 2.5 Flash-Lite; Google now limits it to existing users.)
- **No API keys are required to build or demo.** Never commit secrets; `.env.example` only.
- **Ports:** web 5173, api 3000. DB `postgres://postgres:postgres@localhost:5432/hqms` and `hqms_test`.
- **Policy values (Table 7):** rotation A,A,W · early eligibility 10 min · late grace 15 min · aging trigger 45 min · called timeout 2 min · EWMA α 0.2 · initial estimate 12 min · session capacity 10 booked + 5 walk-in.

## Commands (create them in Wave 0, keep them working)

- `./init.sh`: start Postgres, install deps, migrate, seed demo data.
- `pnpm verify`: typecheck, lint, dependency-cruiser, unit and integration tests, Semgrep. Must be green before any merge to `main`.
- `pnpm verify:fast`: typecheck and tests for the packages changed vs `main`.
- `pnpm test:concurrency`: real-Postgres race tests (T1, T2).
- `pnpm e2e`: Playwright flows; also writes screenshots to `docs/evidence/screenshots/`.
- `pnpm dev`: api + worker + web together.

In cloud sessions Postgres is pre-installed but not running; the SessionStart hook starts it. Docker Compose is for the demo stack (`docker compose up`).

## How the team works

- The main session is the **orchestrator** (Opus). It plans, delegates, merges and verifies. It does not write feature code, except Wave 0's contracts and first migration.
- Builders are subagents in `.claude/agents/` (Sonnet, `isolation: worktree`). **Max 4 builders at once.**
- **One owner per path.** A builder edits only the paths it was assigned. Contract changes go through the orchestrator.
- **Same error 3 times:** stop, write a blocker in `PROGRESS.md`, report back. Do not loop.
- A task is done only when its acceptance test ran green. `feature_list.json` `passes` flips to true only on a green run in this session.
- Commit small and often with conventional commit messages. Builders commit on their worktree branch; the orchestrator merges.

## Code rules that carry marks

- Every state-changing command runs in **one short transaction** via the shared helper: lock order **doctor → session → capacity guard**, bounded retry on serialization or deadlock reusing the same idempotency key. Domain state, audit row and outbox/job intent commit together. No external call while a lock is held.
- Idempotency records: unique (actor, operation, key) plus request hash and stored response. Same key with a different hash → 409.
- Use the constraints from Table 13: unique `queue_entries.visit_id`, unique non-null `visits.appointment_id`, partial unique index for one active called/in-service allocation per doctor.
- All times are `timestamptz`; the UI renders hospital-local time (Asia/Kolkata).
- Authorization is server-side on every route: role + assignment + ownership. A patient can never read another patient's data (NFR-06).
- The queue policy is deterministic: same state, policy version and decision time give the same candidate and reason. Table 8 is a golden test.

## UI rules

- Before any UI work, load the `frontend-design` and `hospital-ui` skills. `hospital-ui` is the binding brief.
- Use shadcn/ui components (shadcn MCP is configured); don't hand-roll inputs, dialogs or menus.
- Every screen is checked with Playwright screenshots at 1440 px and 390 px before it counts as done. Booking and call-next must work by keyboard alone (NFR-08).

## Testing rules

- Concurrency tests (T1, T2) use real PostgreSQL and real parallel connections. Never mock the DB there.
- Domain: Vitest + fast-check property tests (determinism, non-preemption, rotation pointer invariants).
- Simulation (FCFS vs policy) uses seeded generators; record seeds in the evidence file.

## Compact instructions

When compacting, keep: the current wave and task list, which builders are running and their branches, open blockers, the last `pnpm verify` result, and any DECISIONS.md entries made this session.
