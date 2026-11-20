# End-to-end: doctor availability and notifications (real stack)

Evidence for the session-3 features: Step away / I'm back / Unavailable for the rest of the session (D-032), rebook and the
reception's affected-patients move (D-033), notifications with a fake provider and the admin delivery log (D-034). The
existing `full-visit` spec (e2e-full-visit.md) is unchanged in what it proves. Everything marked **measured** comes from the
runs described here. There is no target in this file that is claimed as achieved; the only "targets" are the assertions
the specs make, which either passed or did not.

## What runs (nothing mocked)

| Item      | Value                                                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Host      | cloud sandbox VM, Linux 6.18, 4 vCPU (Intel Xeon @ 2.30 GHz), 15 GB RAM; Node.js v22.23.5; PostgreSQL 16.15 on localhost:5432     |
| Database  | scratch database `hqms_e2e_test_w7`, dropped, created, migrated and seeded at the start of every run                              |
| API       | `apps/api/dist/main.js` built by the run, port 3188, `NODE_ENV=test`                                                               |
| Worker    | `apps/worker/dist/main.js` built by the run, `NOTIFICATION_PROVIDER=fake`, `WORKER_POLL_MS=200`: outbox fan-out and `deliver_notification` jobs run for real |
| Web       | Vite dev server of `apps/web` on port 5188 proxying `/api` to the API (not a production build)                                     |
| Browser   | Chromium (Playwright 1.63.0, headless), one browser context per person                                                             |
| Viewports | doctor, reception, admin 1440 x 900 (each also at 390 x 844, device scale 2); patients 390 x 844 (also 1440 x 900); display 1920 x 1080 |
| Date      | 2026-11-20 (about 09:45 to 10:30 Asia/Kolkata)                                                                                      |

`tests/e2e/stack.ts` starts API, worker and Vite and stops all three afterwards. `tests/e2e/fixtures.ts` holds the shared
fixture: it cancels the seed's still-booked appointments of today (API, as reception), closes every non-closed session of
today (SQL), marks any patient left `called` by an earlier run as skipped (what the 2-minute timeout does), and creates
sessions labelled by `sessionLabelFor` that started 12 minutes ago (the label is therefore "Morning" at 10 am).
API and SQL are used only to prepare a scenario (bookings, check-ins, walk-ins) and to read the database afterwards; every
step under test is done in the browser.

Command: `E2E_DB_NAME=hqms_e2e_test_w7 pnpm e2e` (all three specs, in alphabetical file order).
Raw numbers: `docs/evidence/e2e-availability-away.raw.json`, `docs/evidence/e2e-availability-unavailable.raw.json`.

## Spec A: away -> everyone follows -> back -> same order (`availability-away.spec.ts`)

Room: Dr. Suresh Hegde. One appointment patient (A-001) is checked in; two walk-ins (W-001 Lakshmi Bai, W-002 Santosh
Patil) are waiting; one more patient is booked and has not arrived. The doctor calls, starts and completes A-001, then
(keyboard only throughout: Tab, Space, Enter, the N shortcut) opens Step away, chooses reason Break and the 15 min preset,
and confirms.

Asserted in the browser, all passed in the final runs:
- Doctor: strip "You are away ... expected back about hh:mm", "Reason: Break"; Call next is `aria-disabled` and says "You are
  away, so no one can be called"; N + Enter calls nobody; a direct `POST /sessions/{id}/call-next` as the doctor returns
  409 `SESSION_NOT_CALLABLE`; the blocked attempts added no row to `queue_decisions`.
- Waiting patient (390 and 1440): My visit banner `data-state=away`, "has stepped away and is expected back about hh:mm",
  "Your place in the queue is kept", an "Updated wait: about 14-21 min from ..." line (live, no reload).
- Booked patient who has not arrived: Today banner "Your appointment is kept" (after a reload; that component reads the
  session rather than the live stream).
- Display: "Dr. Hegde ... is temporarily away, expected back about hh:mm" in the doctor's column, live.
- Reception (1440 and 390): availability strip "Dr. Suresh Hegde is away ... expected back about hh:mm" and the Affected
  patients button, live.
- Worker fan-out: the waiting patient's bell becomes "Notifications, N unread" and the sheet holds the new notification
  "has stepped away ... expected back about hh:mm" (unread); the booked patient's notification uses the booked wording
  ("is running behind"); reception staff get an in-app notice.
- Admin > Notifications sent: for the waiting patient exactly one In-app row and one SMS row for the event, both Sent.
  Database: for `SessionPaused` 5 in-app, 3 SMS, 3 email rows, all `sent`, provider `fake` for SMS and email; none failed
  or queued at the end.
- I'm back (keyboard): strip gone on the doctor, display and reception, the patient banner changes to "Dr. ... is back"
  (all live), the patient gets the "is back ... place in the queue is unchanged" notification, and the next Call next
  calls W-001, the patient who was first in "Waiting, in call order" before stepping away (the spec reads that list
  before the step and compares). Audit: `session.pause (doctor)`, `session.resume (doctor)`; outbox
  `SessionPaused`, `SessionResumed`.

Measured latencies. **Current figures: the last of the two final-tree runs on commit `1697f3e` (2026-11-20, raw `e2e-availability-away.raw.json`).** One observation each, not a distribution; the display and reception use their
own polling or stream, the worker poll is 200 ms. The "earlier run" column is the first version of this file (before the polish merges), kept to show the spread; it is superseded.

| From the doctor's confirm                          | ms (current) | ms (earlier run) | From I'm back                                    | ms (current) | ms (earlier run) |
| -------------------------------------------------- | -----------: | ---------------: | ------------------------------------------------ | -----------: | ---------------: |
| doctor's own strip                                 |          484 |              407 | doctor's own strip                               |          332 |              272 |
| waiting patient's banner (away)                    |          699 |              584 | waiting patient's banner (back)                  |          490 |             1238 |
| display banner                                     |         1278 |             1119 | display banner cleared                           |          637 |             1410 |
| reception strip                                    |         1335 |             1193 | reception strip cleared                          |          680 |             1464 |
| patient's bell shows an unread count               |         1623 |             1467 | patient's bell gets one more unread              |        15884 |             1742 |
| admin log shows in-app and SMS rows sent           |         5335 |             5043 |                                                  |              |                  |

The admin-log figure includes the spec's own polling (a Refresh click every 0.5 to 1.5 s) and is an upper bound. The 15,884 ms for the bell after I'm back is not a delivery delay of the notification: the bell's unread
count is fetched by a 15-second poll (`UNREAD_POLL_MS = 15_000` in `apps/web/src/api/notifications.ts`), so a single observation can land anywhere from about 1 to 16 s depending on the phase of that poll. The earlier run happened to
land early. The notice itself is delivered in-app by the worker as soon as its outbox event is fanned out; this file does not measure that time separately.

## Spec B: unavailable -> rebook -> reception moves the queue (`availability-unavailable.spec.ts`)

Doctor A (Dr. Suresh Hegde): Farida Begum booked and checked in (A-001), Anitha Shankar walk-in (W-001), Sunita Devi booked
and not arrived. Doctor B (Dr. Lakshmi Narayan, same department) has a running session. The doctor opens "Unavailable for
rest of session" by keyboard, presses confirm with an empty reason (refused with "Give a reason of at least 3 characters."),
types "Called to emergency theatre" and confirms.

Asserted in the browser, all passed in the final runs:
- Doctor (1440 and 390): strip "You are unavailable for the rest of this session", the reason, Call next blocked, the
  unavailable button disabled.
- Display, live: doctor A's column banner "is not available for the rest of this session ... Please see reception"; doctor
  B's column has none. Reception strip and Affected patients button, live.
- Booked patient (reload first): Today shows the urgent banner (`role=alert`) with "Rebook with another doctor" and
  "Cancel appointment"; the bell receives the urgent notification ("Please rebook with another General Medicine doctor or
  cancel your ... appointment").
- Rebook by keyboard: the panel lists only General Medicine doctors other than A (six options: doctor B today first, then B on
  the following days), shows "Next slot hh:mm"; one Enter on "Book hh:mm with Dr. Lakshmi Narayan" books it (57 ms after
  the press in the final run); the confirmation, My visits (new doctor and time under Upcoming, the old appointment under
  "Past and cancelled" as Rescheduled) and Today (one card, new doctor and time, no banner) agree. Database: old appointment
  `rescheduled`, new appointment `booked` in doctor B's session at the time shown.
- Reception, Affected patients: "In the queue" lists the two checked-in patients; "Select all" -> choose doctor B today ->
  "Move 2 patients to Dr. Lakshmi Narayan" -> results list per patient with "New token A-001" and "New token W-001" (the
  tokens restart in doctor B's session). Database: each moved patient has the old visit `transferred` (entry `cancelled`) and
  a new visit of kind `transfer`, `open`, entry `waiting`, in doctor B's session; outbox `SessionUnavailable`,
  `AppointmentRescheduled`, `QueuePatientTransferred` x 2.
- The moved patient's Today and My visit show doctor B and the new token, with no unavailable banner, and the bell has
  "You have been moved to Dr. Lakshmi Narayan ... Your new token is A-001". The display's doctor B column lists the moved
  tokens as next while doctor A's column keeps its banner.
- Delivery log for the two sessions: `SessionUnavailable` 3 in-app + 3 SMS + 3 email (patients) and 2 in-app (staff);
  `QueuePatientTransferred` 2 in-app + 2 SMS; none failed or queued.

Measured (last final-tree run on `1697f3e`, single observations; raw `e2e-availability-unavailable.raw.json`): doctor strip 375 ms, display banner 712 ms, booked patient's bell 1543 ms, rebook click to confirmation 69 ms, move click to
results 76 ms, and the affected-patients list dropped the patient who had already rebooked **2 ms** after the check (the earlier run's 341, 710, 1463, 57 and 74 ms, and the 15.4 to 16.4 s stale list in observation 2 below, are superseded).
Spec B in this run: 6 options shown on the rebook panel, next slot for doctor B 10:37 am; moved patients got new tokens A-001 (Farida Begum) and W-001 (Anitha Shankar); outbox `SessionUnavailable`, `AppointmentRescheduled`, `QueuePatientTransferred` x 2;
**all deliveries `sent`, 0 not sent**; 9 x `401 GET /api/me` probes, 0 5xx, no page error.

## Results (measured)

**Session 3 final-tree status.** On commit `1697f3e` (the final product tree) `pnpm e2e` was run twice by the orchestrator: **3 of 3 passed in each run**. I did not run `pnpm e2e` for this update (instructed not to); the pass counts are as reported to me, and the raw JSON files and screenshots in this folder are the outputs of the second of those runs (their stamps are 2026-11-20 about 10:29 to 10:30 Asia/Kolkata). The paragraph below describes an earlier pair of runs, kept as history.

`E2E_DB_NAME=hqms_e2e_test_w7 pnpm e2e` (3 specs: the old full visit and the two new ones) after the final change:
**3 of 3 passed in each of 2 consecutive runs on the final tree (after lint and format changes)** (57.6 s and 59.1 s wall time, API and worker already built; the first run after a change adds the builds). No
5xx response and no uncaught page error in any browser in either run. The only 4xx responses are the `401 GET /api/me` probes
every page makes before it has a session (10 in each availability spec). Earlier runs while the specs were being written failed on
spec-side problems that were fixed (the narrow reception defaulting to another doctor, an unread-count assumption, an outbox
ordering query, a leftover called patient blocking the next spec); those runs are not counted. Two passes do not bound flakiness.

## Product observations (as first written; status on the final tree added)

These five were found while writing the specs, when this branch changed tests and evidence only. Each was then fixed on the product side (the persona-review follow-up, D-038/D-039) or is noted below. "Fixed" means a product commit plus
a unit or component test; unless a measured number is quoted, it was not re-demonstrated by a new browser step.

1. **Display banner names the department in the sentence** ("Dr. Hegde . General Medicine is temporarily away"). **Fixed** (`831da99`, `doctorNameOnly` handles the middle-dot label, tested in `f073dae`); the e2e spec's text match accepts either wording, so the spec does not by itself prove the new wording.
2. **Affected-patients list could show a patient who had already rebooked** (stale for 15.4 to 16.4 s in three earlier runs). **Fixed** (`573aa52`: the list refetches on open and on live queue notices); **measured in the final-tree run: the patient was gone 2 ms after the check** (`affectedListDroppedRebookedPatientAfterMs` in the raw file; one observation).
3. **Enter on the reception search ignored while the debounced search runs.** **Fixed** (`25456aa`: reception acts on a remembered Enter once the current query's results arrive; `fc6ef04` tests it). The `full-visit` spec still waits for the "Press Enter in the search box to check in." hint, so the e2e does not exercise the fast-Enter case.
4. **A transferred patient's original appointment still read "Checked in" on the reception list.** **Fixed** (`5ebdd80`, `d425e06`, `08accb7`: the appointment carries `transferredTo` and reads "Moved to Dr. Y (token)"); component and API tests, not re-observed in this e2e.
5. **Doctor console could open an earlier closed session after "Unavailable".** **Fixed** (`650c649`, test `2ed0b22`: the console opens on the session covering now); not exercised by the e2e (it opens the session by URL).

## Limitations

- Vite dev server, fake notification provider, fake OCR/LLM: no real SMS or email left the machine. "Sent" means the fake
  provider returned a message id.
- The booked (not arrived) patient's banner is read after a reload; the spec does not claim that view is live.
- The reception doctor and session pickers, the Select all / doctor radio inside Affected patients, the reception search for
  a tab and the display navigation are pointer or URL driven. Keyboard-only: logins, the doctor's whole flow (call, start,
  complete, step away dialog, I'm back, unavailable dialog), the patient's rebook (Tab to the link, Enter on the book
  button, See my visits) and the Enter key on Move.
- Timings are single observations on one machine with client and server together; none is a latency distribution.
- The fixture needs the current time to be at least 12 minutes into a hospital-local day and a four-hour session that stays on
  the same date; it was not run between about 20:00 and 00:12 Asia/Kolkata.
- Other staff roles (follow-up, admin sessions page) and the OCR/assistant loop are not part of these specs.

## Screenshots (`docs/evidence/screenshots/`; written by the final runs, five of them opened and checked by eye: e2e-21-doctor-away-1440, e2e-22-patient-away-390, e2e-23-display-away-1920, e2e-26-admin-notifications-sent-1440, e2e-41-reception-move-results-1440)

Spec A: `e2e-20-doctor-step-away-dialog-1440`, `e2e-21-doctor-away-1440`, `e2e-21-doctor-away-390`,
`e2e-22-patient-away-390`, `e2e-22-patient-away-1440`, `e2e-22-patient-booked-away-390`, `e2e-23-display-away-1920`,
`e2e-24-reception-away-1440`, `e2e-24-reception-away-390`, `e2e-25-patient-notifications-390`,
`e2e-25-patient-notifications-1440`, `e2e-26-admin-notifications-sent-1440`, `e2e-26-admin-notifications-sent-390`,
`e2e-27-doctor-back-1440`, `e2e-27-doctor-back-390`, `e2e-28-patient-back-390`, `e2e-28-patient-back-1440`,
`e2e-29-display-back-1920`, `e2e-29-reception-back-1440`, `e2e-29-reception-back-390`,
`e2e-29-patient-notifications-back-390`, `e2e-29-doctor-called-after-back-1440`, `e2e-29-patient-called-after-back-390`,
`e2e-29-patient-completed-390`.

Spec B: `e2e-30-doctor-unavailable-dialog-1440`, `e2e-31-doctor-unavailable-1440`, `e2e-31-doctor-unavailable-390`,
`e2e-32-patient-booked-before-390`, `e2e-32-display-before-1920`, `e2e-33-display-unavailable-1920`,
`e2e-34-patient-booked-unavailable-390`, `e2e-34-patient-booked-unavailable-1440`,
`e2e-35-patient-notification-unavailable-390`, `e2e-35-patient-notification-unavailable-1440`,
`e2e-36-patient-queued-unavailable-390`, `e2e-37-patient-rebook-options-390`, `e2e-38-patient-rebooked-390`,
`e2e-39-patient-visits-after-rebook-390`, `e2e-39-patient-today-after-rebook-390`, `e2e-39-patient-today-after-rebook-1440`,
`e2e-40-reception-affected-1440`, `e2e-41-reception-move-results-1440`, `e2e-41-reception-affected-after-390`,
`e2e-42-patient-moved-today-1440`, `e2e-42-patient-moved-visit-390`, `e2e-43-patient-moved-notification-390`,
`e2e-44-display-after-move-1920`.
