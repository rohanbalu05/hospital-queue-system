# Rollout plan

Syllabus Module 5: rolling out an enterprise application. This is a plan. It is **not** a record of a hosted deployment, and
no rollout timing, availability or recovery figure in it is a measured result. Each such figure is a target; the measured
value comes from the evidence file named beside it (the T5 recovery and load exercises in `docs/evidence/`, pending).

Operational detail (start, stop, health, incidents, backup, restore, rollback commands) lives in `docs/runbook.md`.
Configuration keys live in `docs/construction/config-management.md` and `.env.example`.

## 1. Environments

| Environment | What it is | Data | Providers | Status in this build |
| --- | --- | --- | --- | --- |
| Local dev | `./init.sh`, then `pnpm dev` (api :3000, worker, web :5173) on a developer machine with PostgreSQL 16 | Demo seed | Fakes and local disk | Used daily; `pnpm verify` runs here and in CI |
| Compose demo | `docker compose up -d --build --wait`: postgres, api, worker, worker-documents, web (nginx) | Demo seed, applied by the api on start | Fakes and local disk (shared named volume) | Images built and the stack run in Wave 4 (section 2); this is the college demo environment |
| CI | GitHub Actions with a Postgres service container | Seed in a throwaway database | Fakes | Defined in `.github/workflows/ci.yml`; jobs: verify (with concurrency tests and coverage), build-smoke, compose-demo, e2e |
| Hosted Google Cloud reference | Report 6.12, Figure 10: Compute Engine host with api, worker and proxy containers; Cloud SQL for PostgreSQL 16; private Cloud Storage bucket; Identity Platform; Vision and Gemini adapters for the follow-up add-on. Preferred region Mumbai, subject to availability | Real data only, never the demo seed | Real adapters selected by configuration | **Not deployed in this build.** Described so it can be costed, load-tested and recovered (report Table 16); sizing (about 4 vCPU/8 GB application host, 2 vCPU/4 GB database, 20 GB) is a starting point for measurement, not verified capacity. A single application host is a failure point; provider processing locations must be verified separately from the database region |

## 2. Docker images (what was and was not done here)

The three Dockerfiles in `infra/docker/` build the api (tsup bundle), the worker (esbuild bundle; the same image runs as both
`worker` and `worker-documents`, the role set by `WORKER_JOB_TYPES`) and the web app (Vite build served by nginx). Images
run as the unprivileged `node` user, carry healthchecks, and start the bundles with `node dist/main.js`.

Verified in Wave 4, on a Docker 29 daemon started in the build sandbox: all three images built, `docker compose up` brought
all five services to `healthy`, the api migrated and seeded a blank volume on start, `pnpm smoke` passed 9/9 through the nginx
proxy, the SSE endpoint streamed through nginx, and the storage volume was writable from the api and visible to the document
worker. One sandbox-only difference: the sandbox's TLS-intercepting proxy required injecting its CA certificate into the build
stage so `corepack` could fetch pnpm; the committed Dockerfiles do not contain that and need ordinary internet access to the
npm registry when building. Image size is about 820 MB for api and worker because the runtime stage keeps the full workspace
with its dependencies; slimming it (production-only install) is a hosted-release task, not done here. The compose-demo CI job
repeats the build and smoke on a clean runner, so its result, not this paragraph, is the standing check.

## 3. Release process

Applies to the hosted reference and, with the compose steps, to the demo.

1. **Tag.** Tag `vMAJOR.MINOR.PATCH` on the release commit on `main` (config-management section 3). Record the highest
   `db/migrations` file the release expects.
2. **CI verify.** `pnpm verify` (typecheck, ESLint, dependency-cruiser, unit and integration tests, Semgrep), the concurrency
   tests T1 and T2 against real PostgreSQL, coverage, and the build-smoke and compose-demo jobs are green. A red job blocks
   the release; `e2e` is `continue-on-error` in CI (browser availability), so a human checks the Playwright run and
   screenshots before release.
3. **Build images.** Build api, worker and web images, tag with version and git SHA (hosted: push to Artifact Registry).
4. **Back up.** Cloud SQL backup, or confirm point-in-time recovery is enabled, before touching the schema (runbook 7).
5. **Migrate.** Apply migrations with the runner (`pnpm db:migrate`, or the api's `RUN_MIGRATIONS_ON_START` in the demo only)
   from the release image or a bastion. Forward-only, one transaction per file, checksummed. Hosted environments run the
   runner as an explicit step, not on api start.
6. **Deploy.** Worker first, then api, then web. Secrets come from protected runtime configuration (Secret Manager), never
   from the image or the repository.
7. **Smoke.** `GET /health`; log in with a real non-patient account; open a session queue; receive an SSE event; worker job age
   near zero (runbook 6.1). `pnpm smoke` is for the demo seed only and must not run against real data.
8. **Record.** Version, git SHA, migration version, time and who ran it, in the change log.
9. **Not during a live clinic session.** Staff keep the manual paper fallback for the queue through a release window.

## 4. Data migration and seed policy

- Schema and data changes are forward-only numbered SQL in `db/migrations`; applied files are never edited.
- Expand then contract: add nullable columns or new tables, deploy code that writes both, backfill, switch reads, drop old
  structures in a later release. Long backfills run as batched worker jobs, not inside a migration.
- **The demo seed never runs in production.** It creates 22 staff accounts with a public password. The seed refuses to run
  with `NODE_ENV=production` unless `ALLOW_DEMO_SEED=true` (D-022), and only the compose demo sets that flag. A hosted
  environment must not set `ALLOW_DEMO_SEED`, `SEED_ON_START` or `RUN_MIGRATIONS_ON_START`; its first users are created
  through the identity provider and admin tooling. The seed guard is covered by a database-package test, but a release
  checklist item (section 9) checks the variables too.
- A restore replaces data; reconcile afterwards (runbook 7.3).

## 5. Provider feature flags (fake to real)

Providers are chosen by environment variables; the fake or local adapter is always the default, so the application builds,
runs and is demonstrated without keys. Moving to a real provider is a configuration change per environment, one adapter at
a time, never all together.

| Port | Default | Real option | Flag | Extra configuration (secrets via runtime config only) |
| --- | --- | --- | --- | --- |
| `IdentityProvider` | `local` | `identity-platform` | `IDENTITY_PROVIDER` | `IDENTITY_PLATFORM_API_KEY`, `COOKIE_SECURE=true` |
| `ObjectStorage` | `local-disk` | `gcs` | `OBJECT_STORAGE` | `GCS_BUCKET`, `GOOGLE_CLOUD_PROJECT`, workload credentials |
| `OcrProvider` | `fake` | `google-vision` | `OCR_PROVIDER` | `OCR_TIMEOUT_SEC` |
| `LlmProvider` | `fake` | `gemini` | `LLM_PROVIDER`, `LLM_MODEL` | `GEMINI_API_KEY` |

The real adapters are stubs in this build ("adapter not implemented in this build", or the missing key named when it is
unset): selecting one never silently falls back to the fake, every call fails with a provider error, and an OCR document goes
`ocr_failed` with a permanent error. Completing the adapter is a prerequisite of the flag change. Switching a flag is a
release: smoke, then watch `ocr_failed` counts and job retries (runbook 6.2, 6.3). Rollback of a flag is the previous
value. Both OCR and the assistant fail without affecting booking or queue use (NFR-07). Verify processing locations and
the model's current availability before enabling a real provider (report 6.12 and Table 15); provider spend is not measured.

## 6. Phased rollout (hospital pilot, outside the course)

Not part of Phase 2 and requires separate approval. The plan:

| Phase | Scope | Entry | Exit |
| --- | --- | --- | --- |
| 0 UAT | Course reviewers and a hospital liaison walk the checklist on the compose demo | Go/no-go checklist (section 9) green | UAT checklist executed and signed (section 8) |
| 1 Pilot | One department, its doctors and reception, real sessions, paper fallback kept | Hosted environment provisioned with real providers off or on per section 5; recovery drill run | A defined period with no capacity or allocation integrity failure, no unauthorized-read report, and staff feedback reviewed; the figures are recorded, not assumed |
| 2 Expand | Remaining departments, one at a time | Phase 1 exit met; capacity and job-age observations reviewed | Same signals per department |
| 3 Follow-up add-on | Enable real OCR and the assistant for a clinician group | Provider processing locations verified, review workload measured | Verification inbox kept up with; escalations owned |

Progression is by evidence, not by calendar. A phase can pause or revert at any point.

## 7. Rollback

Rolling back application code does not roll back the database (report 6.13).

| Situation | Action |
| --- | --- |
| Bad application release, schema compatible | Redeploy the previous image tag; no database action |
| Bad application release, new schema is additive | Redeploy the previous image; leave the additive schema in place |
| Release contained a contract (destructive) migration | Not rollback-safe by design; restore from backup or fix forward. Avoid by separating contract steps into a later release |
| Migration failed | The file ran in one transaction, so nothing partial applied; fix forward with a new numbered file |
| Bad provider flag | Set the flag back to the previous value (fake); redeploy configuration |
| Data damaged | Point-in-time recovery to a restored instance, then reconcile jobs and refresh client snapshots before staff resume calls (runbook 7.3) |
| Compose demo | `docker compose down -v` and start again |

After any rollback: smoke, the runbook job queries, reload client snapshots, then resume calling. The measured recovery
point and recovery time come from the T5 drill; the targets (RPO at most 15 minutes, RTO at most 60 minutes, NFR-05) are not
results.

## 8. UAT sign-off gate

No pilot starts until `docs/evidence/uat-checklist.md` has been executed by a person against the running demo, every row has
a result, failures are resolved or accepted in writing, and the commit under test, tester, date and sign-off fields are
filled in. As of this edit the checklist is **not executed**; nothing in it is marked passed.

## 9. Go / no-go checklist

A release or pilot step goes only when every item is yes. Links are to the evidence that answers each; a file marked pending
cannot answer yes. Status is as of the last edit of this file; `docs/evidence/README.md` is the live index.

| # | Check | Evidence | Status now |
| --- | --- | --- | --- |
| 1 | `pnpm verify` green on the release commit; build-smoke and compose-demo jobs green | CI run; `docs/evidence/static-analysis.md`, `docs/evidence/unit-tests.md` | generated files present; CI result per release |
| 2 | Booking collision and reschedule rollback hold (NFR-03) | `docs/evidence/T1-booking-collision.md` | present |
| 3 | Deterministic policy and single doctor allocation hold under parallel calls | T2 write-up (`docs/evidence/T2-*.md`) | pending |
| 4 | Snapshot and ETA behaviour | `T3-*.md` | pending |
| 5 | Follow-up and instruction controls (unverified text never reaches the assistant) | `T4-*.md` | pending |
| 6 | No cross-patient access in the authorization suite (NFR-06) | `docs/evidence/authz-tests.md` | present; scope is that suite, not a proof |
| 7 | Workload and failure exercises run; RPO and RTO measured against targets | `T5-*.md` | pending |
| 8 | Audit trail and keyboard walkthrough (FR-15, NFR-08) | `T6-*.md`, `docs/evidence/screenshots/` | pending |
| 9 | Coverage reported and read | `docs/evidence/coverage-summary.json` | present (generated) |
| 10 | Policy comparison FCFS vs policy, seeded | `docs/evidence/simulation-fcfs-vs-policy.md` | present |
| 11 | UAT executed and signed | `docs/evidence/uat-checklist.md` | **not executed** |
| 12 | Restore drill run once and timed; reconciliation steps followed | runbook 7.3, `T5-*.md` | commands exercised once on the demo stack; drill with timings pending |
| 13 | Production configuration reviewed: no `ALLOW_DEMO_SEED`, `SEED_ON_START`, `RUN_MIGRATIONS_ON_START`; no demo accounts; `COOKIE_SECURE=true`; secrets from runtime config; provider flags as intended | `.env.example`, config-management | checked per release |
| 14 | Backup or PITR confirmed before migrating; previous image tag available | cloud console record | per release |
| 15 | Paper fallback ready; no live clinic session during the window | clinic schedule | per release |

Any "pending" or "not executed" row means the answer is no-go for a pilot. The course demo (compose stack, fake adapters) may
proceed with those rows stated openly as pending.

## 10. Communication

Tell staff the release window, what changes, and who to call. Keep the paper fallback until the pilot exit is met. Report
incidents with the correlation id (runbook 4), not with patient details.
