# Hospital Appointment & Queue Management System (HQMS)

BEA (BCS703B) course project, Phase 2, BMSIT ISE 2026-27. Team: Rohan Balu, Rishab Paul, Rahul Sonar, Rohan Bharat. Guide: Poornima G J.

One hospital, many doctors: capacity-checked booking, an explainable per-doctor queue, live status over SSE, and a closed
follow-up loop (OCR draft, clinical verification, bounded assistant, owned staff task, linked return booking).

The approved design is in `docs/spec/phase1-report.md`. The repo is built by a Claude Code orchestrator (Opus) with Sonnet
subagents; see `KICKOFF.md`, `CLAUDE.md` and `.claude/agents/`.

## Quick start

Prerequisites: Node 22, pnpm 10 (`corepack enable`), and either a local PostgreSQL 16 or Docker.

```bash
git clone <repo-url> && cd hospital-queue-system
./init.sh   # start Postgres, create hqms + hqms_test, install, migrate, seed (idempotent)
pnpm dev    # api :3000, worker, web :5173
```

Open http://localhost:5173. No API keys are needed: login, storage, OCR and the assistant use local or fake adapters by
default (see `.env.example`). Check a running api with `pnpm smoke`.

### GitHub Codespaces

Create a codespace on this branch (Code → Codespaces). `.devcontainer/` installs Node 22, pnpm, PostgreSQL 16 and
Playwright Chromium on first start (a few minutes), and starts Postgres on every start. Then:

```bash
./init.sh
pnpm dev
```

Open the forwarded port 5173 (Ports tab → globe icon). The web app calls the api through its same-origin `/api` proxy.

### Container demo

```bash
docker compose up -d --build --wait   # postgres, api, worker, worker-documents, web (nginx) -> http://localhost:5173
API_URL=http://localhost:5173/api pnpm smoke
docker compose down -v                # stop and wipe
```

The api applies migrations and the demo seed on start. Use `localhost` in the browser (the production-mode api sets a `Secure`
cookie). If a port is taken, set `HQMS_PG_PORT`, `HQMS_API_PORT` or `HQMS_WEB_PORT`. Demo only: public password, fake adapters.

### Demo accounts

Every demo account has the password `demo1234` (created by the seed in `db/seed`; full list in `db/seed/README.md`).

| Role | Email | Scope |
| --- | --- | --- |
| Patient | `patient@hqms.test` | Ramesh Kumar, booked today with `doctor@hqms.test`. `patient2` .. `patient10` also exist |
| Receptionist | `reception@hqms.test` | All 10 doctors. `reception2` .. `reception6`: 2 doctors each |
| Doctor | `doctor@hqms.test` | Dr. Suresh Hegde (General Medicine). `doctor2` .. `doctor10` |
| Follow-up staff | `followup@hqms.test` | All 10 doctors. `followup2` .. `followup4` |
| Admin | `admin@hqms.test` | Hospital-wide. `admin2@hqms.test` |

The seed refuses to run with `NODE_ENV=production` unless `ALLOW_DEMO_SEED=true`; the compose demo is the only place that sets it.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm verify` | typecheck, ESLint (strict), dependency-cruiser, Vitest unit and integration, Semgrep (`p/typescript`, `p/owasp-top-ten`) |
| `pnpm verify:fast` | typecheck and tests for packages changed against the base ref (`HQMS_BASE_REF`) |
| `pnpm test:concurrency` | real-Postgres race tests (T1, T2); builds the api and runs it against a scratch database |
| `pnpm e2e` | Playwright flows (api and web running; `PW_CHROMIUM_PATH` for a pre-installed Chromium); writes screenshots to `docs/evidence/screenshots/` |
| `pnpm smoke` | health, login per role, sessions, display against `API_URL` (default http://localhost:3000); non-zero exit on failure |
| `pnpm coverage` | Vitest v8 coverage per package plus `docs/evidence/coverage-summary.json` |
| `pnpm evidence:static` / `pnpm evidence:tests` | regenerate `docs/evidence/static-analysis.md` / `unit-tests.md` |
| `pnpm --filter @hqms/tests simulate` | seeded FCFS vs policy simulation (`docs/evidence/simulation-fcfs-vs-policy.md`) |
| `pnpm db:migrate` / `db:seed` / `db:reset` | migrations, demo seed, reset (refuses unless a test database or `--force`) |
| `pnpm depcruise` / `lint` / `typecheck` / `format:check` | the individual checks |

CI (`.github/workflows/ci.yml`) runs `pnpm verify`, the concurrency tests and coverage against a Postgres service container
(uploading coverage), then builds and smoke-tests the api bundle, builds and smoke-tests the compose stack, and runs
Playwright (the last is non-blocking).

## Repository map

Follows report Table 14, plus the shared packages added during the build (D-023).

| Path | Responsibility |
| --- | --- |
| `apps/web` | React, TypeScript, Vite, Tailwind, shadcn/ui interfaces and client tests |
| `apps/api` | NestJS controllers, authorization, application services, SSE |
| `apps/worker` | Postgres-backed jobs and outbox: call timeout, reservation release, OCR, upload reconciler |
| `packages/domain` | Pure queue policy, state machines, EWMA estimator (imports nothing else) |
| `packages/contracts` | zod schemas for requests, responses and events, shared by api and web |
| `packages/db` | `pg` pool, raw-SQL repositories, one-transaction helper with lock order, migration runner |
| `packages/providers` | Adapters behind ports: object storage, OCR, LLM (fake or local by default) |
| `db/migrations`, `db/seed` | Versioned SQL schema and the idempotent demo seed |
| `tests` | Concurrency, integration, simulation and Playwright scenarios |
| `infra`, `docker-compose.yml` | Dockerfiles and nginx config for the demo stack |
| `scripts` | Evidence generators, coverage summary, smoke script |
| `docs` | Spec, construction plan, runbook, gate reports, evidence |

## Documentation

- Run state: `PLAN.md`, `PROGRESS.md` (read first), `feature_list.json`, `DECISIONS.md`, `docs/gates/`.
- Construction: `docs/construction/construction-plan.md`, `config-management.md`, `rollout-plan.md`.
- Operations: `docs/runbook.md` (health, incidents, backup and restore, rollback).
- Evidence: `docs/evidence/README.md` indexes every file and whether it is present or pending. Targets and measured results are
  kept apart: a target is never presented as a measured result.
