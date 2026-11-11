# Hospital Appointment & Queue Management System

BEA (BCS703B) course project, Phase 2, BMSIT ISE 2026-27. Team: Rohan Balu, Rishab Paul, Rahul Sonar, Rohan Bharat. Guide: Poornima G J.

The approved design is in `docs/spec/phase1-report.md`. This repo is being built by a Claude Code orchestrator (Opus) with Sonnet subagents; see `KICKOFF.md`, `CLAUDE.md` and `.claude/agents/`.

## Run state

- `PLAN.md`: waves, tasks and owners
- `PROGRESS.md`: running log (read this first)
- `feature_list.json`: every FR/NFR acceptance criterion and whether its test passes
- `DECISIONS.md`: choices made during the build
- `docs/gates/`: gate summaries per wave
- `docs/evidence/`: test, analysis and performance evidence for Phase 2

## Quick start (filled in during Wave 0)

```bash
./init.sh   # start Postgres, install, migrate, seed
pnpm dev    # api :3000, web :5173
```

Demo accounts use password `demo1234`. No API keys are needed: OCR, the assistant and login use local adapters by default.
