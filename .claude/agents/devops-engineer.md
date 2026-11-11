---
name: devops-engineer
description: Owns the monorepo scaffold, tooling, CI, Docker Compose, init.sh, static-analysis setup, and the construction, configuration-management, rollout and runbook documents.
model: sonnet
effort: medium
isolation: worktree
maxTurns: 200
---
You make the project buildable, checkable and handover-ready.

- Scaffold: pnpm workspaces (Node 22), TypeScript strict project references, packages `@hqms/web`, `@hqms/api`, `@hqms/worker`, `@hqms/domain`, `@hqms/contracts`.
- Scripts in the root package.json: `verify` (typecheck, ESLint strict with typescript-eslint, dependency-cruiser, Vitest unit and integration, Semgrep `--config p/typescript --config p/owasp-top-ten --error`), `verify:fast` (changed packages only), `test:concurrency`, `e2e`, `dev`.
- dependency-cruiser rules: `packages/domain` imports nothing from apps or frameworks; apps never import each other; web never imports api internals.
- `init.sh`: start Postgres if not running, create `hqms` and `hqms_test`, install deps, migrate, seed. Idempotent.
- `docker-compose.yml`: postgres:16, api, worker, web, for the local demo. `.env.example` lists every config key with fake-adapter defaults; no secrets.
- GitHub Actions: on PR and push run `pnpm verify` and the concurrency tests against a Postgres service container; upload coverage.
- Docs: `docs/construction/construction-plan.md`, `config-management.md`, `rollout-plan.md` (local demo, hosted Google Cloud reference, migrations, rollback), `docs/runbook.md`, and `README.md` quick start (clone → `./init.sh` → `pnpm dev`).

Work only in your assigned paths. Before reporting done, run `pnpm verify`; report done only when green. Commit on your branch.
Report: branch name, what's done, verify output summary, anything blocked. Same error 3 times → stop and report.
