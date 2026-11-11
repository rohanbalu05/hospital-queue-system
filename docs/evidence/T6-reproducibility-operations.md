# T6: reproducibility and operational use

Evidence for report section 5.6, Table 5, row T6 (FR-15, NFR-08): audit trail, repeatable setup, keyboard walkthrough
and release record. Everything marked **measured** comes from the runs described here on the machine named here. Targets
(RPO, RTO, latency, availability) appear only where the operations report lists them as targets, and are never presented
as achieved.

## Changed since the previous run (D-028)

Parts A, B and the release record were re-run against the API after the W2-W3 review fix pass (code `d772596`). Parts C1
to C3 (`./init.sh`, `pnpm verify`, keyboard walkthrough) were **not** re-run for this update; they are kept as measured on
the earlier tree (`496bcdf`) and labelled so below.

| What changed in the API (D-028)                                                    | Effect on this suite                                                                                                                                                                  |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A doctor-created follow-up task without `ownerId` gets a **default owner**         | the visit's task is owned by a follow-up user assigned to the doctor; the suite reads the owner from the task and performs acknowledge, return booking and resolve **as that owner**  |
| Resolve and cancel need the owner (acknowledge by a non-owner was already refused) | a second follow-up user's acknowledge attempt gets `403` and leaves **no audit row**; the audit of the task is still exactly create, acknowledge, return_booking, resolve             |
| `audit_events` is **append-only** (migration 0006)                                 | the previous run recorded "0 triggers" as an observation; the suite now **asserts** that UPDATE and DELETE of an audit row fail and the row is unchanged (see Part A and Limitations) |
| Operations report measured rows read the whole scratch database                    | the T4 suites now run before T6 in the same folder, so the measured follow-up and assistant rows show larger samples (Part B); they are still not hospital figures                    |

No safety assertion was weakened. The audit reconstruction asserts the same actors, the same 18 rows and the same
policy-version checks as before, plus the default owner (`follow_up.create` row's `next.ownerId` equals the owner who
then acknowledges, books the return and resolves).

## Purpose

1. Show that one complete visit can be **reconstructed from `GET /audit` alone**: every material change has actor, time,
   entity and operation; every queue operation carries the policy version; a priority override shows the doctor, the
   reason and the policy version (FR-15-a).
2. Show that `GET /reports/operations` separates Phase 1 **targets** from **measured** rows (FR-15-b).
3. Document and time repeatable setup (`./init.sh`, second run idempotent) and the full gate (`pnpm verify`), link the
   keyboard walkthrough evidence (NFR-08-b), and record what was released: commit, migrations applied, policy version.

## Environment (this machine; not the hosted environment)

| Item     | Value                                                                                                                                                                                                |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host     | cloud sandbox VM, Linux 6.18.44 (Ubuntu 24.04.5), 4 vCPU (Intel Xeon @ 2.10 GHz), 15 GB RAM, **shared with other agents' builds and test runs** (all durations below are inflated and noisy by that) |
| Node.js  | v22.23.4, pnpm 10.28.0, PostgreSQL 16.15 on `localhost:5432` (default configuration)                                                                                                                 |
| Database | `hqms_test_blackbox_t4b` for the audit suite (recreated every run, 6 migrations, demo seed); `hqms` (shared dev database) for `./init.sh`; `hqms_e2e_t6_test` for the e2e run                        |
| System   | `apps/api/dist/main.js` child process (the suite builds it), `NODE_ENV=test`                                                                                                                         |
| Code     | Parts A, B, C4: `d772596` (`claude/wonderful-galileo-2es87v`, includes the W2-W3 review fix pass) plus this task's `tests/` changes. Parts C1 to C3: `496bcdf` (earlier run, see above)              |
| Date     | 2026-11-11                                                                                                                                                                                           |

## Part A: audit-trail reconstruction (FR-15-a)

### Method

`tests/integration/t6-audit-trail.test.ts` (10 tests). Real HTTP, real PostgreSQL, no worker. Dr. Mohammed Irfan (ENT,
`doctor6@`), `patient7@`, `reception@`, `followup@`, `admin@`. The visit, in this order:

1. admin creates a running session (started 12 minutes ago) and a future return session;
2. the patient books (`POST /appointments`); reception checks the patient in;
3. reception admits a walk-in; **the doctor sets clinical priority 1** on the walk-in with the reason "Chest pain on
   arrival";
4. the doctor calls next (the priority walk-in), starts, completes; calls next again (the booked patient), starts, completes;
5. the doctor creates a follow-up task for the visit **without naming an owner** (D-028: it gets a default owner, a
   follow-up user assigned to this doctor); **that owner** acknowledges it, books the return appointment from it and
   resolves it `return_booked`. A different follow-up user's attempt to acknowledge it is refused (`403`).

Then the **reviewer's view is rebuilt only from `GET /audit?from=<test start>&limit=500` as admin**, filtered to the
entities of this visit, and asserted. Reception attempting the same override is refused (`403`) and writes no override row.

### Results (measured; identical in 3 consecutive runs)

10 of 10 tests passed in each of 3 consecutive runs (as part of the whole `tests/integration` folder, 58 tests green each
time; the file alone takes about 0.7 s); no 5xx; whole-database invariant violations: 0. `pnpm verify` was not re-run for
this update.

The audit trail of the visit (18 rows, oldest first; `actor` = the audit row's `actorRole`, every human row also had a
non-null `actorId` equal to the user who made the call):

| #   | Operation                   | Actor     | Entity type      | Policy version | Reason recorded                                  |
| --- | --------------------------- | --------- | ---------------- | -------------: | ------------------------------------------------ |
| 1-2 | `session.create` (x2)       | admin     | `session`        |              - |                                                  |
| 3   | `appointment.book`          | patient   | `appointment`    |              1 |                                                  |
| 4   | `visit.check_in`            | reception | `visit`          |              1 |                                                  |
| 5   | `visit.walk_in`             | reception | `visit`          |              1 |                                                  |
| 6   | **`queue.priority`**        | doctor    | `queue_entry`    |              1 | **"Chest pain on arrival"**                      |
| 7   | `session.open`              | doctor    | `session`        |              1 | "Opened by the first call"                       |
| 8   | `queue.call_next`           | doctor    | `queue_entry`    |              1 | "Clinical priority (class 1)"                    |
| 9   | `consultation.start`        | doctor    | `visit`          |              1 |                                                  |
| 10  | `consultation.complete`     | doctor    | `visit`          |              1 |                                                  |
| 11  | `queue.call_next`           | doctor    | `queue_entry`    |              1 | "Called by rotation: 1st appointment of A, A, W" |
| 12  | `consultation.start`        | doctor    | `visit`          |              1 |                                                  |
| 13  | `consultation.complete`     | doctor    | `visit`          |              1 |                                                  |
| 14  | `follow_up.create`          | doctor    | `follow_up_task` |              - | (default owner recorded in `next.ownerId`)       |
| 15  | `follow_up.acknowledge`     | followup  | `follow_up_task` |              - |                                                  |
| 16  | `appointment.book` (return) | followup  | `appointment`    |              1 |                                                  |
| 17  | `follow_up.return_booking`  | followup  | `follow_up_task` |              - |                                                  |
| 18  | `follow_up.resolve`         | followup  | `follow_up_task` |              - | "Return visit booked."                           |

Asserted over those rows:

- every row has `id`, `occurredAt` inside the test window, `actorRole`, `operation`, `entityType`, `entityId`; rows are in
  id order and their times never go backwards; every non-system row has an `actorId`;
- the right actor for each step: booking = the patient's user id, check-in = reception's, call/start/complete/priority =
  the doctor's, follow-up create = the doctor's, acknowledge, return booking and resolve = the follow-up user's; the call
  precedes start precedes complete by time; the return booking row's `next.returnAppointmentId` equals the booked
  appointment and the resolve row's `next.disposition` is `return_booked`;
- **all 10 queue operations** (`queue.*`, `consultation.*`, `visit.check_in`, `visit.walk_in`, `session.open`) carry
  `policyVersion` = the policy in force (version 1);
- **the priority override (FR-15-a):** one `queue.priority` row for the walk-in's queue entry, actor role `doctor` and the
  doctor's user id, time inside the window, entity `queue_entry` + id, `reason` = "Chest pain on arrival", `policyVersion`
  1, previous and next state in the row; and the following decision in `GET /sessions/:id/decisions` is `CLINICAL_PRIORITY`
  under policy 1, so the override and its effect can be read together;
- the default owner (D-028): the task returned by the doctor's `POST /follow-up-tasks` has a non-null `ownerId`, that user
  is a `followup` user **assigned to this doctor**, and the `follow_up.create` audit row records the same `ownerId`;
  acknowledge, return booking and resolve are audited with that owner's user id; another follow-up user's acknowledge is
  `403`;
- `GET /audit?entityType=follow_up_task&entityId=...` returns exactly `follow_up.create`, `follow_up.acknowledge`,
  `follow_up.return_booking`, `follow_up.resolve` (the refused attempt wrote nothing);
- **append-only (migration 0006):** `audit_events` has 1 non-internal trigger; on a separate connection `UPDATE ... SET
reason`, `UPDATE ... SET actor_id = NULL` and `DELETE` of a row of this visit each fail with `audit_events is
append-only (UPDATE|DELETE is not allowed)`, and the row re-read afterwards is unchanged. (`TRUNCATE` and dropping the
  trigger as a privileged role are not tested and are not blocked by a row trigger.);
- `GET /audit` is admin-only (`403` for patient, reception, doctor, follow-up).

Rows without a policy version are the operations the policy does not take part in (session creation, follow-up task
changes); the suite does not require one there.

## Part B: operations report (FR-15-b)

`GET /reports/operations?from=<today>&to=<today>` as admin, after the visit above:

- `throughput.completedVisits` = 2 (this suite's two visits; the report range is today in Asia/Kolkata and the scratch
  database is recreated per run), `sessions` at least 1; `waitsByGroup` has A, W, P and all
  rows with `n`; `decisionsByReason` includes `CLINICAL_PRIORITY`;
- **8 rows of kind `target`** (value from the Phase 1 report, `sampleSize` null, note "Phase 1 target, not measured here"):
  API p95 ordinary load 500 ms, API p95 burst 1000 ms, queue-update freshness p95 5000 ms, unexpected server errors
  upper bound 1 %, capacity oversubscriptions 0, availability 99.5 %, RPO 15 min, RTO 60 min;
- **8 rows of kind `measured`**, each with a sample size (median and p95 wait, mean consultation duration, no-show rate,
  follow-up tasks closed on time, follow-up tasks overdue now, assistant escalation rate, OCR failure rate);
- the suite asserts that no target row has a sample size, every target row says it is a target, no measured row carries the
  target note, and **no metric name appears as both**;
- non-admin roles get `403`; `from` after `to` gets `400`.

Measured rows in these runs (identical in 3 runs): median and p95 wait 0 min (n=2), mean consultation 0 min (n=2), no-show
rate 0 % (n=1), **follow-up tasks closed on time 75 % (n=4), follow-up tasks open and overdue now 2 (n=2), assistant
questions escalated 81.8 % (n=22), documents whose OCR failed 0 % (n=1)**. They are tiny samples from a freshly seeded
scratch database that also holds the T4 suites' tasks and questions (the previous run's follow-up and assistant rows had
n of 0 to 1 because T4 had not yet run in that database); they say nothing about hospital operations. The point is the
separation of the two kinds, not the numbers.

## Part C: reproducibility (NFR-08)

**Parts C1 to C3 below were measured in the earlier run on code `496bcdf` and were not repeated for the D-028 update.**

### C1. `./init.sh` (measured on this tree)

`./init.sh` checks Postgres, creates the `hqms` and `hqms_test` databases if missing, runs `pnpm install`, `pnpm db:migrate`
and `pnpm db:seed`. It is idempotent by construction (`IF NOT EXISTS`, migration checksums, seed rows with stable ids and
`ON CONFLICT DO NOTHING`).

| Run                                                                                                  | Wall time | What the log shows                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------- | --------: | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1: on the existing tree (shared `hqms` database, 1 migration behind, dependencies already installed) |     5.7 s | created `.env` from `.env.example`; "1 applied, 4 already applied"; seed: 0 sessions and 0 appointments created (already there)                      |
| 2: immediately again                                                                                 |     4.2 s | "0 applied, 5 already applied"; seed: 0 created; databases reported as existing                                                                      |
| Fresh scratch database, `db:migrate` + `db:seed` only (script run by hand, `DATABASE_URL` set)       |     3.0 s | "5 applied, 0 already applied"; seed created 10 doctors, 22 staff, 40 patients (10 with logins), **140 sessions, 15 appointments**                   |
| Same database again                                                                                  |     2.8 s | "0 applied, 5 already applied"; seed created 0 sessions, 0 appointments; row counts unchanged (users 32, patients 40, sessions 140, appointments 15) |

Not measured: a cold `pnpm install` (the store was warm), starting Postgres (it was running), `docker compose up`
(`docker` is installed but its daemon is not running in this sandbox, so the compose demo was **not exercised**), or a
second teammate following `docs/runbook.md` from a clean machine (NFR-08's "a second teammate deploys from
instructions" is therefore **not evidenced** here).

Post-start smoke (`pnpm smoke`, documented in `docs/runbook.md`), run against the built API on port 3399 and the seeded
`hqms` database: **9 of 9 checks passed**, 0.7 s (health, login + `/me` for the five roles, today's sessions, public
display, unauthenticated refusal).

### C2. `pnpm verify` (measured)

Command: `BLACKBOX_DB_NAME=hqms_test_blackbox_t4 pnpm verify` = typecheck, lint, dependency-cruiser, unit and integration
tests of every package, Semgrep (`p/typescript`, `p/owasp-top-ten`).

| Attempt | Result                                                                                                                                                                                                                   |                         Wall time (real) |
| ------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------: |
|       1 | stopped at typecheck: a TypeScript error in this task's own new test (fixed)                                                                                                                                             |                                   33.8 s |
|       2 | typecheck, lint, depcruise green; `apps/api` suite: 127 of 128 tests, **1 failed** (`followup.int.test.ts`, "This doctor already has a session starting at that time", 409 while creating its fixture session); see note |                                 1 m 21 s |
|       3 | **all green**: typecheck, lint, dependency-cruiser, tests (contracts 5, providers 69, domain 129, db 64, web 53, worker 78, api 128, tests/integration 53 in 6 files, simulation 16), Semgrep exit 0                     | **1 m 58.9 s** (user 2 m 13 s, sys 15 s) |

Note on attempt 2: `apps/api` creates its scratch database under the fixed name `hqms_test_api_w3`, and other agents were
running the same suite on the same machine at that time, which is the cause class recorded in D-027 for the black-box
suites. It passed unchanged on attempt 3 and I did not investigate further, so "environmental collision" is the likely
but unproven cause. This is reported as a flake in a file outside this task.

The duration is for one run on a shared, loaded 4-vCPU machine; a quiet machine will differ. `pnpm test:concurrency`
(T1 + T2, 17 tests) also passed once with the setup change made for this task (`STORAGE_DIR`).

### C3. Keyboard walkthrough (NFR-08-b)

| Evidence                                                                                       | What it covers                                                                                                                                                                                                   | Result in this task's runs                                                     |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `tests/e2e/full-visit.spec.ts` (`pnpm e2e`)                                                    | real stack, four browser contexts: booking, reception check-in, doctor call, start, complete by **keyboard only** (`page.keyboard`); screenshots and a raw JSON; write-up `docs/evidence/e2e-full-visit.md`      | **1 of 1 passed**, 14.1 s total (ports 3288/5288, database `hqms_e2e_t6_test`) |
| `apps/web/e2e/booking.spec.ts`, `reception.spec.ts`, `w2-queue.spec.ts`, `screenshots.spec.ts` | mock-backed Playwright specs: keyboard-only booking, reception "/" search + check-in, late-arrival dialog, doctor console N/Enter/Start/Complete, Tab reaches Call next, session board lanes, login and sign-out | `playwright test -g keyboard`: **12 of 12 passed**, 20.5 s                     |

I ran each once; the 3-run stability claim for the full-visit flow is in `e2e-full-visit.md` (its own runs), not repeated
here. The generated screenshots and raw JSON of that e2e run were restored to their committed versions, so this task changes
no file of the e2e evidence. The follow-up screens (upload, review inbox, assistant, follow-up inbox) are not on this
branch, so no keyboard walkthrough of those exists.

### C4. Release record

| Item                                          | Value                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source                                        | branch base `496bcdf0f615ea63fe4d35be0983c85d7c671c1c` ("docs: progress G2") plus the T4/T6 test commit on branch `worktree-agent-a039562942f6c8a05` (its hash is the commit that adds this file; `git log -1` on the branch)                                                                                                                   |
| Package versions                              | all workspaces `0.1.0` (private)                                                                                                                                                                                                                                                                                                                |
| Migrations applied (from `schema_migrations`) | `0001_init`, `0002_patient_mrn_sequence`, `0003_active_appointment_uq`, `0004_ownership_and_email`, `0005_instruction_version_title`, `0006_audit_append_only` (6 of 6, read from the scratch database in this update's runs)                                                                                                                   |
| Queue policy                                  | version **1**: rotation A,A,W; early eligibility 10 min; late grace 15 min; aging trigger 45 min; called timeout 120 s; EWMA alpha 0.2; initial estimate 12 min; default capacity 10 booked + 5 walk-in. Asserted equal to the Table 7 values by `t6-audit-trail.test.ts`, and sessions reference it (`sessions.policy_id`)                     |
| Runtime                                       | Node 22.23.4, PostgreSQL 16.15, providers `local` identity, `local-disk` storage, `fake` OCR, `fake` LLM                                                                                                                                                                                                                                        |
| Gate                                          | Earlier tree (`496bcdf`): `pnpm verify` green on attempt 3 above; `pnpm e2e` 1 of 1; `pnpm smoke` 9 of 9; `pnpm test:concurrency` 17 of 17. This update (`d772596`): `tests/integration` 58 of 58 in 3 runs; `pnpm test:concurrency` 17 of 17 (after stabilising a flaky T2 test, see Limitations); `pnpm verify` and `pnpm e2e` **not re-run** |

## Limitations and observations

1. **`audit_events` is append-only at row level since migration 0006** (it was not in the earlier run). The suite proves
   that UPDATE and DELETE fail for a normal connection. It does not claim tamper-proofing against a privileged role (which
   can drop the trigger or `TRUNCATE`); that would be a schema change visible in review, not something the application does.
2. Audit rows exist for the operations listed above; the suite checks the operations of one visit, it does not prove that
   _every_ state-changing route audits (the route matrix in `authz-tests.md` is about authorization, not audit).
3. The report's measured rows come from one scratch database with a handful of rows; no statement about hospital
   operations follows. The report's **target** rows (latency, freshness, availability, RPO, RTO) have no measured
   counterpart in this file; the T5 load and recovery drill is separate and not part of this task.
4. Timings are from a loaded shared VM; `pnpm verify` at 1 m 59 s is one data point, not a bound.
5. No second-person deployment, no `docker compose up`, and no hosted-environment run were performed.
6. The suites in this task use fake providers and the demo seed; they exercise the code paths, not clinical validity.
7. **`pnpm test:concurrency` flake found and fixed while re-running.** In 3 of 8 full-suite runs on the unchanged test, the T2
   "two overlapping sessions" test failed in a late round: each session held 16 walk-ins, a session that had been drained
   answered `200 NO_ALLOCATION` (`entry: null`, no allocation) and the test counted it as a second winner. The doctor guard
   itself held (one called patient per round). The test now admits 20 walk-ins per session (= the number of rounds); 8
   consecutive full-suite runs afterwards were 17 of 17 green. `docs/evidence/T2-policy-doctor-guard.md` still says "16
   waiting walk-ins" and is not updated here. Observation for the API owner: a call-next on an empty session while the doctor
   is occupied returns `200 NO_ALLOCATION` rather than `409 DOCTOR_OCCUPIED`; harmless to the guard, but not the same answer
   as for a non-empty session.
