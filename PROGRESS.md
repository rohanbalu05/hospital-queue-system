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
- Gate 2 met; wave-2 tag (local) = 54600bb. W3 api + W4 devops merged; verify 554 tests; feature_list 43/50.
- W3 web merged (97 unit, 105 Playwright w/ mocks, all UI review fixes). verify: 1 flaky api probe (cluster-wide tx count during parallel load) → sent to api fix pass.
- Gate 3 met (T4); wave-3 tag (local) = 13ea11d. W3 web + T4/T6 merged.
- T4/T6 updated to D-028 semantics, merged. verify green: 695 tests (contracts 5, providers 79, domain 129, db 64, web 97, worker 78, api 169, tests 58+16). feature_list 45/50. Running: T5 (load/SSE/failure/restore), call-next order fix. Next: regenerate evidence (coverage/static/unit), SUMMARY.md, G4.md (HARD gate).

## Final state of session 1 — stopped at GATE 4 (HARD) for HQ
- Integration branch `claude/wonderful-galileo-2es87v`; local tags wave-0..wave-3, wave-4 at the G4 commit.
- feature_list 48/50 (NFR-04 not measurable; NFR-05 hosted not exercised). See docs/gates/G4.md and docs/evidence/SUMMARY.md.
- Last runs: `pnpm verify` green (725 tests), `pnpm test:concurrency` 17/17, `pnpm e2e` green ×2, evidence regenerated (coverage/static/unit).
- Late fixes: F1/F2 DB connection loss (D-027.. see T5 update), display cache staleness (D-030), two API test flakes.
- Next (HQ): review G4 + DECISIONS (start with D-001, D-002/023, D-025/028, D-026/028, D-029); PR to main + Codex review; run UAT checklist; second-teammate deploy; optional hosted T5.
- wave-4 tag (local) = 8ec1fef

## Session 2 — Gate 4 follow-up: Codex P1 fixes on PR #1
- Pulled HQ's .devcontainer commits (9173014, 911db0a).
- Codex P1s: (1) deny-list misses "Should I stop metformin?"; (2) duplicate walk-in for absent/skipped entries + reEnter coexisting with another live entry; (3) OCR writes not fenced against superseded attempts.
- Three builders running in parallel (providers, api, worker), each test-first.
- Codex P1 fixes merged (test-first): deny-list (3787d9a), duplicate admission + migration 0007 (bdacda5), OCR attempt fencing (f6fb3c9). verify 775 tests, concurrency 17/17, e2e green. D-031. Evidence T1/T4/T5 updated; reports regenerated.
- "@codex review" posted once on PR #1. docs/gates/G4-fixes.md written. STOPPED for HQ.
