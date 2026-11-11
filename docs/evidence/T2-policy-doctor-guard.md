# T2: deterministic policy and the doctor-level guard under concurrency

Evidence for report section 5.6, Table 5, row T2 (FR-06, FR-07, FR-08, NFR-03; Table 8). Everything marked **measured**
comes from the runs of the suites named here on the machine named here. No target is claimed as achieved.

## Purpose

Show, over the real HTTP API and a real PostgreSQL, that:

1. the report's Table 8 selection trace is reproduced decision by decision (candidate token, reason, rotation slot,
   pointer before and after, policy version, plain-words explanation), that the log read back over HTTP equals the
   `queue_decisions` table, and that two independent runs on fresh sessions make identical decisions (FR-06-a, at
   system level rather than on the pure function);
2. a doctor who owns two overlapping sessions never has more than one patient called or in service, however many
   call-next requests race (the doctor-level guard of report 6.5, D-017), and every loser gets a clean
   `409 DOCTOR_OCCUPIED`, never a 5xx;
3. call-next racing start, complete and skip of the same entry produces one valid transition sequence;
4. a pause racing call-next never lets a call succeed after the pause has committed;
5. the same `Idempotency-Key` sent ten times in parallel allocates one patient and replays one response.

## Environment (this machine; not the hosted environment)

| Item              | Value                                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host              | cloud sandbox VM, Linux 6.18.44, 4 vCPU (Intel Xeon @ 2.10 GHz), 16 GB RAM                                                                           |
| Node.js           | v22.23.4                                                                                                                                             |
| PostgreSQL        | 16.15 (Ubuntu package), `localhost:5432`, `max_connections = 100`, default configuration                                                             |
| Database          | scratch database `hqms_test_blackbox`, dropped, created, migrated and seeded at the start of every run                                               |
| System under test | production bundle `apps/api/dist/main.js` started as a child process on a free port, `DB_POOL_MAX=30`, `NODE_ENV=test`, rebuilt by the suite's setup |
| Load generator    | the Vitest process on the **same machine** (Node `fetch`, up to 30 requests in flight)                                                               |
| Worker            | not running (no `call_timeout` or `reservation_release` jobs fire; nothing here depends on them)                                                     |
| Date of the runs  | 2026-11-11                                                                                                                                           |

API, database and load generator share 4 vCPUs on localhost, so latencies are comparable with each other only.

## Method

- Harness: `tests/support/global-setup.ts` (shared with T1). Every request is a real HTTP call with a login cookie
  (`doctor@hqms.test`, `doctorN@hqms.test`, `reception@hqms.test`, `admin@hqms.test`), so the guards, validation,
  authorization, idempotency and the transaction helper are all exercised. Nothing is mocked.
- **Time.** The API reads the real clock and a black-box test cannot move it (there is deliberately no HTTP route for
  that). Table 8 is therefore reproduced by relative order, not by its 09:00 timestamps: the session starts 12 to 13
  minutes before the test, so slot 1 is still inside its 15-minute grace window and slot 2 is already eligible (early
  eligibility is 10 minutes before the slot), which is exactly the "A1, A2 and W1 eligible" situation of decision 1.
  Arrivals are issued in the order of the report (A1, A2, W1; P1 after decision 1; W2 after decision 4).
  The in-process version of the same trace with an injected clock is `apps/api/test/queue.int.test.ts`; the pure
  function is `packages/domain/test/table8.golden.test.ts`.
- **Overlap.** The doctor-guard race uses doctor 5 with two sessions dated today that overlap (started 40 and 25
  minutes ago, 4 hours long), each with 16 waiting walk-ins.
- **Invariant polling.** During every race a separate PostgreSQL connection polls
  `count(called or in_service entries of that doctor)` in a loop (about 1 ms apart) and the suite records the highest
  value it ever saw. After each round the committed state is also checked. Whole-database invariants (`checkGlobalInvariants`,
  same as T1, including "no doctor has two called/in-service entries") run after each file.
- **Interleavings.** The transition and pause races start every request after a random 0 to 8 ms (0 to 10 ms) offset
  and shuffle or rotate the burst order each round, so the result is not one fixed interleaving.

## Commands

```
pnpm --filter @hqms/api build
pnpm test:concurrency      # T1 + T2 together: 6 files, 17 tests (T2 is 2 files, 5 tests)
```

Source: `tests/concurrency/t2-golden-http.test.ts`, `tests/concurrency/t2-doctor-guard.test.ts`. Raw numbers of the
last run: `docs/evidence/T2-policy-doctor-guard.raw.json`.

## Results (measured)

Suite status: **17 of 17 tests passed in each of 3 consecutive full `pnpm test:concurrency` runs** (about 34 to 37 s
per run, T1 included). No flaky test was observed. Global invariant violations after each file: **0** in all runs.
(One earlier development run of the transition test failed because the test itself over-admitted walk-ins past the
session capacity; that is a fixture bug fixed before the three counted runs.)

### 1. Table 8 over HTTP, twice

Expected values are the report's Table 8 (pointer after: second A, unchanged, W, first A, first A). Every cell below
was observed identically over `GET /sessions/:id/decisions` and in the `queue_decisions` table, in both runs
(doctor 3 and doctor 4, fresh sessions), in all 3 counted suite runs.

| Decision | Eligible set (from the stored candidates) | Called    | Reason              | Rotation slot | Pointer before | Pointer after | Policy |
| -------: | ----------------------------------------- | --------- | ------------------- | ------------: | -------------: | ------------: | -----: |
|        1 | A-001, A-002, W-001                       | A-001     | `ROTATION`          |             0 |              0 |             1 |      1 |
|        2 | A-002, W-001, W-002                       | **W-002** | `CLINICAL_PRIORITY` |          null |              1 |             1 |      1 |
|        3 | A-002, W-001                              | A-002     | `ROTATION`          |             1 |              1 |             2 |      1 |
|        4 | W-001                                     | W-001     | `ROTATION`          |             2 |              2 |             0 |      1 |
|        5 | W-003                                     | W-003     | `ROTATION`          |             2 |              0 |             0 |      1 |

Explanations returned (exact strings asserted): "Called by rotation: 1st appointment of A, A, W"; "Clinical priority (class
1)"; "Called by rotation: 2nd appointment of A, A, W"; "Called by rotation: walk-in turn of A, A, W"; "Called by
rotation: walk-in turn of A, A, W; appointment turn skipped (no appointments waiting)". Final `sessions.rotation_pointer` = 0.

Also asserted at each decision: while a patient is called, call-next by the doctor and by reception returns `409
DOCTOR_OCCUPIED` (non-preemption; 10 refusals per run); reception's attempt to set a clinical priority returns `403`
(non-clinical actor); the doctor's succeeds with `200`.

Determinism: the full decision sequences of run A and run B (token, reason, slot, pointers, policy version,
**queue version**, explanation, eligible set) are deep-equal over HTTP and in the table.

### 2. One doctor, two overlapping sessions, 30 parallel call-next, 20 rounds

Per round: 30 simultaneous `POST /sessions/:id/call-next` (15 to each session; three doctor logins and three reception
logins; distinct Idempotency-Keys); the visit is started and completed between rounds.

|                                                        |           Run 1 |          Run 2 |           Run 3 |
| ------------------------------------------------------ | --------------: | -------------: | --------------: |
| Rounds                                                 |              20 |             20 |              20 |
| Race requests                                          |             600 |            600 |             600 |
| `200` with a called patient (exactly 1 per round)      |              20 |             20 |              20 |
| `409 DOCTOR_OCCUPIED`                                  |             580 |            580 |             580 |
| 5xx                                                    |               0 |              0 |               0 |
| Decision rows with a patient written (1 per round)     |              20 |             20 |              20 |
| Winners from session A / session B                     |          13 / 7 |         12 / 8 |          15 / 5 |
| Poller reads during the races                          |            1419 |           1228 |            1606 |
| Highest called or in-service count ever seen (limit 1) |               1 |              1 |               1 |
| Invariant violations                                   |               0 |              0 |               0 |
| call-next latency under contention, all requests p50   |        125.4 ms |        92.7 ms |        137.8 ms |
| call-next latency under contention, all requests p95   |        325.6 ms |       169.7 ms |        293.6 ms |
| call-next latency, max                                 |        392.1 ms |       288.7 ms |        389.4 ms |
| Winning request only, p50 / p95 (n = 20)               | 71.3 / 154.6 ms | 50.8 / 72.3 ms | 77.4 / 160.1 ms |

Latency is the client-side time from sending to reading the body, with 30 requests in flight on a shared 4-vCPU
machine; the losers queue on the doctor lock, which is why the all-request figures exceed the winner's. These are
measurements of this setup, not a latency target.

### 3. call-next vs start vs complete vs skip on the same entry (40 rounds x 9 requests)

Per round: an entry is called, then nine requests race: start x2, complete x2, skip x2 (doctor and reception),
call-next x3, each after a random offset. Checks per round: every status is 200 or 409; no 5xx; the entry ends in
`completed`, `skipped` or `in_service`; the number of successful start/complete/skip calls and the entry's version
increase match exactly one valid sequence (completed: start and complete once each, +2; skipped: skip once, +1;
in_service: start once, +1); call-next refusals are all `DOCTOR_OCCUPIED`, at most one call-next succeeds, none while a
consultation is in progress; at most 1 called/in-service entry for the doctor at all times.

|                                              |     Run 1 |    Run 2 |    Run 3 |
| -------------------------------------------- | --------: | -------: | -------: |
| Requests                                     |       360 |      360 |      360 |
| `200` / `409`                                | 103 / 257 | 95 / 265 | 99 / 261 |
| 409 `INVALID_TRANSITION` / `DOCTOR_OCCUPIED` |  176 / 81 | 181 / 84 | 177 / 84 |
| 5xx                                          |         0 |        0 |        0 |
| Sequence violations                          |         0 |        0 |        0 |
| Final state: completed, then another called  |        24 |       18 |       21 |
| Final state: skipped, then another called    |        15 |       18 |       15 |
| Final state: completed, nobody called after  |         0 |        1 |        2 |
| Final state: in service (complete lost)      |         1 |        3 |        2 |
| Highest called or in-service count seen      |         1 |        1 |        1 |

### 4. Pause racing call-next (20 rounds x 12 requests)

Per round (fresh session, doctor 7, 4 walk-ins waiting, session opened): two pause requests (doctor and reception) and
ten call-next requests, offset randomly, burst order rotated each round. Checks: exactly one pause applies (the other is
`409 INVALID_TRANSITION`); at most one call wins; every call that succeeded has a decision `queueVersion` **lower**
than the pause's own queue version (read from the `session.pause` audit row), and no decision with a patient exists at
or after that version; then six further call-next requests after the pause has committed (and the held patient was
finished) all return `409 SESSION_NOT_CALLABLE`.

|                                                              | Run 1 | Run 2 | Run 3 |
| ------------------------------------------------------------ | ----: | ----: | ----: |
| Rounds where a call committed before the pause               |    18 |    16 |    16 |
| Rounds where the pause committed first (no call won)         |     2 |     4 |     4 |
| Successful calls serialised **after** the pause              |     0 |     0 |     0 |
| Calls after the committed pause (all `SESSION_NOT_CALLABLE`) |   120 |   120 |   120 |
| 5xx                                                          |     0 |     0 |     0 |

### 5. Same Idempotency-Key, 10 parallel call-next, 5 trials per run

All 10 responses are `200`, name the same entry and the same decision id; exactly one decision row exists for it and
exactly one entry is called. 5 of 5 trials in each of the 3 runs.

## Limitations

- **Real clock, relative order.** Table 8 is reproduced by the order of events and by eligibility relative to
  "now", not by the report's 09:00 to 09:54 timestamps. Aging (45 minutes) cannot be exercised over a black-box HTTP
  test without waiting 45 real minutes; it is covered by the injected-clock API tests and the domain tests.
- **Polling cannot see an uncommitted violation.** At READ COMMITTED the poller only sees committed state; the partial
  unique index `queue_entries_doctor_active_uq` is the backstop that makes a second active row impossible, and the
  doctor lock makes the loser fail cleanly instead of hitting it. The 0 means "never observed", plus the index.
- **Local numbers.** Same-machine load generator, localhost database, 30-way concurrency. The hosted environment
  (Cloud Run + Cloud SQL) and larger fan-outs were not tested. Pause and transition races are randomised, so the split
  between outcomes differs from run to run (shown above); the pass criteria are invariants, not the split.
- **Three runs** were done after the last edit of the suite; that is the sample behind "no flakiness observed", not a
  statistical bound on flakiness.
