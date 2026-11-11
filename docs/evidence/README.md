# Evidence index

Maps each Phase 2 syllabus item to the file that evidences it. Rule from the project: **never present a target as a measured result.** A file is only marked `present` when it exists in the repository; `present` says nothing about whether the numbers in it meet a target. Files marked "generated" carry the date, commit and machine they were measured on and are refreshed by the command shown.

Status as of this index's last edit, Wave 4 (derived from the files in `docs/evidence/` at that time; update when files land). `T2` to `T6` and `dynamic-analysis.md` do not exist yet and are not evidence until they do:

| Evidence                                                          | Syllabus item                  | File                                          | Status                                                       | How it is produced                    |
| ----------------------------------------------------------------- | ------------------------------ | --------------------------------------------- | ------------------------------------------------------------ | ------------------------------------- |
| Static analysis (tsc strict, ESLint, dependency-cruiser, Semgrep) | Static code analysis           | `static-analysis.md`                          | present (generated)                                          | `pnpm evidence:static`                |
| Unit tests with per-package counts                                | Build process and unit testing | `unit-tests.md`                               | present (generated)                                          | `pnpm evidence:tests`                 |
| Coverage (v8)                                                     | Build process and unit testing | `coverage-summary.json`                       | present (generated; all packages with a Vitest suite)        | `pnpm coverage`                       |
| Simulation, FCFS vs policy (seeded)                               | Report evidence plan           | `simulation-fcfs-vs-policy.md`, `simulation/` | present                                                      | `pnpm --filter @hqms/tests simulate`  |
| T1 Booking collision and reschedule rollback                      | Integration testing            | `T1-booking-collision.md`, `.raw.json`        | present (measured run described inside the file)             | `pnpm test:concurrency` plus write-up |
| T2 Deterministic policy and doctor guard                          | Integration testing            | `T2-*.md`                                     | pending                                                      | `pnpm test:concurrency` plus write-up |
| T3 Snapshot and ETA behavior                                      | System / interface testing     | `T3-*.md`                                     | pending                                                      | to be written                         |
| T4 Follow-up and instruction controls                             | System testing, security       | `T4-*.md`                                     | pending                                                      | to be written                         |
| T5 Workload and failure exercises                                 | Performance testing            | `T5-*.md`                                     | pending                                                      | to be written                         |
| T6 Reproducibility and operational use                            | Usability testing, rollout     | `T6-*.md`                                     | pending                                                      | to be written                         |
| NFR-06 authorization suite                                        | System testing, security       | `authz-tests.md`, `authz-tests.raw.json`      | present (scope is that suite, not a proof of NFR-06)         | `pnpm test` (integration)             |
| Dynamic analysis (runtime checks, load, failure injection)        | Dynamic code analysis          | `dynamic-analysis.md`                         | pending                                                      | to be written                         |
| UAT walkthroughs                                                  | User acceptance testing        | `uat-checklist.md`                            | present (checklist only; **not executed**, no result marked) | to be run by a tester                 |
| Screenshots (1440 px and 390 px)                                  | Usability testing              | `screenshots/`                                | present (52 files now; completeness per screen is checked in the UI gate, not here)                         | `pnpm e2e`                            |

Related, outside this folder:

- Construction plan, configuration management, rollout plan (go/no-go checklist linking to this folder): `docs/construction/`.
- Operations: `docs/runbook.md` (backup and restore, RPO and RTO definitions, with the measured values to come from T5).
- Post-deploy smoke: `pnpm smoke` (`scripts/smoke.mjs`); a pass shows the stack is up, not that any requirement is met.
- Wave gate reports (code review): `docs/gates/`.
- CI workflow: `.github/workflows/ci.yml` (runs `pnpm verify`, `pnpm coverage` and the concurrency tests, uploads coverage, then build-smoke, compose-demo and Playwright jobs).

Refreshing the generated files: run `pnpm coverage && pnpm evidence:tests && pnpm evidence:static` with PostgreSQL up (`./init.sh`) and Semgrep installed.
