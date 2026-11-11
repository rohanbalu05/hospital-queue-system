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
