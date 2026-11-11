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
