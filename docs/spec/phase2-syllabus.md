# BCS703B Building Enterprise Applications: what Phase 2 is graded on

Source: BMSIT VII Semester Revised Scheme & Syllabus (2022 scheme, effective AY 2026-27), pages 19–20. Transcribed from a scanned PDF.

## Continuous Course Assessment (CCA): course project

"The Enterprise Application Lifecycle: A Comprehensive Project Plan from Architectural Design to Final Deployment" (experiential learning).

- **Phase 1: Inception, Requirements & Multi-Tier Architecture Design (PPT presentation).** Project inception, feasibility estimation, SRS formulation, and logical, technical, data and infrastructure multi-tier blueprints. *Done: see `phase1-report.md`.*
- **Phase 2: Construction Readiness, Testing Frameworks & Implementation.** Bridges the multi-tier architectural specifications directly into code construction readiness, static code quality analysis, test suite execution, and rollout strategies.

## Syllabus modules Phase 2 draws on

**Module 4: Constructing an enterprise application.** Construction readiness: defining a construction plan, defining a package structure, setting up a configuration management plan, setting up a development environment. Software construction maps, construction of solution layers, code review, static code analysis, build process and unit testing, dynamic code analysis.

**Module 5: Testing and rolling out an enterprise application.** Types and methods of testing, testing levels and approaches, testing environments, integration testing. System testing: performance testing, penetration testing, usability testing, globalization testing and interface testing. User acceptance testing. Rolling out an enterprise application.

## Course outcome 4

Analyze the construction and testing processes of enterprise applications, including development readiness, code quality practices, testing methods, and rollout strategies.

## What this means for the build

The Phase 2 panel will look for evidence of each of the following, not only working code:

| Syllabus item | Evidence file the build must produce |
| --- | --- |
| Construction plan, package structure | `docs/construction/construction-plan.md` (waves, owners, package map, dependency rules) |
| Configuration management plan | `docs/construction/config-management.md` (branching, versioning, migrations, env config, secrets) |
| Development environment | `README.md` quick start + `init.sh` + `docker-compose.yml` |
| Code review | Reviewer reports per wave in `docs/gates/`, Codex PR reviews |
| Static code analysis | `docs/evidence/static-analysis.md` (ESLint, TypeScript strict, Semgrep, dependency-cruiser results) |
| Build process and unit testing | CI workflow + `docs/evidence/unit-tests.md` with coverage |
| Dynamic code analysis | `docs/evidence/dynamic-analysis.md` (runtime checks, load and failure-injection results) |
| Integration, system, performance, penetration, usability, interface testing | `docs/evidence/T1..T6-*.md` per the report's traceability table, plus a basic security test pass |
| User acceptance testing | `docs/evidence/uat-checklist.md` (role-by-role scripted walkthroughs) |
| Rollout strategy | `docs/construction/rollout-plan.md` (local demo, hosted reference, data migration, rollback) |
