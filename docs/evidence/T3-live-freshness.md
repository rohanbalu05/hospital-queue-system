# T3 (quick check): SSE reconnect and commit-to-client freshness, N = 50

Partial evidence for report section 5.6, Table 5, row T3 (FR-09, NFR-02). This is a **quick check with 50 clients on
one machine**, not the 200-client objective of NFR-02 and not a hosted-environment result. The ETA half of T3 (calibration of
predicted against actual start times) is not covered here. Everything marked **measured** comes from the run below.

## What is checked

1. **Reconnect.** A client that connects first receives the committed version (`eventType: "connected"`); that version equals
   `GET /sessions/:id/queue` and `sessions.queue_version`, also after the client missed two commits while disconnected, and the
   snapshot shows the post-commit state (called patient, remaining waiting tokens).
2. **Freshness.** 50 simultaneous SSE connections (doctor login) on one session; 20 cycles of call-next, start, complete, that
   is 60 commits. After each command the test records, for every client, when a notice with `queueVersion` at least the
   command's version arrived. The commands are sent after a random 0 to 600 ms pause so they are not phase-locked to the
   server's 500 ms poll (a first, phase-locked attempt measured about 485 ms for every sample, which is just the poll interval; it
   was discarded as unrepresentative and is mentioned only so the number is not mistaken for typical).

## Environment

Same machine as T1 and T2 (4 vCPU Xeon @ 2.10 GHz, Node v22.23.4, PostgreSQL 16.15 on localhost, API `dist/main.js`,
`SSE_POLL_MS` default 500, load generator and 50 SSE clients in the Vitest process). Date 2026-11-11.

## Command

```
pnpm --filter @hqms/tests test        # runs tests/integration/t3-sse-freshness.test.ts (about 35 to 40 s) with the other integration tests
```

Overrides: `T3_CLIENTS` (default 50), `T3_CYCLES` (default 20). Raw numbers: `docs/evidence/T3-live-freshness.raw.json`.

## Results (measured, one run after the last edit; an earlier run of the final code gave p50 320.5 ms, p95 484.8 ms)

Reconnect: 2 of 2 checks passed (version 3 before disconnect, 5 after two missed commits; first notice after reconnect carried
version 5 and matched the snapshot and the database).

Freshness, 60 commits x 50 clients = 3000 samples (60 independent commit instants; the 50 clients of one commit are not independent
of each other):

| Measure                                                                   |      p50 |      p95 |      p99 |      max |
| ------------------------------------------------------------------------- | -------: | -------: | -------: | -------: |
| Notice arrival minus the moment the command's response reached the client | 305.1 ms | 495.9 ms | 503.1 ms | 504.5 ms |
| Notice arrival minus the moment the command was sent (upper bound)        | 321.3 ms | 510.7 ms | 534.3 ms | 535.7 ms |

The first row is the commit-to-client proxy (the response is sent after the commit). No notice arrived before its command's
response. Every client converged on the final version (83). The values sit under the 500 ms poll interval plus a few
milliseconds, as expected from the design (one shared 500 ms poller; no LISTEN/NOTIFY, see D-025). The test's own gate is
only "p95 below 2000 ms".

## Limitations

- N = 50 clients, one session, one API instance, same-machine load generator; not the 200-client target of NFR-02.
- Latency is dominated by the configured 500 ms poll; per-command splits (20 commits each) are too small to compare.
- Display-mode SSE (`GET /display/events`) and patient-mode streams were not part of this run.
- A client's "notice" is a version hint; the time to refetch and render the snapshot in a browser is not included here (the
  end-to-end spec in `e2e-full-visit.md` gives three single observations of that, 157 to 855 ms).


---

# 200-client run (NFR-02, FR-09, FR-10)

Added after the 50-client quick check above, which is kept unchanged. Script: `tests/load/sse.ts` (`pnpm --filter @hqms/tests load:sse`; `SSE_SECONDS`, default 180, 120 used).
Raw numbers: `T3-live-freshness-200.raw.json`. Environment as in `T5-workload-failure.md` section 1 (4 vCPU shared machine, API production bundle, `SSE_POLL_MS=500`,
`DB_POOL_MAX=20`, per-IP SSE caps lifted to 1000 / 200 / 100000 because all clients share one IP, branch merged at `b87aa05`). Clients and the command generator run in one Node process.
**Targets (not results):** 200 connected clients, commit-to-client freshness p95 <= 5 s, unexpected server errors < 1%.

## Population and commands

200 live clients: **170 patient-scoped** (each logged in, one entry in one of 20 running sessions), **22 staff** (10 doctors, 6 reception, 2 admins, 4 second doctor tabs; follow-up users have no session stream route),
**8 display** (`/display/events`, public). While connected for 122 s: 10 doctor loops (call-next, start, complete) and 6 reception loops (walk-ins) with randomised think times of 0.25 to 1.5 s between commands
(no phase lock with the 500 ms server poll). 2,226 commits (18.3 per second): 768 walk-ins, 538 call-next, 536 start, 536 complete, all 200 OK. Every client refetches its snapshot after each notice, as a screen would
(`GET /sessions/:id/queue`; displays `GET /display/sessions`), so the run also contains 333,111 refetches (all 200).

## Results (measured; 39,192 commit x interested-client deliveries)

| Measure | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: |
| Command response (commit already done) to first SSE notice with version >= the commit's | 213.8 ms | 393.0 ms | 485.7 ms | 579.6 ms |
| Command sent to that notice (upper bound, includes the command's own time) | 284.4 ms | 511.0 ms | 544.8 ms | 697.9 ms |
| Command response to the first **snapshot refetch showing that version** (patients 352.6 / 562.7 ms p50 / p95; staff 388.0 / 600.0; **displays 947.3 / 1,586.1**) | 452.4 ms | 1,504.8 ms | 1,651.9 ms | 1,752.1 ms |
| Notice latency by client kind, p50 / p95: patient 213.1 / 390.1, staff 223.9 / 409.1, display 213.5 / 395.4 ms | | | | |

* **Missing events: 0** of 39,192 expected notices and 0 missing snapshots. **Stale clients: 0** (every client's last version equals `sessions.queue_version` for every session it follows). Version regressions: 0. SSE `error` events: 0. 1,600 heartbeats seen.
* **Unexpected server errors: 0** (all 2,226 commands and all 333,111 refetches returned 2xx; 0 error lines in API and worker logs). Invariant monitor: 0 violations.
* 34 notices were timestamped slightly before the client had read the command's response (clamped to 0 above); they are the response-delivery jitter of one Node process, not early commits.
* Resources during the run: API CPU mean 37.9% / max 50.4% of one core, API RSS 206 / 221 MB, PostgreSQL backends of the database 62.8% / 76.2% of a core, 20 API connections open (pool of 20, max 1 active at a sample), whole machine 66.9% / 95.5% CPU.
* The notice latency is dominated by the 500 ms poll (about uniform 0 to 500 ms plus fan-out). The refetch tail is the cost of the **display snapshot**: every commit on any open session makes every display re-read all open sessions of the day (20 here), so displays are
  the slowest path (p95 1.6 s here); this is still under the 5 s target but is the part to watch if the number of displays or sessions grows.

## Reconnect (50 clients)

50 clients (43 patient, 5 staff, 2 display) were dropped, 152 commits were made while they were away, commands were paused, and all 50 reconnected at the same instant:
**50 of 50** received a first notice with `eventType: "connected"` whose version equals the committed `queue_version` (displays: every open session's notice equals its committed version), and **50 of 50** snapshots carry the same version.
Time from connect to first notice p50 / p95 / max = 67.0 / 73.5 / 74.2 ms.

## ETA observed error (FR-10): small synthetic sample, **inconclusive by design**

Two scripted sessions (doctors 9 and 10, 10 walk-in patients each, consultation durations scripted: about 15 s, and about 24 s = 1.6x). Because the real clock cannot be sped up, the policy's initial estimate was set to 0.25 min (15 s) in the scratch database,
so the model structure (EWMA, residual of the active consultation, range) is exercised but the 12-minute calibration is not. Each patient's snapshot ETA range was compared with the time until they were actually called.

| Scenario | Predicted at check-in, actual call time inside [low, high] | Refreshed after each completion, inside range | by position (1 to 2 / 3 to 5 / 6+) |
| --- | ---: | ---: | --- |
| durations match the assumed mean | 3 of 10 | 24 of 45 (53%) | 47% / 83% / 10% |
| durations 1.6x the assumed mean | 2 of 10 | 21 of 45 (47%) | 47% / 67% / 10% |

Read this with three caveats, which make the numbers **not usable as a calibration result**: (1) the API reports ETA ranges in whole minutes, so with 15-second services the range is [0, 1] and "inside" is decided by rounding; (2) the estimator carried 64 samples from the
200-client phase for these two doctors (not a cold start, contrary to the label in the raw JSON note), mean 0.22 and 0.35 min at the end; (3) 10 patients per scenario. What it does show: predictions are produced for every waiting patient on every refresh, status `ok`,
and the long-horizon predictions (position 6 or more) are the least reliable. A real calibration needs a run in real time with the 12-minute assumption (hours) or a hosted pilot; none was done.
