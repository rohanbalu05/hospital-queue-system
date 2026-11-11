# Construction plan

Phase 2 construction readiness for HQMS (syllabus Module 4). Derived from `PLAN.md`; the design source is
`docs/spec/phase1-report.md` (Table 14 repository boundaries). This document describes the process and structure;
it makes no claims about measured results (see `docs/evidence/` for those, when produced).

## 1. Team and roles

| Role | Who | Responsibility |
| --- | --- | --- |
| Orchestrator | Claude Code main session (Opus) | Plans, delegates, merges, runs `pnpm verify`, keeps `PLAN.md`, `PROGRESS.md`, `DECISIONS.md`, `feature_list.json` |
| Builders | Claude Code subagents (Sonnet, one git worktree each, max 4 at once) | One owner per path; commit on a worktree branch |
| Reviewers | `spec-reviewer`, `concurrency-security-reviewer`, `ui-reviewer` subagents | One review pass per wave, reports in `docs/gates/` |
| Humans | Team and guide | Review the integration branch, PR to `main`, Codex PR review |

## 2. Waves, owners and exit gates

| Wave | Scope | Builders | Gate |
| --- | --- | --- | --- |
| W0 Foundation | Root tooling, contracts, schema, DB helper, domain policy, web scaffold | devops, db, domain, ui | `pnpm verify` green |
| W1 Core | Identity, scheduling, booking, reception desk | api (x2), ui, test | T1 booking collision + Table 8 golden |
| W2 Queue and live | call-next, SSE, snapshot recovery, worker timers | api, worker, ui, test | T2 concurrent call-next + full visit e2e |
| W3 Follow-up loop | Documents, OCR draft, verification, assistant, tasks, return booking | api, worker, ui, test | T4 safety and authorization |
| W4 Evidence | T3, T5, T6, simulation, coverage, runbook, rollout, UAT, static and dynamic analysis | test, devops, reviewers | Evidence summary, HARD gate |

Per-wave routine: merge builder branches one at a time, `pnpm verify`, reviewers, fix P0/P1 findings, flip
`feature_list.json` `passes` only for criteria that ran green in that session, update `PROGRESS.md`, tag `wave-N`,
write `docs/gates/G<N>.md`.

## 3. Package structure (report Table 14 mapped to the repository)

| Report boundary | Repository path | Package | Notes |
| --- | --- | --- | --- |
| Web client | `apps/web` | `@hqms/web` | React, TypeScript, Vite, Tailwind, shadcn/ui, TanStack Query |
| API | `apps/api` | `@hqms/api` | NestJS modular monolith, raw SQL via `@hqms/db` |
| Worker | `apps/worker` | `@hqms/worker` | Postgres jobs and outbox, `FOR UPDATE SKIP LOCKED` leases |
| Domain | `packages/domain` | `@hqms/domain` | Pure TypeScript: queue policy, state machines, EWMA/ETA |
| Contracts | `packages/contracts` | `@hqms/contracts` | zod schemas for requests, responses, events |
| Persistence (added, D-002) | `packages/db` | `@hqms/db` | Pool, `withTransaction`, lock-order helpers, idempotency, audit/outbox/job writers, migration runner, seed |
| Migrations and seed | `db/migrations`, `db/seed` | n/a | Plain numbered SQL |
| Tests | `tests` | `@hqms/tests` | Black-box integration, concurrency (T1, T2), Playwright e2e |
| Infra and docs | `infra`, `docs`, `docker-compose.yml`, `.github` | n/a | Containers, CI, runbooks |

Internal packages ship TypeScript source and have no build step (D-010). Apps need `build` and `start` scripts:
`apps/web` emits `apps/web/dist` (served by nginx); `apps/api` and `apps/worker` bundle to a runnable output. The
Dockerfiles in `infra/docker/` assume exactly `pnpm --filter @hqms/<app> build` and `pnpm --filter @hqms/<app> start`.

### Dependency rules (enforced by dependency-cruiser, `.dependency-cruiser.cjs`)

| Rule | Meaning |
| --- | --- |
| `domain-src-is-pure` | `packages/domain/src` imports only itself: no node builtins, npm packages or other workspaces |
| `domain-tests-stay-in-domain` | Domain tests may use vitest/fast-check but no other workspace |
| `apps-never-import-each-other` | No app imports another app |
| `web-imports-only-contracts` | `apps/web` never imports api, worker, db or domain |
| `packages-never-import-apps` | Libraries never import `apps/*` |
| `contracts-is-a-leaf`, `db-no-domain` | contracts depends on no workspace package; db may use contracts only |
| `no-circular` | No circular dependencies |

## 4. Build process

Single entry point for checks is `pnpm verify`, which fails fast in this order:

1. `pnpm typecheck`: `tsc --noEmit` per package with `strict` and `noUncheckedIndexedAccess` (`tsconfig.base.json`).
2. `pnpm lint`: ESLint flat config, typescript-eslint `strict`, `--max-warnings 0`. Prettier (`printWidth` 120, single
   quotes) is available as `pnpm format:check` / `pnpm format`; it is advisory and not part of `pnpm verify`.
3. `pnpm depcruise`: dependency rules above.
4. `pnpm test`: Vitest unit and integration tests in every package (real PostgreSQL via `TEST_DATABASE_URL`).
5. `pnpm semgrep`: `--config p/typescript --config p/owasp-top-ten --error --metrics=off`.

Other commands: `pnpm verify:fast` (typecheck and tests for packages changed against `HQMS_BASE_REF`, default
`origin/claude/wonderful-galileo-2es87v`), `pnpm test:concurrency` (T1/T2 races on real parallel connections),
`pnpm e2e` (Playwright), `pnpm db:migrate|seed|reset`, `pnpm dev`.

CI (`.github/workflows/ci.yml`) runs `pnpm verify` and `pnpm test:concurrency` on every push and pull request against
a `postgres:16` service container, and uploads coverage artifacts when present.

Construction rules that carry marks (from `CLAUDE.md`): every state-changing command is one short transaction with lock
order doctor, session, capacity guard; idempotency records keyed by (actor, operation, key) with request hash; Table 13
constraints; deterministic queue policy; server-side authorization on every route.

## 5. Code review process

1. Builder self-check: `pnpm verify` green before reporting done; commits are small and conventional.
2. Orchestrator review on merge: one branch at a time, lockfile conflicts regenerated (D-008), `pnpm verify` re-run.
3. Reviewer agents once per wave: spec conformance (FR/NFR, Tables 7, 8, 10, 13), concurrency and security, UI
   (screenshots at 1440 px and 390 px). Findings are P0/P1/P2; P0 and P1 are fixed before the gate.
4. Pull request from the integration branch to `main`, reviewed by the team and by Codex PR review. Reviewer reports
   are kept in `docs/gates/`.
