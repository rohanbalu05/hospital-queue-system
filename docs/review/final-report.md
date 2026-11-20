# Session 3 final report: real-world features after the review was rejected

Branch `claude/pensive-goodall-kb6473`, built from `250c691` (main after PR #1). The teacher rejected the review because
important real-world features were missing. This session reviewed the product as each real user, built what was missing,
proved it with tests, and made the demo work on Windows and macOS from a fresh clone at any time of day.

All numbers below are **measured** on this branch in this session; nothing is a target. Product tree verified at
`0290d6d` (later commits change only `docs/`). The regenerated evidence files carry their own commit and timestamp.

## 1. How the work was done

1. **Phase A, persona review** (`docs/review/persona-review.md`): every portal used as that person at 1440 and 390 px
   against the running stack, plus the 10 real-world scenarios. 49 findings (4 P0, 25 P1, 20 P2) plus 1 pass.
2. **Phase B, build**: contracts and migrations first (orchestrator), then up to 4 builders in parallel worktrees
   (api, worker, web staff, web patient, devops, test), each test-first (a failing test committed before the fix),
   merged and re-verified on the integration branch after every hand-back.
3. **Reviews**: a read-only concurrency/security review of all server changes (no P0; 2 P1 + 10 P2, fixed or accepted
   in D-039) and a real-stack e2e run that found 5 more defects (fixed).
4. **Phase C**: `pnpm verify`, `pnpm test:concurrency`, `pnpm e2e` (twice), evidence regeneration.

Decisions taken this session: `DECISIONS.md` D-032 .. D-039. Migrations added: 0008 .. 0011.

## 2. Features added

### B1. Doctor availability lifecycle (P0)
- **Step away** (doctor; reception and admin can set it for the doctor) with a reason (Ward round / emergency, Break,
  Meeting, Other) and an expected return (10 / 15 / 30 / 60 min or a custom IST time). Status **Away**. Call next is blocked
  (409 SESSION_NOT_CALLABLE) and the queue order and rotation pointer are kept. **Change return time** updates it.
- Refused while a patient is called but not started (409 DOCTOR_OCCUPIED: the 2-minute timeout would skip them while the
  doctor is gone) and when the return is after the session end ("mark unavailable instead").
- **I'm back** → Available; the next call is the patient who was next before the break (proved in API and e2e tests).
- **Unavailable for rest of session** is a separate destructive action behind a confirmation that states the consequences.
  Admin can **Reopen** a mistaken one before the session ends (patients already moved stay moved).
- Doctor console, reception board, patient Today / My visit and the waiting-room display all show the state live over
  SSE. Wait estimates start no earlier than the expected return; an overdue or open-ended absence withholds the ETA with
  a plain reason. All transitions use the shared transaction helper and lock order and are audited.
- One definition for every screen: `deriveAvailability` in `packages/contracts` (Away = the `paused` state, D-032).

### B2. Notifications (P0)
- **Notification centre for every role**: bell with unread count, list (newest first, severity word, IST time),
  **Open** (deep link), **Mark as read**, **Mark all as read**; keyboard and 390 px friendly.
- Worker fan-out for away / back / unavailable / reopened to (a) checked-in waiting patients, (b) booked patients who have
  not arrived, (c) reception assigned to that doctor; (d) the display shows a banner from its live snapshot. Also patient
  transfers and follow-up replies.
- Patient banners on Today / My visit with the expected return and the updated wait; reception banner and the list of
  affected patients; display banner "Dr X is temporarily away, expected back about hh:mm".
- Outbound **SMS / email** through a `NotificationProvider` adapter, **fake by default** (no keys): delivery rows are queued
  with the notification in one transaction and sent by the worker's `deliver_notification` job outside any transaction,
  with retries. Admin **Notifications sent** log with masked addresses. One SMS per recipient even when relatives share
  a phone (D-039).

### B3. Doctor unavailable for the rest of the session (P0)
- Booked patients are told and offered **Rebook with another doctor** (same department, next valid slot, one click) or
  **Cancel appointment**.
- Reception **Affected patients**: checked-in and booked-not-arrived lists, a target session of another doctor, **Move N
  patients**; capacity rules apply per patient (a full target skips the rest with a reason). Checked-in patients are
  transferred keeping their group and original times; booked patients are rescheduled keeping any follow-up link.
  Batch idempotency, lock order doctors → sessions → capacities by id, a real-Postgres race test (no over-allocation, nobody
  moved twice).

### B5. Demo robustness
- `scripts/demo-session-now.mjs` ensures a running session for `doctor@hqms.test` **and** `doctor2@hqms.test` (both General
  Medicine) at any hour, labelled by time of day (`morning` / `afternoon` / `evening` / new `night`; no "Evening" at 10 am),
  never overlapping another session; run automatically by both launchers; 10 `node --test` cases for its decision logic.
- **`start-demo.sh` (macOS, Homebrew postgresql@16)**: starts the service, creates the `postgres` role with password
  `postgres` if needed, creates the databases, installs, resets demo data, starts everything, opens the browser, stops
  cleanly on Ctrl+C. `start-demo.bat` kept for Windows. README has exact fresh-clone steps for macOS, Windows and Linux.
- `docs/demo/DEMO.md`: the exact demo click path, including away/back, unavailable/rebook/move and notifications.

### B6. Persona-review fixes (every P0 and P1 not covered above)
Worker starts without `DATABASE_URL` in development and writes heartbeats; `/health` and an admin **Background work** panel
show a dead worker (PR-01/02). A clinical priority makes a present patient callable now (PR-29). Admin creates (with
repeat), opens, closes and reopens sessions; overlaps are refused (PR-30/40/41). Admin staff lifecycle: create with a
one-time temporary password, deactivate/activate, reset password (PR-42). Reception **patient desk**: book, cancel and
reschedule for a patient, including desk-registered patients (PR-21); duplicate-patient warning (PR-22); walk-in full →
other doctors of the department today (PR-23). Doctor **Create follow-up** for the current / just-completed patient
(PR-32). Red-flag symptom questions get fixed 108 / Emergency advice first and an urgent task due in 2 h (PR-13). Follow-up
staff see the patient's phone, MRN and doctor and send a reply the patient reads (PR-14/38). Offline/stale banners on
live screens (PR-04); no error page before check-in (PR-08); away return time and a consistent unavailable message on the
patient screens (PR-10/11/12). Plus the cheap P2s listed in the review's disposition table.

## 3. Defects fixed

| Defect | Fix | Test |
| --- | --- | --- |
| Reception Enter race checked in a row that did not match the search (PR-20, P0) | Enter and Check in act only on results for the current query; a fast Enter waits for them instead of being dropped | `ArrivalEnter` unit tests; e2e full visit |
| Stale account-scoped cache after the session expires (PR-05) | Every account-scoped query cleared on 401 / logout / user change; "Your session has ended" | web unit test: user A's data never renders for B |
| "New version of" instruction verify returned 400 (PR-33) | Web sends `expectedCurrentVersionId`; 409 shows a refresh prompt; API 400 names the field | web + api tests |
| Walk-in patient's Today said "No visit today" (PR-07) | `GET /me/visits/today`; Today shows walk-in / late / transfer visits | api + web tests |
| Live sync version race | Never go back to an older queue version; a notice that arrives mid-fetch triggers another fetch | `liveRace`, `monotonic` unit tests |
| Reschedule lost the follow-up link (PR-37) | Link kept and the task's return pointer moved in the same transaction | api test |
| Booking at 10:45 got the 10:30 slot, Missed at once (PR-09) | Slot assignable only if `slot + grace >= now + 10 min`, for booking, reschedule, rebook, move and the slots list (D-035) | api tests at 10:44:30 / 10:45 / 10:46 |
| Found by the real-stack e2e | Display banner leaked the department; stale Affected list; dropped Enter; moved patient's original appointment read "Checked in"; doctor console could open a closed session | unit + api tests (polish merge) |
| Found by the security review (D-039) | Shared-phone SMS dropped; red-flag negation; move batch idempotency; admin lock order; stale fan-out; rate limits; alternatives scope | api, worker, providers tests |
| Flaky worker test | Jobs inserted without `runAt` are due 1 s ago (DB µs vs JS ms clock) | 6/6 repeated runs green |

## 4. Tests (measured)

`pnpm verify` on the final product tree: **green** (typecheck, ESLint, dependency-cruiser, all unit and integration
suites, Semgrep).

| Package | Tests | Result |
| --- | --- | --- |
| @hqms/api | 303 | pass |
| @hqms/web | 314 | pass |
| @hqms/providers | 218 | pass |
| @hqms/domain | 135 | pass |
| @hqms/worker | 132 | pass |
| @hqms/db | 83 | pass |
| @hqms/contracts | 12 | pass |
| tests: black-box integration | 58 | pass |
| tests: simulation | 16 | pass |
| **Total in `pnpm verify`** | **1,271** | **pass** (775 at the start of the session) |
| `pnpm test:concurrency` (real Postgres, parallel connections) | 19 | pass (T1 incl. new bulk-move races, T2 incl. pause race per D-032) |
| `pnpm e2e` (real stack: Postgres, API, worker, web; nothing mocked) | 3 | pass, two consecutive runs |
| `node --test scripts/demo-session-now.test.mjs` | 10 | pass |

Mocked Playwright screen specs in `apps/web/e2e` were run by each UI builder for the screens they changed (not part of
`pnpm verify`). Coverage per package: `docs/evidence/unit-tests.md` and `coverage-summary.json` (regenerated this session).

## 5. Static analysis (measured)

| Tool | Result |
| --- | --- |
| TypeScript `tsc --noEmit` (strict, every package) | 0 errors |
| ESLint (typescript-eslint strict, `--max-warnings 0`) | 0 errors, 0 warnings |
| dependency-cruiser | 0 violations (591 modules, 2,091 dependencies; domain purity, app isolation, web→contracts only, no cycles) |
| Semgrep 1.186.0 (`p/typescript`, `p/owasp-top-ten`, `--error`) | reached the registry; 0 findings |

Full tool versions, rule lists and per-rule counts: `docs/evidence/static-analysis.md` (regenerated this session).

## 6. New screenshot files

213 new files in `docs/evidence/screenshots/` (most at both 1440 and 390 px; displays at 1920):
- **Real stack (e2e, nothing mocked):** `e2e-20` .. `e2e-29` away → notified → back → same order continues;
  `e2e-30` .. `e2e-44` unavailable → urgent banner → notification → one-click rebook → reception move → display.
- **Wave 5 (mocked API):** `w5-doctor-*` (step away dialog, away, overdue, blocked, after end, unavailable dialog, offline),
  `w5-reception-*` (available, away, unavailable, affected, results, error, offline), `w5-display-*` (away, overdue,
  unavailable, offline), `w5-patient-*` (today walk-in/away/unavailable, visit away/overdue/not checked in/unavailable,
  rebook options/done/conflict/empty/cancel, bell, notifications), `w5-admin-notifications*`, `w5-staff-notifications`,
  `w5-login-session-ended`.
- **Wave 6 (persona-review fixes):** `w6-admin-*` (sessions, new session overlap/repeat, reopen, close, staff add/doctor/
  password/deactivated/self, system down), `w6-reception-*` (patient desk, book, keyboard booking, cancel, reschedule,
  duplicates, alternatives, late markers, absent confirm), `w6-doctor-*` (follow-up, just completed, skip confirm),
  `w6-followup-*` (inbox, urgent detail, resolve form, resolved, return), `w6-patient-*` (assistant urgent, history,
  follow-ups reply/seen, today completed/return, visits return/cancelled, offline).
The exact list is `git diff --name-status 250c691..HEAD -- docs/evidence/screenshots`.

## 7. Not done / future work

From the review disposition (each with a reason in `persona-review.md`): recurring doctor schedule templates, leave and
hospital holidays; patient choosing a specific slot; ETA clamped to session start and own eligibility; patient-side cancel
reason; detecting a walk-in place held in another doctor's queue; manual "Mark no-show"; early check-in warning; report
"sessions held" wording; policy editing UI; denser display layout (10 rooms on two pages today); clinical outcome notes
(no EMR, out of scope). From D-039: forced password change at first sign-in; duplicate-patient detection is advisory.
Real SMS / email providers (the adapter and the fake exist; no keys used). `start-demo.sh` was exercised on Linux with
`SKIP_BREW=1`; the Homebrew branch could not be run here (no macOS machine).
