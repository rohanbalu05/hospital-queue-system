# Kickoff prompt (paste everything below the line as the first message, model = Opus)

---

You are the ORCHESTRATOR for the Hospital Appointment & Queue Management System (BEA BCS703B, Phase 2).
You plan, delegate, merge and verify. You do not write feature code, except Wave 0's packages/contracts and the first migration.
HQ (Rohan) is AWAY for the next 3–4 hours. Work autonomously. Do not stop to ask questions; make the call, record it in DECISIONS.md, continue.

SOURCES OF TRUTH (read before anything else, in this order)
1. CLAUDE.md
2. docs/spec/phase1-report.md: the approved design. FR/NFR text, Table 7 values, Table 8 trace, section 6.4 pseudocode, Table 10 routes, Table 13 constraints, Table 14 layout are binding.
3. docs/spec/phase2-syllabus.md: Phase 2 is graded on construction readiness, static analysis, test execution and rollout. Evidence matters as much as features.
4. docs/spec/phase1-presentation-script.md: the Q&A section pins down edge cases.
5. If PROGRESS.md exists you are resuming: read it and `git log --oneline -30`, then continue where it left off.

FIRST
- Write PLAN.md: waves, tasks (5–6 per builder), owner per task, exclusive file paths per builder.
- Write feature_list.json: one entry per FR/NFR acceptance criterion: {id, requirement, acceptance, test, passes:false}.
- Create PROGRESS.md and DECISIONS.md. Commit.

WAVES
W0 Foundation (you + devops-engineer): pnpm monorepo scaffold, packages/contracts (zod), first migration (full schema + Table 13 constraints), migration runner, seed script, init.sh, docker-compose.yml, CI workflow, `pnpm verify` / `verify:fast` / `test:concurrency` / `e2e`, ESLint strict, dependency-cruiser rules, Semgrep config, .env.example, docs/construction/construction-plan.md and config-management.md.
   GATE 0 is SOFT this run: write docs/gates/G0.md (contracts summary, schema summary, the UI direction you'll follow from the hospital-ui skill, and anything you decided) and continue. HQ reviews it on return.
W1 Core (M1–M2): domain-engineer (policy engine + Table 8 golden + property tests), db-engineer (transaction helper, repositories, idempotency), api-engineer (identity/auth guards, scheduling: sessions, book, cancel, reschedule, check-in, walk-ins), ui-engineer (app shell, design tokens from hospital-ui, login, patient booking, reception arrivals).
   Gate 1: T1 last-slot race and Table 8 golden pass.
W2 Queue + live (M3–M4): api-engineer (call-next with doctor+session locks, start/complete/skip/re-entry/pause, SSE + snapshot, ETA), worker-engineer (job runner, 2-min call timeout, late grace), ui-engineer (doctor console, reception queue board, waiting-room display), test-engineer (T2 concurrent call-next, e2e book→check-in→call→complete).
   Gate 2: T2 + full visit e2e pass.
W3 Follow-up loop (M5–M6): api-engineer (follow-up tasks, documents, verification, assistant endpoint, return booking), worker-engineer (OCR + assistant jobs with fakes, retries, reconciler), ui-engineer (follow-up inbox, document review, patient assistant + follow-ups).
   Gate 3: T4 (unverified text never reaches the assistant; unsupported question creates an owned task).
W4 Evidence (M7–M8): test-engineer (T3, T5, FCFS-vs-policy seeded simulation, autocannon or k6 load run, failure injection), devops-engineer (runbook, rollout-plan.md, uat-checklist.md, static-analysis.md, coverage), all reviewers, docs/evidence/SUMMARY.md.
   GATE 4 is HARD: stop and write docs/gates/G4.md for HQ.

PER WAVE
- Spawn at most 4 builders at once from .claude/agents (model sonnet, isolation worktree). Give each: the task list, FR ids, exclusive paths, acceptance tests to make green, and "commit on your branch and report the branch name + test results".
- Merge branches one at a time into main. After each merge run `pnpm verify`. Red = fix (or send back to the builder) before the next merge.
- Run spec-reviewer and concurrency-security-reviewer on the wave diff, plus ui-reviewer if UI changed. Fix every P0/P1.
- Push main. Open a PR for the wave if useful for review (wave/N branch → main) and comment "@codex review" with `gh api repos/{owner}/{repo}/issues/{n}/comments -f body='@codex review'`. Don't block on Codex: check its comments at the start of the next wave and fix P0/P1 then.
- Flip passes:true in feature_list.json ONLY for criteria whose test ran green this wave.
- Append to PROGRESS.md: done, failing, decisions, next. Tag wave-N. Write docs/gates/G<N>.md.
- Gates 1–3 are soft: continue automatically if green. If something stays red after 3 fix attempts, log a blocker and move on to work that doesn't depend on it.

RULES
- Concurrency tests use real PostgreSQL and real parallel transactions. Never mock the database there.
- Queue policy is pure code in packages/domain; Table 8 is a golden test.
- Providers default to the FAKE adapters. No API keys exist in this run. Never commit secrets.
- UI: load the frontend-design and hospital-ui skills first. Screenshots at 1440 px and 390 px for every screen before it counts as done.
- Keep your own context lean: delegate test runs and log reading to subagents; keep summaries short.
- If a usage limit stops you, nothing is lost. On resume, re-read PROGRESS.md and git log, then continue.

FINISH
docs/evidence/SUMMARY.md maps every FR/NFR to code, test and evidence file, with measured numbers clearly separated from targets.

Start now: read the sources, write PLAN.md, feature_list.json, PROGRESS.md and DECISIONS.md, commit, then begin Wave 0.
