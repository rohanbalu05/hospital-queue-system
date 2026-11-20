# Hospital Appointment & Queue Management System (HQMS)

BEA (BCS703B) course project, Phase 2, BMSIT ISE 2026-27. Team: Rohan Balu, Rishab Paul, Rahul Sonar, Rohan Bharat. Guide: Poornima G J.

One hospital, many doctors: capacity-checked booking, an explainable per-doctor queue, live status over SSE, and a closed
follow-up loop (OCR draft, clinical verification, bounded assistant, owned staff task, linked return booking).

The approved design is in `docs/spec/phase1-report.md`. The repo is built by a Claude Code orchestrator (Opus) with Sonnet
subagents; see `KICKOFF.md`, `CLAUDE.md` and `.claude/agents/`.

## Quick start (fresh clone, demo in one command)

The public repo is https://github.com/rohanbalu05/hospital-queue-system. No API keys or cloud accounts are needed: login,
storage, OCR, the assistant and SMS/email notifications all use local or fake adapters (see `.env.example`).
Every launch of the demo script **resets the demo data**, so "today" is always the current date, and it makes sure
`doctor@hqms.test` (Dr. Suresh Hegde) has a session running right now, **at any hour** (it opens the seeded morning or
afternoon session, or creates one labelled morning / afternoon / evening / night; `scripts/demo-session-now.mjs`).

### macOS (Homebrew)

1. Install Homebrew (https://brew.sh) if you do not have it.
2. `brew install node@22 postgresql@16 git` then `brew link --overwrite node@22` and `corepack enable`
   (if `corepack` is missing: `npm install -g pnpm@10.28.0`).
3. `git clone https://github.com/rohanbalu05/hospital-queue-system.git`
4. `cd hospital-queue-system`
5. `./start-demo.sh`

The script starts the Homebrew PostgreSQL 16 service, creates the `postgres` role (password `postgres`) and the `hqms` and
`hqms_test` databases if they are missing, installs packages, resets and seeds the demo data, starts api (:3000), worker and
web (:5173) with logs in `var/demo.log`, opens the demo session, and opens http://localhost:5173. The first run takes a few
minutes (package install). Stop everything with **Ctrl+C** in that terminal.

Troubleshooting (macOS):

- **Port 5432 is used by another Postgres** (Postgres.app, a Docker container, an older Homebrew version): quit it, or
  `brew services stop postgresql@14` (the old version), then run the script again. Check with `lsof -i :5432`. To use a
  different port run `HQMS_PG_PORT=5433 ./start-demo.sh` after starting a Postgres 16 there yourself with `SKIP_BREW=1`.
- **The `postgres` role exists with another password**: either set it to the demo one,
  `psql -d postgres -c "ALTER ROLE postgres WITH LOGIN SUPERUSER PASSWORD 'postgres'"`, or run with your password:
  `DB_PASSWORD=yourpassword ./start-demo.sh`.
- **`pg_isready` / `psql` not found**: Homebrew does not link `postgresql@16` into the PATH. The script adds
  `$(brew --prefix postgresql@16)/bin` itself; to use it in your shell, `export PATH="$(brew --prefix postgresql@16)/bin:$PATH"`.
- **Apple Silicon vs Intel**: Homebrew lives in `/opt/homebrew` on Apple Silicon and `/usr/local` on Intel. If `brew` is
  not found in a new terminal, run `eval "$(/opt/homebrew/bin/brew shellenv)"` (or `/usr/local/bin/brew`), as Homebrew prints at the end of its installer.
- **`node` is the wrong version**: `node -v` must print v22 or newer. `brew link --overwrite node@22` fixes it.
- **Permission denied on `./start-demo.sh`**: `chmod +x start-demo.sh`.

### Windows

1. In PowerShell: `winget install -e --id OpenJS.NodeJS.LTS`, `winget install -e --id Git.Git` and
   `winget install -e --id PostgreSQL.PostgreSQL.16` (when the installer asks, set the superuser password to `postgres`
   and keep port 5432). Close and reopen the terminal.
2. `npm install -g pnpm@10.28.0`
3. Clone to a **short path** (long paths break `node_modules` on Windows):
   `git clone https://github.com/rohanbalu05/hospital-queue-system.git C:\dev\hqms`
4. Double-click **`C:\dev\hqms\start-demo.bat`** (or run it from `cmd`). No PowerShell execution policy change is needed:
   it is a `.bat` file.

It installs packages, resets the demo data, starts api + worker + web, opens the demo session in a minimised window and opens
http://localhost:5173 after about 30 seconds. Close the window to stop everything.

Troubleshooting (Windows):

- **"Could not reach PostgreSQL"**: open Services and start `postgresql-x64-16`. If you chose another superuser password,
  edit `DB_PASSWORD` at the top of `start-demo.bat`.
- **`node` or `pnpm` not found right after installing**: open a new terminal so the PATH refreshes.
- **Port 5432 busy**: another PostgreSQL is installed; stop its service or uninstall it.

### Linux, Codespaces, Docker

- **Linux**: install Node 22, pnpm (`corepack enable`), PostgreSQL 16; then `./start-demo.sh` works the same as on macOS
  (`SKIP_BREW=1` is implied when there is no Homebrew; the `postgres` role must accept password `postgres`). Or use `./init.sh`
  (starts Postgres if needed, creates both databases, installs, migrates, seeds) followed by `pnpm dev`.
- **GitHub Codespaces**: create a codespace on this branch. `.devcontainer/` builds the image and runs PostgreSQL 16 as a
  sidecar at `localhost:5432`. Then `./init.sh`, `pnpm dev`, and open the forwarded port 5173 (Ports tab). The web app
  calls the api through its same-origin `/api` proxy. Run `node scripts/demo-session-now.mjs` for a session running now.
- **Docker** (nothing else installed):

```bash
docker compose up -d --build --wait   # postgres, api, worker, worker-documents, web (nginx) -> http://localhost:5173
API_URL=http://localhost:5173/api pnpm smoke
docker compose down -v                # stop and wipe
```

The api applies migrations and the demo seed on start. Use `localhost` in the browser (the production-mode api sets a `Secure`
cookie). If a port is taken, set `HQMS_PG_PORT`, `HQMS_API_PORT` or `HQMS_WEB_PORT`. Demo only: public password, fake adapters.

### What to try

- **Doctor availability**: in the doctor console, *Step away* (with an expected return), *I'm back*, and *Unavailable* (rest
  of the session). Waiting patients, booked patients who have not arrived and the assigned reception staff are notified, and
  the waiting-room display shows a banner. Reception can then move or reschedule the affected patients.
- **Notification centre**: the bell in the patient and staff apps lists in-app notices.
- **Notifications are fake**: no SMS or email is really sent. `NOTIFICATION_PROVIDER=fake` (default) only records each
  delivery; see **Admin → Notifications sent** (addresses masked). Real providers are not implemented yet.
- **Waiting-room display**: http://localhost:5173/display (no login).
- **Bookings leave time to arrive**: a slot is only offered if the patient has at least `MIN_ARRIVAL_WINDOW_MIN` (10)
  minutes before its late-grace window closes (D-035).

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
| `pnpm db:migrate` / `db:seed` / `db:reset` | migrations, demo seed, reset (refuses unless a test database, `NODE_ENV=development` or `--force`; the demo launchers set `NODE_ENV=development`) |
| `node scripts/demo-session-now.mjs` | ensure `doctor@hqms.test` has an open session now, at any hour (`node --test scripts/demo-session-now.test.mjs` tests its decision logic) |
| `pnpm depcruise` / `lint` / `typecheck` / `format:check` | the individual checks |

Config notes (every key is in `.env.example`; defaults use fake adapters): `NOTIFICATION_PROVIDER=fake|real` (real SMS/email
stubs need `SMS_API_KEY` / `EMAIL_API_KEY` and are not implemented), `NOTIFICATION_TIMEOUT_SEC=30`,
`MIN_ARRIVAL_WINDOW_MIN=10`. The `worker` role serves `call_timeout,reservation_release,deliver_notification` plus the outbox.

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
