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
pnpm test:concurrency                # = pnpm --filter @hqms/tests test:concurrency (4 files, 12 tests)
```

Source: `tests/concurrency/t1-last-slot.test.ts`, `t1-idempotency.test.ts`, `t1-reschedule.test.ts`,
`t1-checkin.test.ts`. Raw numbers of the last run: `docs/evidence/T1-booking-collision.raw.json`.

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
