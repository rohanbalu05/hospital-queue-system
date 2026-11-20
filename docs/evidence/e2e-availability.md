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

Measured latencies (final run, same machine as server, one observation each, not a distribution; the display and
reception use their own polling or stream, the worker poll is 200 ms):

| From the doctor's confirm                          | ms   | From I'm back                                    | ms   |
| -------------------------------------------------- | ---: | ------------------------------------------------ | ---: |
| doctor's own strip                                 |  407 | doctor's own strip                               |  272 |
| waiting patient's banner (away)                    |  584 | waiting patient's banner (back)                  | 1238 |
| display banner                                     | 1119 | display banner cleared                           | 1410 |
| reception strip                                    | 1193 | reception strip cleared                          | 1464 |
| patient's bell shows an unread count               | 1467 | patient's bell gets one more unread              | 1742 |
| admin log shows in-app and SMS rows sent           | 5043 |                                                  |      |

The admin-log figure includes the spec's own polling (a Refresh click every 0.5 to 1.5 s) and is an upper bound.

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

Measured (final run, single observations): doctor strip 341 ms, display banner 710 ms, booked patient's bell 1463 ms,
rebook click to confirmation 57 ms, move click to results 74 ms.

## Results (measured)

`E2E_DB_NAME=hqms_e2e_test_w7 pnpm e2e` (3 specs: the old full visit and the two new ones) after the final change:
**3 of 3 passed in each of 2 consecutive runs on the final tree (after lint and format changes)** (57.6 s and 59.1 s wall time, API and worker already built; the first run after a change adds the builds). No
5xx response and no uncaught page error in any browser in either run. The only 4xx responses are the `401 GET /api/me` probes
every page makes before it has a session (10 in each availability spec). Earlier runs while the specs were being written failed on
spec-side problems that were fixed (the narrow reception defaulting to another doctor, an unread-count assumption, an outbox
ordering query, a leftover called patient blocking the next spec); those runs are not counted. Two passes do not bound flakiness.

## Product observations (not fixed here; this branch changes tests and evidence only)

1. **Display banner names the department in the sentence.** The display's doctor label is "Dr. Hegde . General Medicine";
   `doctorNameOnly` splits on a comma, so the banner reads "Dr. Hegde . General Medicine is temporarily away, expected back
   about 10:13 am". Cosmetic; the spec matches `Dr. Hegde.* is temporarily away`.
2. **Affected-patients list can show a patient who has already rebooked.** After the booked patient rebooked herself, reception's
   dialog still listed her under "Booked, not arrived" (status `rescheduled` in the database; the API excludes it) and dropped
   her only at the next 20-second poll (measured 15.4 s, 15.9 s and 16.4 s after the dialog opened in three runs). The move API is
   server-checked, so this is a stale view, not a double move, but the desk could pick her.
3. **Enter on the reception search is silently ignored while the debounced search is running.** Typing "Ramesh" and pressing
   Enter within ~200 ms shows one row (from the session's appointments) but does nothing until the patient search returns.
   The `full-visit` spec hit this and now waits for the "Press Enter in the search box to check in." hint.
4. **A transferred patient's original appointment still reads "Checked in" on the reception list** (by design in D-033: the
   original appointment is untouched), next to a note that the session is unavailable. Could confuse the desk.
5. **Doctor console selection rule (from reading `DoctorHome.tsx`, not exercised).** It picks the first open or away session and
   otherwise `list[0]`, so after "unavailable" a doctor with an earlier closed session today and no `?session=` in the URL would
   be moved to that closed session. Spec B opens `/doctor?session=...` and therefore does not show this.

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
