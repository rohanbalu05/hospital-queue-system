# Dynamic code analysis: runtime checks performed

Syllabus item "dynamic code analysis". These are checks made while the real system ran (production bundles, real PostgreSQL, real HTTP), as opposed to
the static analysis in `static-analysis.md`. All numbers are measured on one shared 4-vCPU development machine (environment and caveats in `T5-workload-failure.md`);
none is a target and none is a hosted-environment result. Date 2026-11-11.

| Runtime check | Where | What was observed |
| --- | --- | --- |
| Concurrent real-connection races (T1, T2) | `T1-booking-collision.md`, `T2-policy-doctor-guard.md` | Not repeated here; those suites are the integrity evidence. |
| Sustained load with a documented endpoint mix | `T5-workload-failure.md` section 2 | 300 s at 100 req/s and 60 s at 200 req/s: 41,947 requests, 0 5xx, 0 transport errors, p95 14.3 and 16.5 ms. |
| Invariant monitor during load | `T5-load.raw.json` | Capacity counters vs allocations, one visit per appointment, one entry per visit, one active allocation per doctor, checked every 60 s and at the end over 514 sessions: **0 violations** in all checks (5-minute run), also 0 in the invalid 30-minute run (1,684 sessions). Row counts equalled successful responses (appointments, queue entries, completions). |
| Lock behaviour under load | sampler in `T5-load.raw.json` | PostgreSQL backends waiting on a lock: 0 at every 5-second sample in both phases; API connections idle in transaction at most 3 (mean 0.3). The `DOCTOR_OCCUPIED` 409 (1,063 in the invalid 30-minute run) is the doctor guard working, not an error. |
| Memory growth over a sustained run | `T5-load.raw.json`, `T5-load-30min-contaminated.raw.json` | 5-minute run: API RSS 151.7 to 151.9 MB (slope 0.12 MB/min, 60 samples), worker 74.8 to 75.2 MB. 30-minute run (invalid for other reasons): API RSS 156.6 to 158.9 MB (slope 0.05 MB/min, 359 samples). No growth that would indicate a leak at this rate; heap was not inspected (RSS only). |
| Live updates with 200 clients | `T3-live-freshness.md` | 0 missing, 0 stale, notice p95 393 ms, snapshot refetch p95 1.5 s (displays are the slow path), reconnect 50 of 50 correct. API RSS rose to 221 MB with 200 streams. |
| Crash of the API mid-burst | `T5-workload-failure.md` api-kill | 5 rounds of kill -9: 0 committed bookings lost, no half-written state, stored outcomes replayed, capacity exactly 10 per session. |
| Crash of the worker holding leases | worker-kill | Leases expire, jobs are re-claimed, effects applied exactly once (200 releases, 10 call timeouts). |
| Provider failure during booking load | ocr-fail | Booking latency and error rate unchanged (1,200 of 1,200 x 3 phases OK); documents end `ocr_failed` after at most 5 attempts. |
| Connection loss | db-crash, db-conn | **Defect found, F1:** the API process crashes with `Unhandled 'error' event` when PostgreSQL terminates a connection that a command has checked out (4 of 5 injection attempts; a statement killed mid-query is handled, a connection killed between statements is not; intermittent with idle-only termination). Data stayed consistent in every case. **F2:** database unavailability is reported as `500 INTERNAL` on business routes. |
| Restore drill | `T5-workload-failure.md` section 5 | Dump/restore, reconciliation checks, smoke: local RTO 2.6 s; 16.9 s of writes lost by design of the manual procedure. |

## Defects and anomalies found by the runtime checks

1. **F1 (application, not fixed here)**: unhandled `error` event on a checked-out `pg` client crashes the API (see repro in `T5-workload-failure.md` section 4). Owner: `packages/db` (`withTransaction` / `createPool`): attach an `error` listener to a client for the duration of the checkout and release it with the error.
2. **F2 (application, not fixed here)**: DB outage returns 500, not 503 + `Retry-After`, outside `/health`.
3. **Display snapshot cost**: `GET /display/sessions` recomputes every open session of the day for each display refresh (p95 about 1 s under 8 displays and 18 commits/s). Within the 5 s target in this run; grows with sessions x displays.
4. **ETA ranges are whole minutes**: with short services the range collapses to [0, 1]; the ETA calibration could not be assessed at the scaled-down time (`T3-live-freshness.md`).
5. **Unexplained process loss in the first 30-minute run** (worker at about 1,100 s, API before the burst phase, 3.3% transport errors while the API was alive). No error in the logs, not reproduced in the instrumented rerun (0 process exits, 0 transport errors in 41,947 requests). Possible external interference on the shared machine; not attributed to the application and not excluded either.
6. No deadlocks, no 5xx and no error log lines in any load, SSE or ordinary failure run apart from F1.

## Not performed

Real OCR/LLM provider latency, hosted-environment load, a 30-minute uninterrupted sustained run, long-duration availability (NFR-04), a PostgreSQL server restart, heap profiling.
