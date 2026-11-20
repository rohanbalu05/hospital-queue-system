# T1: booking collision, reschedule rollback, idempotent retries

Evidence for report section 5.6, Table 5, row T1 (FR-03, FR-04, FR-05, NFR-03). Everything below marked **measured**
comes from runs of the suite described here on the machine described here. Nothing in this file is a target.

## Purpose

Show, with real parallel connections against a real PostgreSQL, that:

1. when many callers race for the last bookable place of a session, exactly one succeeds and the rest receive
   `409 CAPACITY_FULL`, with no 5xx and no counter drift;
2. a reschedule is an atomic exchange of reservations: into a full session it fails with nothing changed, among
   competing reschedules only as many succeed as there are places, and a reschedule racing a cancel never applies both;
3. a retried request (same `Idempotency-Key`) creates one appointment and replays one response, and a key reused with a
   different body is rejected;
4. repeated check-ins of one appointment create one visit and one queue entry, and walk-in admissions never exceed the
   walk-in capacity.

## Environment (this machine; not the hosted environment)

| Item              | Value                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host              | cloud sandbox VM, Linux 6.18.44, 4 vCPU (Intel Xeon @ 2.10 GHz), 16 GB RAM                                                                                                |
| Node.js           | v22.23.4                                                                                                                                                                  |
| PostgreSQL        | 16.15 (Ubuntu package), `localhost:5432`, `max_connections = 100`, default configuration                                                                                  |
| Database          | scratch database `hqms_test_blackbox`, dropped, created, migrated and seeded at the start of every run                                                                    |
| System under test | the production bundle `apps/api/dist/main.js` (tsup build, rebuilt by the test setup), started as a child process on a free local port, `DB_POOL_MAX=30`, `NODE_ENV=test` |
| Load generator    | the Vitest process on the **same machine** (Node `fetch`/undici, one fresh TCP connection per concurrent request)                                                         |
| Worker            | not running (no `reservation_release` timers fire during the tests)                                                                                                       |

The API, the database and the load generator share the same 4 vCPUs, and the database is on localhost, so there is no
network latency. Latencies are therefore only comparable with each other, not with a deployed system. The hosted
environment (Cloud Run + Cloud SQL) has not been tested.

## Method

- Harness (`tests/support/global-setup.ts`): recreates the database, migrates and seeds it with `@hqms/db`, builds and
  starts the API, waits for `GET /health`, tears down afterwards. Tests log in over HTTP (`POST /auth/login`, httpOnly
  cookie) with the seeded demo accounts, so every request goes through the real guard, validation, authorization and
  transaction helper. Nothing is mocked.
- Parallelism: `Promise.all` over independent `fetch` calls from several logged-in clients. Each in-flight request uses its own TCP
  connection and its own server-side pool connection (pool size 30).
- Fixtures follow D-022: every booking in a session uses a distinct patient (seeded login patients plus patients
  registered through `POST /patients`). Races run on sessions dated 2040 or later (never past slots); check-in and
  walk-in tests use a session dated today whose first slot is 60 to 170 minutes ahead (arrivals are only accepted on the
  session's own day).
- Invariants are checked by direct SQL after each round and over the whole database after each file
  (`checkGlobalInvariants`): per session `booked_reserved` and `walkin_used` equal the count of reserved or consumed
  allocation rows and do not exceed capacity; no two active appointments share a slot; an appointment's status agrees
  with its allocation state; no appointment has two visits; no visit has two queue entries; no doctor has two
  called or in-service entries; no visit lacks a queue entry.

## Commands

```
pnpm --filter @hqms/api build        # the suite also rebuilds it in global setup
pnpm test:concurrency                # = pnpm --filter @hqms/tests test:concurrency (historical: 4 T1 files, 12 tests; since session 3: 5 T1 files, 14 tests, see the session 3 section)
```

Source: `tests/concurrency/t1-last-slot.test.ts`, `t1-idempotency.test.ts`, `t1-reschedule.test.ts`,
`t1-checkin.test.ts` (session 3 adds `t1-move.test.ts`). Raw numbers of the last run: `docs/evidence/T1-booking-collision.raw.json`
(regenerated in session 3; the three-run tables below are the original session-1 runs and are kept as history, see "Session 3 re-run" at the end for the current numbers).

## Results (measured)

Suite status: **12 of 12 tests passed in each of 3 consecutive full runs** (about 16 to 20 s per run). No flaky test
was observed in those runs; one earlier development run and one final run after the last edit also passed (not included in the tables).

### 1. Last-slot race: 50 parallel bookings, 20 rounds

Per round: 10 patients book for themselves (their own login) and 40 patients are booked by reception, all at once, for a
session that has exactly one bookable place left. Even rounds use a session with `booked_capacity = 1`; odd rounds use
capacity 10 with 9 places already taken.

|                                                 |    Run 1 |    Run 2 |    Run 3 |
| ----------------------------------------------- | -------: | -------: | -------: |
| Rounds                                          |       20 |       20 |       20 |
| Race requests                                   |     1000 |     1000 |     1000 |
| `201` (successes)                               |       20 |       20 |       20 |
| `409 CAPACITY_FULL`                             |      980 |      980 |      980 |
| 5xx                                             |        0 |        0 |        0 |
| Rounds with exactly one success                 |  20 / 20 |  20 / 20 |  20 / 20 |
| Invariant violations (whole DB, after the file) |        0 |        0 |        0 |
| Latency p50 of race requests                    | 159.2 ms | 145.9 ms | 121.2 ms |
| Latency p95 of race requests                    | 251.5 ms | 234.6 ms | 228.9 ms |
| Latency max                                     | 338.7 ms | 307.0 ms | 366.1 ms |

Latency here is the wall-clock time of each racing request from the client, with 50 requests contending for one
session's locks on a shared 4-vCPU machine. The first round of each run is slower (p50 of 245, 198 and 281 ms in runs 1
to 3) because of cold connections and a cold query plan cache; I did not exclude it.

Per-round outcome of run 3 (the other runs have the same shape; only run 3's
per-round file is kept in `T1-booking-collision.raw.json`):

| Round | Setup                     | Requests | 201 | 409 CAPACITY_FULL | 5xx | booked_reserved / capacity | booked allocations | p50 ms | p95 ms | max ms |
| ----: | ------------------------- | -------: | --: | ----------------: | --: | -------------------------: | -----------------: | -----: | -----: | -----: |
|     1 | capacity=1                |       50 |   1 |                49 |   0 |                      1 / 1 |                  1 |  280.5 |  361.3 |  366.1 |
|     2 | capacity=10, 9 pre-booked |       50 |   1 |                49 |   0 |                    10 / 10 |                 10 |  160.8 |  237.7 |  242.1 |
|     3 | capacity=1                |       50 |   1 |                49 |   0 |                      1 / 1 |                  1 |  106.9 |  157.4 |  164.5 |
|     4 | capacity=10, 9 pre-booked |       50 |   1 |                49 |   0 |                    10 / 10 |                 10 |    110 |  187.6 |  193.8 |
|     5 | capacity=1                |       50 |   1 |                49 |   0 |                      1 / 1 |                  1 |  100.3 |  179.2 |  181.8 |
|     6 | capacity=10, 9 pre-booked |       50 |   1 |                49 |   0 |                    10 / 10 |                 10 |    100 |  148.2 |  151.4 |
|     7 | capacity=1                |       50 |   1 |                49 |   0 |                      1 / 1 |                  1 |  102.6 |  149.8 |  154.9 |
|     8 | capacity=10, 9 pre-booked |       50 |   1 |                49 |   0 |                    10 / 10 |                 10 |  123.1 |  212.8 |  219.5 |
|     9 | capacity=1                |       50 |   1 |                49 |   0 |                      1 / 1 |                  1 |  132.9 |  200.5 |  202.6 |
|    10 | capacity=10, 9 pre-booked |       50 |   1 |                49 |   0 |                    10 / 10 |                 10 |  179.1 |  254.6 |  257.8 |
|    11 | capacity=1                |       50 |   1 |                49 |   0 |                      1 / 1 |                  1 |  105.2 |  147.3 |  148.2 |
|    12 | capacity=10, 9 pre-booked |       50 |   1 |                49 |   0 |                    10 / 10 |                 10 |  112.5 |  167.4 |  172.3 |
|    13 | capacity=1                |       50 |   1 |                49 |   0 |                      1 / 1 |                  1 |  106.9 |  192.8 |  195.6 |
|    14 | capacity=10, 9 pre-booked |       50 |   1 |                49 |   0 |                    10 / 10 |                 10 |  119.9 |  195.6 |  198.9 |
|    15 | capacity=1                |       50 |   1 |                49 |   0 |                      1 / 1 |                  1 |   98.2 |  149.3 |  152.8 |
|    16 | capacity=10, 9 pre-booked |       50 |   1 |                49 |   0 |                    10 / 10 |                 10 |   95.6 |  143.5 |    146 |
|    17 | capacity=1                |       50 |   1 |                49 |   0 |                      1 / 1 |                  1 |   86.7 |  136.2 |  141.3 |
|    18 | capacity=10, 9 pre-booked |       50 |   1 |                49 |   0 |                    10 / 10 |                 10 |    131 |  213.7 |  221.8 |
|    19 | capacity=1                |       50 |   1 |                49 |   0 |                      1 / 1 |                  1 |  145.5 |  202.2 |  206.2 |
|    20 | capacity=10, 9 pre-booked |       50 |   1 |                49 |   0 |                    10 / 10 |                 10 |  115.7 |  184.4 |  189.4 |

After every round the test also asserts that the session holds exactly `pre-booked + 1` appointment rows and that the
single `201` response id is one of them.

### 2. Idempotent retries (lost-response simulation)

| Check                                                                  | Measured result (runs 1 to 3)                                                                                                                                              |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same key, same body, 10 parallel requests, 10 rounds on fresh sessions | every round: 10 x `201`, 1 distinct appointment id, 9 responses carry `Idempotency-Replayed: true`, parsed response bodies deeply equal, 1 appointment row, counters 1 / 1 |
| Same key, different body (other patient, then other session)           | `409 IDEMPOTENCY_KEY_REUSED`, no new row                                                                                                                                   |
| Same key, 5 requests with body A and 5 with body B in parallel         | 5 x `201` (the winning body, original or replayed) and 5 x `409 IDEMPOTENCY_KEY_REUSED`, 1 appointment row                                                                 |
| Same key used by two different staff users                             | both `201`, two different appointments (key scoped to the caller)                                                                                                          |
| Capacity-full failure, slot freed, same key retried                    | first `409 CAPACITY_FULL`, retry `201` not marked as replayed (a business error is not stored, as documented in D-022)                                                     |

### 3. Reschedule

| Check                                                                                                       | Measured result (runs 1 to 3 plus one earlier development run, called "run 4" in this row)                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reschedule into a full session, 10 attempts                                                                 | every attempt `409 CAPACITY_FULL`; the original appointment row joined with its allocation row is equal before and after (including `version` and `updated_at`), the filler's row is equal, the audit and outbox row counts are equal, both sessions' counters are equal |
| 10 appointments (10 patients, own logins) race to reschedule into a session with 1 place, 5 rounds          | every round: 1 x `201`, 9 x `409 CAPACITY_FULL`, 0 5xx; the 9 losers' rows are equal to their snapshot; source `booked_reserved` 9 (allocations 9), target 1 (allocations 1); the winner's original is `rescheduled` with a `released` allocation                        |
| Reschedule racing cancel on the same appointment, 20 trials per run, source and target of different doctors | exactly one of the two succeeded in all 80 trials (4 runs); the other returned 409; never both; no 5xx; source counter 0 and allocations 0 in every trial; target counter matches the allocation rows (1 if the reschedule won, 0 if the cancel won)                     |

Which request won the reschedule-versus-cancel race varied from run to run (reschedule won 11, 15, 10 and 9 of 20 trials
in the four runs), which shows that both orders were exercised.

### 4. Check-in and walk-in

| Check                                                                          | Measured result (runs 1 to 3)                                                                                                                        |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10 parallel check-ins of one appointment, different keys, 5 trials             | each trial: 1 x `201` and 9 x `200` returning the same `visitId`, `queueEntryId` and token; 1 visit row, 1 queue entry, 1 `visit.check_in` audit row |
| 20 parallel walk-in admissions into a session with 5 walk-in places, 3 rounds  | each round: exactly 5 x `201` with tokens W-001 to W-005 (all distinct), 15 x `409 CAPACITY_FULL`; `walkin_used` 5; 5 visits and 5 queue entries     |
| Same patient admitted as walk-in 6 times at once                               | 1 x `201`, 5 x `409`; 1 visit                                                                                                                        |
| 5 check-ins and 10 walk-in requests at once on a session with 3 walk-in places | all 5 check-ins `201` on their own reservation; exactly 3 walk-ins `201`; `booked_reserved` 5, `walkin_used` 3, allocation rows equal                |

### 5. Global invariants

After each of the four files the whole database was checked for the invariants listed under Method. Violations
reported: **0** in every file of every run.

## Limitations and what this does not show

- Single machine, loopback networking, load generator sharing the CPUs, default PostgreSQL configuration. It shows
  correctness under contention, not capacity or hosted latency.
- 50-way contention on one session is the maximum tested (the report's scenario). Wider fan-in, multiple API
  instances and a running worker (timers racing the requests) were not tested.
- The suite has not been mutation-tested (I did not remove a lock to confirm the suite fails). The database `CHECK`
  constraints on the counters would turn an over-booking into a 5xx, which the suite also detects, but this was not
  demonstrated by a failing run.
- The reschedule-versus-cancel test only observes the two orderings that happened to occur; the outcomes are not
  forced.
- Late-arrival, `missed` and no-show timer paths are outside T1 and are not covered here.
- Behaviour that D-022 plans to change (one active appointment per patient per session, past-slot rule, patient
  search) is not asserted; fixtures use a distinct patient per booking and future sessions only.

## Update (session 2): Codex P1 — parked entries and duplicate admission (FR-05, NFR-03)

Finding: a walk-in marked absent or skipped kept an open visit and a consumed place, but admission no longer saw it, so reception could admit the same patient again (second place, second token); re-entering the original then left two waiting entries for one patient in one session.

Test-first record:
- Failing tests committed first (`65661f7`, `apps/api/test/duplicate-admission.int.test.ts`): 6 of 11 failed — second walk-in after absent → 201 (expected 409); after skip → 201; re-entry beside another live / parked-open entry → 200 (expected 409); 10 parallel walk-ins for an absent patient → 1 success (expected 0); a second open visit inserted without error (expected 23505).
- Fix (`bdacda5`): `hasLivePlace` counts waiting/called/in-service entries and skipped/absent entries with an open visit (under doctor → session → capacity locks); `reEnter` refuses when another live or parked-open entry exists; migration 0007 adds a unique index on `visits (session_id, patient_id) WHERE status IN ('open','in_service')` (D-031).
- After the fix: 11/11; API suite 187/187; `pnpm verify` green; `pnpm test:concurrency` 17/17 (T1 + T2 unchanged).

Measured: 10 parallel walk-ins for a patient whose entry is absent → 0 successes, capacity unchanged; 10 parallel walk-ins for a patient with no place → exactly 1 success; a patient whose earlier visit was completed or left can still be admitted.

## Session 3 re-run (2026-11-20, code tree of commit `1697f3e`): bulk move and transfer races, current raw numbers

Re-measured on 2026-11-20 on the final product tree (commit `1697f3e`; the evidence commits on top of it change documents only). Same kind of machine
as above (cloud sandbox VM, Linux 6.18.44, 4 vCPU, PostgreSQL 16.15 on localhost, Node v22.23.5), with scratch database
`hqms_test_bb_ev` (set through `BLACKBOX_DB_NAME`) instead of `hqms_test_blackbox`. One full `pnpm test:concurrency` run:
**19 of 19 tests passed in 7 of 7 files** (Vitest reported 16.8 s; T1 is 5 files and 14 tests, T2 is 2 files and 5 tests). One run is the sample
behind this section; the earlier "3 consecutive runs" statement above belongs to session 1.

**Superseded numbers.** The latency figures and the per-run splits in the tables above (for example the last-slot p50 of 159.2, 145.9 and 121.2
ms, and "reschedule won 11, 15, 10 and 9 of 20") are measurements of the session-1 build on the session-1 runs. They are kept as history and are not
the current figures. The pass criteria (counts and invariants) are unchanged and held again; latencies differ because of code, machine load and
database state at the time.

### Current numbers (raw: `T1-booking-collision.raw.json`, last run)

| Check                                                              | Measured result (this run)                                                                                                                                                  |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Last-slot race, 20 rounds x 50 requests                            | 1000 requests: 20 x `201` (one per round), 980 x `409 CAPACITY_FULL`, 0 5xx; every round ended with counters equal to the allocation rows                                   |
| Last-slot latency, all 1000 requests                               | p50 58.4 ms, p95 92.5 ms, max 106.2 ms (client-side, shared 4-vCPU machine; not a latency target)                                                                          |
| Reschedule into a full session                                     | 10 attempts, all `409 CAPACITY_FULL`; row snapshots before and after equal                                                                                                  |
| 10 reschedules racing for 1 place, 5 rounds                        | every round 1 x success, 9 x `409 CAPACITY_FULL`, 0 5xx; source `booked_reserved` 9, target 1                                                                                |
| Reschedule racing cancel, 20 trials                                | reschedule won 3, cancel won 17; never both and never neither; 0 5xx                                                                                                        |
| 10 parallel check-ins of one appointment, 5 trials                 | each trial 1 x `201` and 9 x `200` with one token, 1 visit, 1 queue entry, 1 audit row                                                                                     |
| 20 parallel walk-ins into 5 places, 3 rounds                       | each round 5 x `201` (W-001 to W-005) and 15 x `409 CAPACITY_FULL`                                                                                                         |
| Same patient as walk-in 6 times at once                            | 1 x `201`, 5 x `409`                                                                                                                                                        |
| 5 check-ins and 10 walk-in requests on 3 walk-in places            | 8 x `201` (5 check-ins and 3 walk-ins), 7 x `409`                                                                                                                           |
| Same key, same body, 10 parallel requests, 10 rounds               | every round 10 x `201`, 1 distinct id, 9 replayed                                                                                                                           |
| Same key with another body                                         | sequential reuse `409`; 5 x `201` and 5 x `409` when the two bodies race                                                                                                    |
| Key scoped to the actor; business failure not stored               | two staff with the same key: `201` and `201`; `409` then retry `201`                                                                                                         |
| Global invariant violations after each of the four recorded groups | 0, 0, 0, 0 (`t1LastSlot`, `t1Reschedule`, `t1CheckIn`, `t1Idempotency` in the raw file)                                                                                     |

**Run-to-run spread, same tree, same day.** The final-tree verification run, whose raw file this run replaced, gave the same counts (1000 requests, 20 x `201`, 980 x `409`, 0 5xx) with last-slot
latency p50 83.3 ms, p95 131.1 ms, max 160.6 ms (this run: 58.4, 92.5, 106.2), and reschedule won 2 and cancel won 18 of 20 (this run: 3 and 17). Counts and invariants repeat; latencies and race splits do not.

### New in session 3: bulk move and transfer of affected patients (`tests/concurrency/t1-move.test.ts`, D-033)

When a doctor becomes unavailable for the rest of a session, reception or admin can move the affected patients into another session through
`POST /sessions/:id/affected/move` (checked-in patients are transferred, booked appointments are rescheduled). Two staff members can do this at
the same time with overlapping selections, which is a new place where one patient could be moved twice or a target could be over-allocated.

What the two tests do (real HTTP against the built API, real PostgreSQL, reception and admin logins, nothing mocked):

1. **Checked-in patients, 6 rounds.** Each round creates a source session (doctor 1, 10 booked and 5 walk-in places) with 6 booked and checked-in
   patients, a target session (doctor 2, `booked_capacity` 2, no walk-in places), marks the source unavailable, and then fires two
   `affected/move` requests at once: reception moves entries 0 to 3, admin moves entries 2 to 5 (entries 2 and 3 overlap).
2. **Booked appointments, 4 rounds.** The same race with six booked appointments (not checked in) and `appointmentIds` in the selection.

Asserted per round: no 5xx; both requests answer `200`; the two responses together report exactly **2 moved** (the target's two free places);
every skipped item carries a controlled code (`CAPACITY_FULL`, `INVALID_TRANSITION` or `CONFLICT`); the target has `booked_reserved` 2 and exactly
2 allocation rows; no source entry (or appointment) has more than one successor, and exactly 2 do; in test 1 exactly 2 source entries are
`cancelled` with visit `transferred`, the other 4 stay `waiting` with visit `open`, and the target holds exactly 2 queue entries. After the file,
`checkGlobalInvariants` must report no violation.

**Measured result (2026-11-20 run described above): both tests passed (10 race rounds in total, the file took 1.27 s in Vitest's report), and
the global-invariant check after the file passed.** This file does not write a `.raw.json` entry (`tests/support/results.ts` has no key for it),
so the only recorded measurements are Vitest's pass result and durations; per-round counts such as how many of the 4 + 4 selected items each staff
member happened to move are not recorded and are not claimed here. Limits: two concurrent staff and a 2-place target is the one shape tested;
more than two movers, moves racing patient self-cancel, and moves racing the worker are not covered.
