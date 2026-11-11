# End-to-end: book, check in, call, start, complete (real stack, keyboard only)

Evidence for report section 5.6 (system flow), NFR-08-b (booking and call-next by keyboard alone) and the live-update
half of FR-09. Everything marked **measured** comes from the runs described here. No target is claimed as achieved.

## Purpose

Drive one complete visit through the real user interface, as four people at once, against the real API and a real
PostgreSQL, with nothing mocked:

patient books today's session -> reception finds the patient and checks them in -> the waiting-room display shows the
token as next -> the doctor calls next and sees why -> the display shows it as Now calling and the patient's My visit
page says "It is your turn" -> the doctor starts and completes -> the patient's page says "Your visit is complete".

## Environment (this machine; not the hosted environment)

| Item      | Value                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Host      | cloud sandbox VM, Linux 6.18.44, 4 vCPU (Intel Xeon @ 2.10 GHz), 16 GB RAM                                                           |
| Node.js   | v22.23.4; PostgreSQL 16.15 on `localhost:5432`                                                                                       |
| Database  | scratch database `hqms_e2e_test`, dropped, created, migrated and seeded (demo seed) at the start of every run                        |
| API       | `apps/api/dist/main.js` (built by the run), port 3188, `NODE_ENV=test`                                                               |
| Web       | Vite dev server of `apps/web` on port 5188 with its `/api` proxy (D-013) pointed at that API (`API_URL`); **not** a production build |
| Browser   | Chromium 153 (Playwright 1.63.0, headless), four separate browser contexts                                                           |
| Viewports | patient 390 x 844 (device scale 2), reception and doctor 1440 x 900, waiting-room display 1920 x 1080                                |
| Worker    | not running                                                                                                                          |
| Date      | 2026-11-11                                                                                                                           |

## Method

- `pnpm e2e` runs `playwright test --trace off` in `tests/`. `tests/e2e/stack.ts` (global setup) creates and seeds the
  database, builds and starts the API, starts Vite, waits for both, and stops them afterwards. The spec is
  `tests/e2e/full-visit.spec.ts` (the earlier mock-based specs in `apps/web/e2e` are unrelated and unchanged).
- **Fixture (API and SQL, before the first UI step).** The seed already has the doctor's morning and afternoon sessions
  today. Those are closed by SQL, and a fresh "evening" session for Dr. Suresh Hegde (OPD 1) is created through the admin
  API and opened. It started 16 to 17 minutes before the run: its first slot is past the 15-minute grace (not
  bookable), the second slot is 3 to 4 minutes in the future (the patient gets it: "a session today that has a future
  slot") and is already eligible (early eligibility is 10 minutes), so call-next can allocate it at once.
- **Keyboard only** (`page.keyboard` only, no `click` or `fill`): login of all four roles; the patient's whole booking
  (Tab to the Book link, arrow keys to choose department, doctor, day, session, Enter to continue, Tab to "Book
  appointment", Enter); reception's search and check-in (`/`, type, Enter); the doctor's call, start and complete
  (`N`, Enter, then Enter on the focused Start and Complete). Tab order was driven with a helper that fails if a control is
  unreachable.
- **Not keyboard-driven (declared):** page URLs are opened with `goto` (the display, and the patient's My visit page, see
  finding 2); on the reception desk the doctor picker and the session tab are clicked once (the keyboard requirement of
  NFR-08-b is for check-in, which is keyboard only); the final SQL read-back.
- After the UI steps the test reads the database: visit, queue entry and appointment are `completed`; one decision row
  (`ROTATION`, policy 1, "Called by rotation: 1st appointment of A, A, W"); the audit trail is exactly `appointment.book (patient)`,
  `visit.check_in (reception)`, `queue.call_next (doctor)`, `consultation.start (doctor)`, `consultation.complete (doctor)`;
  the doctor has no called or in-service entry left. It also fails on any 5xx response or uncaught page error in any
  of the four pages.

## Commands

```
pnpm e2e                       # builds the API, starts the stack, runs the spec, writes screenshots and the raw JSON
SKIP_API_BUILD=1 pnpm e2e      # reuse an existing apps/api/dist
```

Overrides: `E2E_API_PORT`, `E2E_WEB_PORT`, `E2E_DB_NAME`, `TEST_ADMIN_DATABASE_URL`, `PW_CHROMIUM_PATH`.
Raw numbers of the last run: `docs/evidence/e2e-full-visit.raw.json`.

## Results (measured)

**1 of 1 test passed in each of 3 consecutive runs** (8 to 10 s for the test, 11 to 13 s with start-up and tear-down). No
flakiness observed in those runs (3 runs are not a bound on flakiness). No 5xx response and no page error in any run. The
only 4xx responses are the `401 GET /api/me` probes every page makes before it has a session (expected).

Observed UI-level latencies (one visit per run, three runs, clients on the same machine as the server, SSE poll 500 ms):

| Interval (from the doctor's Enter)                        |  Run 1 |  Run 2 |  Run 3 |
| --------------------------------------------------------- | -----: | -----: | -----: |
| call -> token shown as Now calling on the display         | 270 ms | 157 ms | 361 ms |
| call -> patient's page shows "It is your turn"            | 369 ms | 231 ms | 430 ms |
| complete -> patient's page shows "Your visit is complete" | 855 ms | 351 ms | 402 ms |

These include Playwright's polling and the snapshot refetch, and are n = 3 single observations, not a distribution.

### Screenshots (viewed)

`docs/evidence/screenshots/`: `e2e-01-patient-choose-session-390.png`, `e2e-02-patient-confirm-390.png`,
`e2e-03-patient-booked-390.png`, `e2e-04-reception-checked-in-1440.png` (token A-001 shown), `e2e-05-display-waiting-1920.png`,
`e2e-06-patient-waiting-390.png`, `e2e-07-doctor-called-1440.png` (decision reason in words), `e2e-08-display-now-calling-1920.png`,
`e2e-09-patient-called-390.png`, `e2e-10-doctor-in-service-1440.png`, `e2e-11-patient-in-service-390.png`,
`e2e-12-doctor-completed-1440.png`, `e2e-13-patient-completed-390.png` and `e2e-14-display-after-1920.png`
(regenerated on the final tree; the finding-1 screenshot was removed once the display was fixed).

## Findings (status on the final tree)

All three findings below were fixed after this file was first written; the spec now asserts the fixed behaviour.
- Finding 1: fixed in the review fix pass (D-028): the public display lists only in-window sessions and pages through at
  most 6 columns; the spec asserts ≤ 6 columns. The rerun also caught a regression from the display's new 1 s cache
  ("Now calling" stayed on a completed patient), fixed by validating the cache against session versions (D-030).
- Finding 2: fixed in the W3 web merge: the "Today" tab lists today's appointments with a link to "My visit".
- Finding 3: fixed (authz public set includes the tokens-only display routes).

Original text:

1. **Display with the demo seed is unreadable.** The seed leaves about 20 morning and afternoon sessions `open` for today,
   including morning sessions whose end time has passed, and the display draws one column per open session. With 21 columns
   at 1920 x 1080 the room names are truncated to "OP...", the "Now calling" and "Next" labels overlap and tokens are
   clipped (screenshot `e2e-finding-display-with-seeded-sessions-1920.png`). The flow above therefore closes every other
   session by SQL before the display screenshots. Possible causes to look at: sessions are never auto-closed after their
   end time, and the layout has no variant for more than about 6 columns.
2. **A patient cannot reach "My visit" from the interface.** `/patient/visit/:sessionId` exists, but the "Today" tab is the static
   "No visit today" page and "My visits" has no link to it, so the test opens the URL directly after check-in.
3. **Stale authorization test (not mine).** `tests/integration/authz.test.ts` still expects the public route set to be exactly
   login, logout and health; the W2 API added the intentionally public `GET /display/sessions` and `GET /display/events`, so
   that one test fails in `pnpm test` (see the report that accompanies this file).

## Limitations

- Vite **dev** server, not a production build (cold-start compile is part of the 11 to 13 s). The production nginx image
  was not exercised.
- One visit, one doctor, appointment path only (group A). Walk-ins, priority, skip, pause and the follow-up loop are covered
  by the API suites, not by this flow.
- The fixture depends on the wall clock: it needs "now minus 16 minutes" to fall on the same hospital-local date (it
  fails in the first 16 minutes after 00:00 Asia/Kolkata).
- The display and patient screens were checked here at the viewports listed; the other staff screens and the 390 px
  reception and doctor layouts are covered by the existing mock-based Playwright specs in `apps/web/e2e`.
