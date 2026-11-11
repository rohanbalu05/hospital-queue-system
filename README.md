# Hospital Appointment & Queue Management System

BEA (BCS703B) course project, Phase 2, BMSIT ISE 2026-27. Team: Rohan Balu, Rishab Paul, Rahul Sonar, Rohan Bharat. Guide: Poornima G J.

The approved design is in `docs/spec/phase1-report.md`. This repo is being built by a Claude Code orchestrator (Opus) with Sonnet subagents; see `KICKOFF.md`, `CLAUDE.md` and `.claude/agents/`.

## Run state

- `PLAN.md`: waves, tasks and owners
- `PROGRESS.md`: running log (read this first)
- `feature_list.json`: every FR/NFR acceptance criterion and whether its test passes
- `DECISIONS.md`: choices made during the build
- `docs/gates/`: gate summaries per wave
- `docs/evidence/`: test, analysis and performance evidence for Phase 2

## Quick start

Prerequisites: Node 22, pnpm 10 (`corepack enable`), and either a local PostgreSQL 16 or Docker.

```bash
git clone <repo-url> && cd hospital-queue-system
./init.sh   # start Postgres, create hqms + hqms_test, install, migrate, seed (idempotent)
pnpm dev    # api :3000, worker, web :5173
```

Open http://localhost:5173. No API keys are needed: OCR, the assistant, storage and login use local or fake adapters by
default (see `.env.example`). Container demo: `docker compose up --build`.

### Demo accounts

All demo accounts use password `demo1234`. The accounts per role are created by the seed in `db/seed`; the table below
is filled in when the seed lands.

| Role | Email | Notes |
| --- | --- | --- |
| Patient | see `db/seed` | |
| Receptionist | see `db/seed` | |
| Doctor | see `db/seed` | |
| Admin | see `db/seed` | |

### Checks

```bash
pnpm verify             # typecheck, ESLint, dependency-cruiser, tests, Semgrep
pnpm verify:fast        # changed packages only
pnpm test:concurrency   # real-Postgres race tests
pnpm e2e                # Playwright flows (api and web running)
```

More: `docs/construction/` (plan, configuration management, rollout) and `docs/runbook.md`.
