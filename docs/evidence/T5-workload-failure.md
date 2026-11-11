# T5: workload and failure exercises (NFR-01, NFR-02, NFR-04, NFR-05, NFR-07)

Evidence for report section 5.6, Table 5, row T5. **Every number below was measured on one development machine, with the load
generator, the API, the worker and PostgreSQL sharing it. None of it is the hosted reference environment, and no target is claimed as
achieved.** Where a run was shorter than the target, that is stated in the table row itself. Raw files are in this directory
(`T5-load.raw.json`, `T5-load-30min-contaminated.raw.json`, `T5-failure.raw.json`, `T5-restore-drill.raw.json`,
`T5-failure-run-log.txt`, `T3-live-freshness-200.raw.json`).

## 1. Environment (declared for every number)

| Item | Value |
| --- | --- |
| Machine | 4 vCPU Intel Xeon @ 2.10 GHz (virtual machine, kernel 6.18.44-fc), 15.7 GB RAM, no swap |
| Software | Node v22.23.4, PostgreSQL 16.15 (local, default server settings), pnpm 10.28.0 |
| Processes | API `apps/api/dist/main.js` and worker `apps/worker/dist/main.js` (production bundles), `NODE_ENV=production`, PostgreSQL, and the generator (one Node process), all on this machine |
| API settings | `DB_POOL_MAX=20` (declared pool size), `SSE_POLL_MS=500`, `LOGIN_RATE_LIMIT_MAX=1000000`; per-IP abuse caps lifted because every client comes from one IP (`SSE_MAX_PER_IP=1000`, `SSE_MAX_DISPLAY=200`, `DISPLAY_RATE_LIMIT_PER_MIN=100000`; the first 30-minute run predates these caps) |
| Providers | identity `local`, object storage `local-disk`, OCR `fake`, LLM `fake`. **No real OCR or AI latency is measured here**; the fake adapters answer in microseconds, so nothing in this file says anything about Google Vision or Gemini latency (report NFR-01 asks for that to be measured separately in the hosted environment). |
| Neighbours | The machine is shared. Other agents ran test suites on the same PostgreSQL server and CPUs during these runs (the samplers record other databases at up to roughly 1,400 transactions/s in single seconds and whole-machine CPU peaks of 62% to 99%). Treat the latencies as "on a busy shared 4-vCPU box". |
| Code measured | Run 1 (30 min, contaminated): commit `496bcdf`. Run 2 (5 min + 60 s), the SSE, failure and restore runs: branch `claude/wonderful-galileo-2es87v` at `30ef445` merged into this branch (`b87aa05`), which includes the API fix pass (abuse caps, audit append-only migration 0006). |
| Date | 2026-11-11 |

## 2. NFR-01 load (`pnpm --filter @hqms/tests load`)

### Method

Open-loop generator (constant arrival rate; requests are issued on schedule whether or not earlier ones finished, so slow responses
do not slow the offered load; scheduler lag p99 was 2 ms and 2.8 ms). Latency is measured at the client from send to the body being read, per request.

**Documented endpoint mix** (share of all requests; the three queue commands are the three requests of one cycle):

| Class | Share | Request |
| --- | ---: | --- |
| snapshot_patient | 48% | `GET /sessions/:id/queue` as one of 170 logged-in patients (their own entry, with ETA) |
| snapshot_staff | 12% | `GET /sessions/:id/queue` as a doctor |
| appointments_list | 15% | `GET /appointments` as a patient |
| sessions_list | 10% | `GET /sessions?date=today&doctorId=` as reception |
| book | 5% | `POST /appointments` (reception, distinct patient per session, future sessions, fresh `Idempotency-Key`) |
| check_in | 2.5% | `POST /appointments/:id/check-in` |
| walk_in | 2.5% | `POST /sessions/:id/walk-ins` |
| call_next, start, complete | 1.67% each (5% in total) | doctor cycles: `POST /sessions/:id/call-next`, `/visits/:id/start`, `/visits/:id/complete` |

**Dataset.** 10 doctors, the seed (22 staff, 40 demo patients), plus 10,000 synthetic patients inserted by SQL with 170 patient logins
(Table 3). 20 "read" sessions (10 doctors x 2, capacity 10 + 5) hold the 170 patients' entries. Write classes draw from supply sessions
created before the run: future-dated booking sessions (capacity 10), today's walk-in sessions (walk-in capacity 50) and today's check-in
sessions (booked capacity 25, appointments booked beforehand). Their capacities and counts are larger than Table 7 so that a 5% write
share can be sustained for the whole run; this is a declared deviation. Dataset at the start of the 5-minute run: 10,040 patients,
202 users, 514 sessions (124 dated today), 1,525 appointments, 170 queue entries. Before the 30-minute run: 1,684 sessions, 6,025 appointments.

Warm-up: 20 s at 50 req/s, excluded. Samplers: `/proc` CPU and RSS of API and worker, PostgreSQL backends of the test database (CPU, RSS,
state and lock waits from `pg_stat_activity`), API connections open/active/idle-in-transaction, whole-machine CPU, every 5 s. Invariant monitor
(capacity counters vs allocations, one visit per appointment, one entry per visit, one active allocation per doctor, ...) every 60 s and at the end.

### Results

| Run | Target (report NFR-01, not a result) | What was run | Measured |
| --- | --- | --- | --- |
| (a) sustained | 100 req/s for 30 min, ordinary API p95 <= 500 ms | **300 s at 100 req/s** (the 30-minute run was attempted and is invalid, see 2.2). Not extrapolated. | 29,978 requests, 99.9 req/s achieved. Overall p50 / p95 / p99 = 6.9 / 14.3 / 19.8 ms (max 101 ms). Reads p95 10.3 ms, writes p95 19.9 ms. 0 unexpected errors (all 2xx). |
| (b) burst | 200 req/s for 60 s, p95 <= 1 s | **60 s at 200 req/s** (run directly after (a)) | 11,969 requests, 199.5 req/s achieved. Overall p50 / p95 / p99 = 7.0 / 16.5 / 25.5 ms (max 80 ms). Reads p95 12.3 ms, writes p95 25.6 ms. 0 unexpected errors. |

The 30-minute duration of target (a) is **not demonstrated**. The 5-minute result says nothing about behaviour after 30 minutes except through the
contaminated run in 2.2.

Latency per endpoint class (ms; n = requests):

| Class | (a) n | (a) p50 | (a) p95 | (a) p99 | (b) n | (b) p50 | (b) p95 | (b) p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| snapshot_patient | 14,450 | 7.0 | 10.4 | 15.1 | 5,753 | 7.0 | 12.8 | 19.2 |
| snapshot_staff | 3,514 | 8.2 | 12.6 | 17.1 | 1,448 | 8.4 | 14.9 | 23.1 |
| appointments_list | 4,541 | 3.4 | 5.4 | 8.6 | 1,836 | 3.4 | 6.9 | 13.9 |
| sessions_list | 2,987 | 4.1 | 6.0 | 9.7 | 1,164 | 4.0 | 7.4 | 13.7 |
| book | 1,552 | 10.8 | 18.3 | 25.3 | 593 | 12.1 | 24.9 | 35.9 |
| check_in | 715 | 13.7 | 22.8 | 28.0 | 311 | 14.8 | 26.4 | 38.0 |
| walk_in | 749 | 12.4 | 19.7 | 27.1 | 309 | 14.1 | 26.5 | 35.1 |
| call_next | 490 | 14.6 | 23.3 | 29.2 | 185 | 15.5 | 24.8 | 30.1 |
| start | 490 | 10.0 | 17.2 | 22.7 | 185 | 10.7 | 22.2 | 31.8 |
| complete | 490 | 9.9 | 18.4 | 30.4 | 185 | 10.8 | 23.4 | 31.8 |

Status distribution (both runs): 2xx = 100%; expected 4xx conflicts (409) = 0; other 4xx = 0; 5xx = 0; transport errors/timeouts = 0.
(The 409 `DOCTOR_OCCUPIED` category seen in the invalid 30-minute run was 1,063 of 2,970 call-next attempts there and is the only expected-409 class in this mix.)

Durability check per phase (a response is only sent after the commit): appointments created = 201 responses to `book` (1,552 / 593);
queue entries created = successful check-ins + walk-ins (1,464 / 620); completed entries = completed cycles (490 / 185). All equal. The invariant monitor found
0 violations in every check (3 checks in (a), 1 in (b), plus the final one over 514 sessions).

Resources (this machine, mean / max over 5-second samples):

| | (a) 300 s at 100 req/s | (b) 60 s at 200 req/s |
| --- | --- | --- |
| API process CPU (percent of one core) | 26.8 / 29.8 | 46.9 / 58.4 |
| API RSS | 151.8 / 152.2 MB | 135.0 / 136.2 MB |
| Worker CPU / RSS | 0.7% / 75 MB | 0.8% / 75 MB |
| PostgreSQL backends of this database, CPU (percent of one core, sum) | 31.6 / 36.0 | 60.5 / 64.8 |
| API connections open / active / idle in transaction (pool of 20) | 3.9 (max 8) / 0.2 (max 1) / 0.3 (max 3) | 8 / 0.6 (max 2) / 0.5 (max 2) |
| Backends waiting on a lock | 0 | 0 |
| Load generator CPU | 11% | 17% |
| Whole machine CPU | 29.5% / 61.8% | 44.7% / 65.1% |

(PostgreSQL backend RSS in the raw file includes shared memory and is not an additive figure.) Pool waits inside the API are not observable with the
current build (no pool metrics); open connections stayed far below the pool size of 20, so there is no sign of pool saturation.

### 2.2 The 30-minute run (invalid, kept as raw evidence)

`T5-load-30min-contaminated.raw.json`, commit `496bcdf`, 100 req/s planned for 1,800 s (177,611 requests), then 200 req/s for 60 s. **It must not be read as a
30-minute result**: the worker process disappeared at about 1,100 s with no error line in its log; 5,894 requests (3.3%) failed with transport errors
(`fetch failed`, cause not recorded in that version of the script) while the API was still sampled as alive; and the API process was gone before the 200 req/s phase began
(every request of that phase failed). The API log contained no error line, which fits an external kill, but the cause was not established and could not be reproduced; the
5-minute rerun (with process-exit and per-10-s error instrumentation added) had no such events. What the 30-minute data still shows, for the part where the processes were alive:
for successful requests overall p50 / p95 / p99 were 6.6 / 15.5 / 25.3 ms (the percentiles include the sub-millisecond failed requests), 1,063 expected 409s, 0 5xx, 0 invariant violations,
**API RSS 156.6 MB at the start and 158.9 MB at 1,795 s (max 160.2 MB; least-squares slope 0.05 MB/min over 359 samples)**, worker RSS flat (79 to 76 MB) while it lived. Treat it as a weak indication of no
memory growth over 30 minutes at this rate, not as a pass of target (a).

## 3. NFR-02 and T3 with 200 clients

See `T3-live-freshness.md` (section "200-client run"). Summary: notice freshness p50 / p95 / max = 214 / 393 / 580 ms, 0 missing notices, 0 stale clients, 0 unexpected server errors, reconnect 50 of 50 correct.

## 4. NFR-07 failure injection (`pnpm --filter @hqms/tests failure`)

Each scenario uses its own scratch database (`hqms_fail_*`), the real API and worker processes started from the production bundles, and real PostgreSQL. PostgreSQL itself was never restarted
(other sessions share it); database loss is simulated with `pg_terminate_backend` and `ALTER DATABASE ... ALLOW_CONNECTIONS false` on the scratch database only. Run log with every execution: `T5-failure-run-log.txt`.

| Scenario | Method | Measured result |
| --- | --- | --- |
| **api-kill** (kill -9 of the API during bookings) | 5 rounds; each: 3 sessions of 10 places, 90 booking requests (30 in flight) with fixed Idempotency-Keys, `kill -9` of the API after about 20 answers, check, restart (about 0.5 to 0.65 s to healthy), replay of **every** request with its original key and body | 145 requests in flight at the kills in total, 345 without a response, **2 commits that were never answered** (committed, response lost); **0 committed bookings lost**; 0 half-written states right after each crash (no open transaction, invariants clean); the replay returned the stored outcome (same appointment id) for every committed key; every session ended with exactly 10 bookings by 10 distinct patients; one audit row, one `AppointmentBooked` event and one timer job per appointment; replay statuses 201 x30 and 409 x60 per round, no 5xx. The login cookie of the killed process worked against the new one. 35 of 35 checks passed. |
| **worker-kill** (kill -9 of the worker holding leases) | 200 `reservation_release` and 10 `call_timeout` jobs due at once; worker killed 438 ms after start with 3 to 4 jobs in state `running`; restart | While down nothing advanced (29 of 200 appointments had been released). After restart all 210 jobs reached `succeeded` in 2.0 s (lease 3 s in the test, 3 jobs ran twice: `attempts` = 2), 0 dead. Effects exactly once: 200 appointments `missed` at version 2, 200 audit rows (200 distinct entities), 200 `ReservationReleased` events; 10 entries `skipped`, 10 `call_timeout` audit rows (10 distinct), 10 `QueuePatientSkipped` events; released capacity counters 0; invariants clean. 7 of 7 checks passed. Shortcuts declared: `called_timeout_sec` = 3 s, appointment slots moved into the past by SQL so that the timers are due, `WORKER_LEASE_SEC=3`. |
| **ocr-fail** (OCR provider failing during booking) | 30 req/s of bookings for 40 s three times: baseline, with the OCR fixture `fail` and 2 uploads/s (79 documents), baseline again | Booking latency p50 / p95 / p99: baseline-1 12.3 / 18.9 / 23.7 ms, OCR failing 12.5 / 20.4 / 29.5 ms, baseline-2 12.0 / 17.2 / 23.5 ms (p95 ratio failing / mean of baselines = 1.13). 1,200 of 1,200 bookings returned 201 in each phase; 0 errors. The 79 documents ended `ocr_failed` after at most 5 attempts (79 dead jobs, 395 `DocumentOCRFailed` events); upload requests themselves answered 201 in p95 32.5 ms; afterwards a good document on the same worker reached `ocr_ready` in 0.5 s. 5 of 5 checks passed. The difference between phases is within the variation between the two baselines on this shared machine. |
| **db-crash** (connection terminated while checked out) | 200 bookings, 16 in flight; `pg_terminate_backend` on the API's backend that was idle inside a transaction (between two statements of one command) | **The API process crashes** (finding F1). After a restart (0.65 s) the replay of all 200 keys gave 201 x60 and 409 x140, each session exactly 10 booked, invariants clean. 4 of 5 checks passed; the failing one is "API survives". |
| **db-conn** (database connections lost) | 30 req/s (60% snapshot GET, 40% booking) for 70 s: terminate idle API pool connections at 10 s; database closed to new connections for 8 s at 25 s with idle connections terminated every 100 ms; 10 more terminations at 48 s | Three executions completed (a fourth stopped on a harness bug). The first terminated backends in any state and **crashed the API**; of the two that terminated only idle pool connections, **one crashed the API too and one survived** (finding F1; the crash is intermittent). The execution in which the API survived (log lines in `T5-failure-run-log.txt`): errors during the 8 s outage were 240 responses `500 INTERNAL` with a JSON error body (no hangs, slowest 35 ms, 0 transport errors), the first success came in the same second the database reopened, all 95 failed bookings succeeded on idempotent retry (201), no duplicate or lost booking (894 appointments = 879 idempotency records + the 15 seeded demo appointments; the check as written counted the seed and reported FAIL in that run, the script was corrected afterwards and not rerun to a surviving API), invariants clean, worker alive. The raw JSON in `T5-failure.raw.json` holds the **last** execution, which crashed (368 retries to a dead API were refused). |

Findings from failure injection (bugs in the application, not fixed here; repro in `T5-failure.raw.json` under `dbCrash` and by the command above):

* **F1, API crashes when a PostgreSQL connection is terminated while a command holds it.** `Unhandled 'error' event` on a `pg` `Client` (`Connection terminated unexpectedly`) takes down the Node process.
  `createPool` registers `pool.on('error')` for idle clients (that works: "[hqms/db] idle client error" is logged and survives), but a client that has been checked out by `withTransaction`/`pool.connect()` has no `error` listener while it is between two statements. Repro: run the API, start
  a booking load, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'hqms-api' AND state = 'idle in transaction'`. A PostgreSQL restart, failover or an idle-in-transaction timeout would do the same. Consequence for NFR-07: committed data is safe (verified), but the process must be restarted by a supervisor (compose `restart:` policy / Cloud Run), and in-flight requests of all clients fail, not only the one on that connection.
* **F2, database unavailable answers `500 INTERNAL` on business routes** (only `/health` answers 503). Controlled and JSON, but a retry-aware client cannot distinguish "database down" from a bug; 503 with `Retry-After` would be the expected mapping.

## 5. NFR-05 restore drill (`bash tests/failure/restore-drill.sh`)

Procedure: `docs/runbook.md` sections 7.1 and 7.3 (source run), local PostgreSQL 16 and local-disk storage on one machine. Raw: `T5-restore-drill.raw.json`; archive listing: `T5-restore-drill.archive-listing.txt` (8 real files, 1.6 MB archive).

| Step | Measured |
| --- | --- |
| Dataset | 1,540 patients, 171 sessions, 315 appointments, 8 queue entries, 8 documents (6 PDF, 2 PNG, about 200 KB each, all `ocr_ready`), 391 audit rows, 301 open jobs at backup |
| Backup | `pg_dump -Fc` 176 ms (410,810 bytes), then `tar czf` of the storage directory 81 ms (1,602,819 bytes, 8 files) |
| Last committed write before the backup | 2026-11-11T13:54:25.670Z. Then 10 more bookings (last at 13:54:27.482Z), 15 s quiet, failure at 13:54:42.572Z (kill -9 api and worker, `DROP DATABASE`, storage directory deleted) |
| Restore | `pg_restore` into a new database 479 ms; storage restore 18 ms; API healthy on the restored database after another 485 ms |
| Reconciliation | `reconcile_uploads` job succeeded (405 ms); migrations 6 applied = 6 files, latest `0006_audit_append_only`; capacity counter mismatches 0; doctors with two active allocations 0; global invariant violations 0; documents 8, objects in storage 8, missing objects 0, size/hash mismatches 0, orphan objects 0; `call_timeout` jobs for the vanished session state cancelled (3) |
| Smoke | `scripts/smoke.mjs` against the restored database: 9 of 9 checks passed |
| **Local RTO** (failure instant until smoke passed) | **2.6 s** for this dataset, automated, excluding detection time and any human step |
| **Data loss in this local procedure** | Appointments after restore 315 = the 315 at backup: everything up to the backup is present. The **10 bookings (13 audit rows) written after the backup are lost**. Loss window = last write retained (13:54:25.67) to the failure (13:54:42.57) = **16.9 s**; it equals the time between backup and failure because this procedure has no continuous log shipping. |

Not measured: the hosted procedure (Cloud SQL point-in-time recovery, bucket object versions) and therefore **RPO <= 15 min and RTO <= 60 min of NFR-05 are untested targets**; the figures above only show that the local dump/restore mechanics, the reconciliation checks and the smoke test work and are fast for a 410 KB database.

## 6. NFR-04 availability: method only, not measured

No availability figure exists and none is claimed. Method (report 5.4): declare the operating hours (8 h/day x 30 days = 240 h; 99.5% allows 72 minutes of downtime);
run the compose stack (or the hosted reference) for a real period with an external probe that calls `GET /health` and `GET /sessions?date=today` as a logged-in doctor every 30 s during operating hours;
count a probe as down when it fails or exceeds 5 s; record scheduled maintenance separately; compute `1 - downtime / operating time` from the probe log, and report incidents from `docs/runbook.md` section 6 with start/end times. A single-host local run or the load tests above do not measure NFR-04.

## 7. Limitations

* One machine, shared with other work; generator, API, worker and database compete for 4 vCPUs. Absolute latencies would differ on the hosted environment.
* The sustained target was exercised for 5 minutes, not 30. Memory-growth statements rest on the invalid 30-minute run (weak) and the 5-minute run (slope 0.12 MB/min, 60 samples).
* Supply sessions use larger capacities than Table 7 (declared); patients are reused across different sessions during the run.
* Fake OCR/LLM: provider latency is not measured. The OCR failure is a deterministic fixture, not a provider outage with timeouts.
* The worker-kill scenario shortens timers (declared) and the api-kill window for a "committed but unanswered" request is narrow (2 observed in 5 rounds).
* PostgreSQL was not restarted; connection loss was injected per database.
