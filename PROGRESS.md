# Progress log

Read this first on resume, then `git log --oneline -30`.

## 2026-11-11 — Session 1 start

- Read CLAUDE.md, phase1-report, phase2-syllabus, presentation Q&A, hospital-ui brief.
- Wrote PLAN.md, feature_list.json (50 criteria, all `passes:false`), DECISIONS.md (D-001..D-009).
- Current wave: **W0 Foundation**.
- Next: root scaffold, `packages/contracts`, `db/migrations/0001_init.sql`, then spawn devops / db / domain / ui builders.

## W0 merged (session 1)
- Merged: devops (tooling, CI, compose, init.sh, construction docs), domain (129 tests, 100% lines), web scaffold (26 tests, 12 screenshots), db (56 tests, seed, migration 0002).
- `./init.sh` runs green; `hqms` migrated + seeded.
- Open: db lint errors (100, non-null assertions) — sent back to db-engineer.
- Decisions: D-015..D-018.
- W1 started: api-engineer, worker-engineer, ui-engineer (D-018).
- wave-0 tag (local) = 3652f18
- W1: worker merged (44 tests: runner leases, call_timeout, reservation_release, outbox dispatcher, NFR-07 isolation). verify green, 260 tests.
- W1: api merged (48 tests: authz FR-01-a, scheduling FR-02..04 incl. 12-way HTTP last-place race, arrivals FR-05). verify green, 324 tests. feature_list 19/50.
- Simulation merged (FCFS vs policy, 4 scenarios × 500 seeded trials; policy worse for walk-ins/p95 — reported honestly).
- Running: ui (booking + reception), ui#2 (W2 doctor console/display/my-visit vs mocks), devops (coverage + evidence generators + UAT checklist), api W2 (call-next, consultation, SSE, snapshots, ETA), spec-reviewer + concurrency-security-reviewer on W0–W1.
- Next: T1 evidence (test-engineer) when a builder slot frees; fix reviewer P0/P1; Gate 1 doc.

## Session 1, after usage-limit pause
- Usage limit (5 h) interrupted 4 builders (api W2, ui W2, devops evidence, test T1); all resumed via SendMessage with their worktrees intact.
- W0–W1 reviews done: no P0 invariant breaks. Spec P0s were over-flipped criteria → FR-01-a, FR-04-c, FR-05-b set back to false (16/50). P1 fixes folded into the W2 api task (D-022). Hardening items queued for a db/worker fix pass.
- Contracts: `Eta.uncertainty` added.
- Merged: db/worker hardening (0004 migration, lock asserts), W2 web (doctor console, display, my visit; 53 unit + 62 Playwright). verify green 364 tests.
- Gate 1 met; wave-1 tag (local) = 027a758
- W2 api merged (89 api tests). db fixture fix merged. authz public-set expectation updated for the tokens-only display routes. verify green, 366 tests; concurrency 12/12. feature_list 26/50.
- ui-reviewer on W0–W2: P0 = reception lacks live lanes + absent/re-enter; P1 = patient text 14px, red/green misuse, paused copy, mid-animation screenshots. All forwarded to the W3 ui builder.
- Running: ui W3 (+ review fixes), worker W3 (providers, OCR, reconciler), test T2 + full-visit e2e, api W3 (follow-up, documents, verify, assistant, return booking, reports).
