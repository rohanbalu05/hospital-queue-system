# Gate 4 fixes — Codex P1 findings on PR #1

Session 2, 2026-11-11. HQ reviewed Gate 4 and asked for the three Codex P1 findings on PR #1 to be fixed test-first. Status: **done; stopped here for HQ.**

Branch: `claude/wonderful-galileo-2es87v`. HQ's `.devcontainer/` and demo-launcher commits were pulled before the work started and merged again mid-way (no overlap with the fixed files). "@codex review" was posted once on PR #1 after the fixes were pushed: <https://github.com/rohanbalu05/hospital-queue-system/pull/1#issuecomment-6803879981>.

## The three findings

| # | Finding (Codex) | Failing test first | Fix | After |
| --- | --- | --- | --- | --- |
| 1 | Assistant deny-list missed treatment-change questions that name the medicine ("Should I stop metformin?" was answered and cited from a verified instruction instead of reaching staff) | `38429b5`: providers 23 failed / 82 passed; `apps/api/test/assistant-denylist.int.test.ts` 2 failed (`expected 'answered' to be 'escalated'`) | `3787d9a`: modal / approval / "I want to" frames with stop- and dose-verbs, frequency-change and "still need to take" patterns in `packages/providers/src/llm.ts`; matched on the question only | providers 105/105; 22 direct-name questions refused before any provider call and escalated to an owned task; 32 benign questions still answered |
| 2 | Duplicate walk-in admission for absent/skipped entries with open visits, and re-entry could coexist with another live entry (two consultations for one patient in one session) | `65661f7`: `apps/api/test/duplicate-admission.int.test.ts` 6 of 11 failed (second walk-in 201, re-entry 200, 1 of 10 parallel admissions succeeded, duplicate open visit accepted) | `bdacda5`: `hasLivePlace` counts parked entries with open visits; `reEnter` refuses beside another live / parked-open place; migration 0007 unique index `visits (session_id, patient_id) WHERE status IN ('open','in_service')`, mapped to 409 | 11/11; API 187/187; 10 parallel admissions for a parked patient → 0 successes; legitimate second visit after completion still allowed |
| 3 | OCR document writes not fenced against superseded job attempts after lease loss (late failure of the old attempt left the document `ocr_failed` with zero drafts) | `a64a722`: `apps/worker/test/documents-fencing.int.test.ts` 5 of 9 failed | `f6fb3c9`: every OCR transaction verifies the job row (`running`, `lease_owner`, `attempts`, `FOR NO KEY UPDATE`, job before document); superseded attempts write nothing and record no job outcome | 9/9; worker 88/88; every interleaving ends `ocr_ready` with exactly one draft |

## Verification on the final tree (`daf6d4e`)

- `pnpm verify` green after each merge, one at a time: final run 775 tests (contracts 5, providers 105, domain 129, db 83, web 104, worker 88, api 187, black-box integration 58, simulation 16); ESLint 0 errors / 0 warnings (364 files), dependency-cruiser 0 violations, Semgrep 0 findings.
- `pnpm test:concurrency` 17/17 (T1 + T2).
- `pnpm e2e` (real stack, keyboard-only full visit) green.
- Coverage, unit-test and static-analysis reports regenerated (`docs/evidence/unit-tests.md`, `static-analysis.md`, `coverage-summary.json`): api 97.4%, providers 97.2%, db 87.8%, worker 83.8% lines.

## Behaviour changes (DECISIONS.md D-031)

1. Some ambiguous questions now escalate instead of being answered (e.g. "Can I lower my fever?"), which is the safe direction. Known gap: "Should I take X only when I have pain?" is not caught.
2. A patient with a skipped/absent entry and an open visit cannot be admitted again in that session (409). Re-entry is refused while another place exists. The database now allows at most one open visit per patient per session.
3. A superseded OCR attempt is silently fenced out (`ocr.superseded` log line); the runner writes no outcome for it.

## Evidence updated

- `docs/evidence/T4-followup-instruction-controls.md`: deny-list update section.
- `docs/evidence/T1-booking-collision.md`: duplicate-admission update section.
- `docs/evidence/T5-workload-failure.md`: OCR fencing update section.
- `feature_list.json`: FR-05-a, FR-14-b, NFR-03 and NFR-07 now reference the new tests. Still 48/50 (NFR-04 and NFR-05 unchanged).
- `docs/evidence/SUMMARY.md`: regenerated.

## Process notes

- Test-database isolation: the db suite was the last with a fixed scratch DB name, and a parallel builder run dropped it mid-verify (27 false failures). It now honours `DB_TEST_DB_NAME`, which completes D-027.
- One push was rejected because HQ had pushed new commits; the command chain stopped, so that verify ran on fix 1 only. Fix 2 was then merged and verified on its own before fix 3.
- The fixes were made by builder subagents in separate worktrees (providers, api, worker), each limited to its own paths. The orchestrator merged and verified them, and wrote the docs and the test-harness override.

## For HQ

- Wait for Codex's re-review on PR #1. Any new P0/P1 would start the next fix pass.
- The previous G4 next steps still stand: run the UAT checklist, have a second teammate deploy from a clean machine, and optionally run a hosted T5.
