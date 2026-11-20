# Evidence index

Maps each Phase 2 syllabus item to the file that evidences it. Rule from the project: **never present a target as a measured result.** A file is only marked `present` when it exists in the repository; `present` says nothing about whether the numbers in it meet a target. Files marked "generated" carry the date, commit and machine they were measured on and are refreshed by the command shown.

Status as of 2026-11-20 (session 3, code of commit `1697f3e`). "Final tree" means re-measured on that tree on 2026-11-20; "historical" means measured on the earlier tree on 2026-11-11 and not repeated. Per-file details and the earlier numbers (marked superseded where they differ) are inside each file.

| Evidence | Syllabus item | File | Status | How it is produced |
| --- | --- | --- | --- | --- |
| Static analysis (tsc strict, ESLint, dependency-cruiser, Semgrep) | Static code analysis | [static-analysis.md](static-analysis.md) | final tree (generated) | `pnpm evidence:static` |
| Unit tests with per-package counts | Build process and unit testing | [unit-tests.md](unit-tests.md) | final tree (generated); counts the 8 package suites (1,213 tests), not the 58 tests of `tests/integration` (see T3, T4, T6, authz) | `pnpm evidence:tests` |
| Coverage (v8) | Build process and unit testing | `coverage-summary.json` | final tree (generated, all 8 packages) | `pnpm coverage` |
| Simulation, FCFS vs policy (seeded) | Report evidence plan | [simulation-fcfs-vs-policy.md](simulation-fcfs-vs-policy.md), `simulation/` | final tree: re-run, `results.json` byte-identical | `pnpm --filter @hqms/tests simulate` |
| T1 Booking collision, reschedule rollback, bulk move/transfer races | Integration testing | [T1-booking-collision.md](T1-booking-collision.md), `.raw.json` | final tree (19 of 19 concurrency tests; session 3 section added) | `pnpm test:concurrency` |
| T2 Deterministic policy, doctor guard, pause race (D-032) | Integration testing | [T2-policy-doctor-guard.md](T2-policy-doctor-guard.md), `.raw.json` | final tree (session 3 section added) | `pnpm test:concurrency` |
| T3 SSE reconnect and freshness | System / interface testing | [T3-live-freshness.md](T3-live-freshness.md), `.raw.json`, `-200.raw.json` | 50-client check: final tree; 200-client run and ETA sample: historical (ETA calibration inconclusive) | `pnpm --filter @hqms/tests test` / `load:sse` |
| T4 Follow-up and instruction controls | System testing, security | [T4-followup-instruction-controls.md](T4-followup-instruction-controls.md), `.raw.json` | final tree (36 of 36) | `pnpm --filter @hqms/tests test` |
| T5 Workload and failure exercises | Performance testing | [T5-workload-failure.md](T5-workload-failure.md) and the `T5-*` raw and log files | **historical** (2026-11-11 tree; not re-run in session 3; NFR-04 method only, hosted RPO/RTO untested) | `pnpm --filter @hqms/tests load` / `failure` / `restore-drill` |
| T6 Audit trail, operations report, reproducibility | Usability testing, rollout | [T6-reproducibility-operations.md](T6-reproducibility-operations.md), `.raw.json` | parts A and B: final tree; `./init.sh`, `pnpm verify` timing and keyboard parts: historical | `pnpm --filter @hqms/tests test` |
| NFR-06 authorization suite | System testing, security | [authz-tests.md](authz-tests.md), `.raw.json` | final tree (640 checks, 0 unauthorized successes; scope is that suite, not a proof of NFR-06) | `pnpm --filter @hqms/tests test` |
| E2E, real stack: book, check in, call, start, complete (keyboard only) | System testing | [e2e-full-visit.md](e2e-full-visit.md), `.raw.json` | final tree (3 of 3 e2e specs, run twice, as reported by the orchestrator); does not include follow-up or return booking | `pnpm e2e` |
| E2E, real stack with worker: doctor away / back, unavailable, rebook, reception move, notifications | System testing | [e2e-availability.md](e2e-availability.md), `e2e-availability-away.raw.json`, `e2e-availability-unavailable.raw.json` | final tree (same two runs) | `pnpm e2e` |
| Dynamic analysis (runtime checks, load, failure injection) | Dynamic code analysis | [dynamic-analysis.md](dynamic-analysis.md) | historical (2026-11-11); its "not fixed" notes on F1/F2 predate the later fixes recorded in the T5 re-run | see file |
| UAT walkthroughs | User acceptance testing | [uat-checklist.md](uat-checklist.md) | checklist only, **not executed**, no result marked (section 7 added in session 3) | to be run by a tester |
| Screenshots (1440 px and 390 px; display 1920 px) | Usability testing | `screenshots/` ([README](screenshots/README.md)) | 306 PNG files: real-stack `e2e-01` to `e2e-14` and `e2e-20` to `e2e-44`; mock-backed `w0-*` to `w6-*` (`w5-*` 87 files and `w6-*` 79 files are new in session 3) | `pnpm e2e`, `pnpm --filter @hqms/web screenshots` |
| Requirement to code to test to evidence | Report evidence plan | [SUMMARY.md](SUMMARY.md) | generated 2026-11-11, amended by hand 2026-11-20 (session 3 addendum: what was re-measured, what was not) | `node scripts/evidence-summary.mjs` (rewrites the amendment) |

Related, outside this folder:

- Construction plan, configuration management, rollout plan (go/no-go checklist linking to this folder): `docs/construction/`.
- Operations: `docs/runbook.md` (backup and restore, RPO and RTO definitions, with the measured values to come from T5).
- Post-deploy smoke: `pnpm smoke` (`scripts/smoke.mjs`); a pass shows the stack is up, not that any requirement is met.
- Wave gate reports (code review): `docs/gates/`.
- Persona review of every portal and ten real-world scenarios, with the disposition of each finding (fixed, partly fixed or future work): [docs/review/persona-review.md](../review/persona-review.md). Final report of the build: [docs/review/final-report.md](../review/final-report.md) (being written by the orchestrator when this index was edited; the link may not resolve until it lands).
- CI workflow: `.github/workflows/ci.yml` (runs `pnpm verify`, `pnpm coverage` and the concurrency tests, uploads coverage, then build-smoke, compose-demo and Playwright jobs).

Refreshing the generated files: run `pnpm coverage && pnpm evidence:tests && pnpm evidence:static` with PostgreSQL up (`./init.sh`) and Semgrep installed. Run them on a clean working tree, otherwise the report says it was measured with uncommitted changes. The T-series `.raw.json` files are rewritten by the suites that measure them (`pnpm test:concurrency` for T1 and T2; `pnpm --filter @hqms/tests test` for T3, T4, T6 and authz); each Markdown file quotes its raw file, so re-run the suite and then re-read the numbers.


Also present: [SUMMARY.md](SUMMARY.md) (requirement → code → test → evidence), [e2e-full-visit.md](e2e-full-visit.md), [authz-tests.md](authz-tests.md), [simulation-fcfs-vs-policy.md](simulation-fcfs-vs-policy.md), [screenshots/README.md](screenshots/README.md) (mock-backed vs real-stack shots). Final state: [docs/gates/G4.md](../gates/G4.md).
