# User acceptance test (UAT) checklist

Status: **NOT EXECUTED.** This is a script to be run by a person against the running demo stack. Nothing in it is marked passed; the Result and Notes columns are blank until a tester fills them in. Do not cite this file as evidence of acceptance until it has been completed, dated and signed below.

## Set-up

1. `./init.sh` (starts PostgreSQL, creates `hqms` and `hqms_test`, migrates, seeds), then `pnpm dev` (api :3000, worker, web :5173). Or `docker compose up`.
2. Open `http://localhost:5173`. All adapters are the fakes (local identity, local-disk storage, fake OCR, fake LLM); no keys are needed.
3. Every demo account uses the password `demo1234` (see `db/seed/README.md`). Times are shown in hospital-local time (Asia/Kolkata).
4. Use a fresh seed (`pnpm db:reset`) before each role section if a previous section changed shared state. Record the commit hash under test below.

| Field                     | Value |
| ------------------------- | ----- |
| Commit / build under test |       |
| Tester                    |       |
| Date                      |       |
| Browser and viewport(s)   |       |
| Database seeded fresh?    |       |

Result column: write `Pass`, `Fail` or `Blocked`. Put the observed behaviour or a screenshot filename in Notes for every Fail.

## Demo accounts used

| Role                   | Account                | Scope                                                                  |
| ---------------------- | ---------------------- | ---------------------------------------------------------------------- |
| Patient A              | `patient@hqms.test`    | Ramesh Kumar (BLR-000001), booked today with Dr. Suresh Hegde          |
| Patient B              | `patient2@hqms.test`   | Sunita Devi (BLR-000002), booked tomorrow with Dr. Meera Krishnamurthy |
| Reception              | `reception@hqms.test`  | assigned to all 10 doctors                                             |
| Reception (restricted) | `reception2@hqms.test` | 2 doctors only                                                         |
| Doctor                 | `doctor@hqms.test`     | Dr. Suresh Hegde (General Medicine, OPD 1)                             |
| Follow-up staff        | `followup@hqms.test`   | assigned to all 10 doctors                                             |
| Admin                  | `admin@hqms.test`      | hospital-wide                                                          |
| Waiting-room display   | no login               | public minimal queue view                                              |

## 1. Patient

Requirements: FR-01, FR-03, FR-04, FR-09, FR-10, FR-12, FR-13, FR-14, NFR-06, NFR-08.

| #   | Step                                                                                                                          | Expected result                                                                                                     | FR            | Result | Notes |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------- | ------ | ----- |
| P1  | Sign in as `patient@hqms.test` with a wrong password, then the correct one                                                    | Wrong password is rejected with a generic message; correct password signs in and shows the patient home             | FR-01         |        |       |
| P2  | Open the appointments list                                                                                                    | Only Ramesh Kumar's appointments are listed; today's booking with Dr. Suresh Hegde is present                       | FR-01, FR-03  |        |       |
| P3  | Search availability for a department and a day with free places; book one slot using the keyboard only (Tab, Enter, no mouse) | Booking succeeds, a confirmation shows doctor, session and hospital-local time; the appointment appears in the list | FR-03, NFR-08 |        |       |
| P4  | Repeat the same booking request (double-click submit, or refresh the confirmation and resubmit)                               | No second appointment is created; the original outcome is shown                                                     | FR-03         |        |       |
| P5  | Try to book a session that is full                                                                                            | A clear "no places left" message is shown; no appointment is created                                                | FR-03         |        |       |
| P6  | Reschedule the new appointment to another session                                                                             | The old reservation is released and the new one held; the list shows one appointment                                | FR-04         |        |       |
| P7  | Reschedule to a full session                                                                                                  | The reschedule is refused and the original appointment is unchanged                                                 | FR-04         |        |       |
| P8  | Cancel the appointment                                                                                                        | Status becomes cancelled and the place is released (visible to Reception as available again)                        | FR-04         |        |       |
| P9  | With a checked-in appointment (after reception section R3), open the live status page                                         | Shows queue position/status and an ETA with its timestamp and uncertainty wording; updates without reload           | FR-09, FR-10  |        |       |
| P10 | Disconnect the network briefly (browser offline), then restore it                                                             | The page reconnects and shows current committed state; no stale position is presented as current                    | FR-09         |        |       |
| P11 | Try to open another patient's appointment id (for example one of `patient2@hqms.test`) by editing the URL                     | Access denied or not found; no data from the other patient is shown                                                 | FR-01, NFR-06 |        |       |
| P12 | Upload a discharge summary (a fixture file under 10 MB / 10 pages)                                                            | Upload accepted and shown as "processing"; core booking still works meanwhile                                       | FR-12         |        |       |
| P13 | Upload an oversized or unsupported file                                                                                       | Rejected with a clear message stating the limit                                                                     | FR-12         |        |       |
| P14 | After the instruction is verified (section F), ask the assistant a question the verified instruction answers                  | The answer cites the verified instruction and its version                                                           | FR-13, FR-14  |        |       |
| P15 | Ask the assistant to change medication or to be seen sooner                                                                   | The assistant declines and a staff task is created; no priority or treatment change is made                         | FR-14         |        |       |
| P16 | Use the return-booking link from a follow-up                                                                                  | Booking form is pre-linked to the follow-up and still respects capacity                                             | FR-14         |        |       |
| P17 | Sign out                                                                                                                      | Session ends; back button does not reveal patient data                                                              | FR-01         |        |       |

## 2. Reception

Requirements: FR-01, FR-02, FR-03, FR-04, FR-05, FR-06, NFR-08.

| #   | Step                                                                                      | Expected result                                                                                                        | FR           | Result | Notes |
| --- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------ | ------ | ----- |
| R1  | Sign in as `reception@hqms.test`                                                          | Reception home with today's sessions across assigned doctors                                                           | FR-01        |        |       |
| R2  | Search for a patient by MRN (BLR-000011) and book an appointment on their behalf          | Appointment is created and shown for that patient                                                                      | FR-03        |        |       |
| R3  | Check in a booked patient (BLR-000001) who has arrived                                    | One visit and one queue entry are created; the patient appears in the doctor's queue                                   | FR-05        |        |       |
| R4  | Press check-in a second time for the same patient                                         | No duplicate visit or queue entry                                                                                      | FR-05        |        |       |
| R5  | Check in a patient more than 10 minutes before their slot                                 | Handled by the early-eligibility rule (entry exists but is not eligible to be called until 10 minutes before the slot) | FR-05, FR-06 |        |       |
| R6  | Check in a patient later than the 15-minute grace period                                  | Late-arrival rules apply (capacity and ordering rules); the outcome and reason are shown                               | FR-05        |        |       |
| R7  | Admit a walk-in patient                                                                   | Walk-in uses a walk-in place; when the 5 walk-in places are used, further walk-ins are refused with a reason           | FR-05, FR-02 |        |       |
| R8  | Cancel and reschedule an appointment for a patient                                        | Same behaviour as P6 to P8 from the staff side                                                                         | FR-04        |        |       |
| R9  | Sign in as `reception2@hqms.test` and try to open a doctor outside its 2 assigned doctors | Access refused (assignment check)                                                                                      | FR-01        |        |       |
| R10 | As reception, try to verify a clinical instruction                                        | Not offered in the UI; a direct API attempt returns forbidden                                                          | FR-01, FR-13 |        |       |
| R11 | Complete R2, R3 and R7 by keyboard only                                                   | Every control reachable and operable without a mouse; focus order sensible                                             | NFR-08       |        |       |

## 3. Doctor

Requirements: FR-06, FR-07, FR-08, FR-09, FR-10, FR-13, FR-15, NFR-08.

| #   | Step                                                                     | Expected result                                                                                                    | FR                   | Result | Notes |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------- | ------ | ----- |
| D1  | Sign in as `doctor@hqms.test`                                            | Doctor console for Dr. Suresh Hegde's session only                                                                 | FR-01                |        |       |
| D2  | View the queue with several checked-in patients                          | Order shown with a reason for the next candidate (rotation, aging, priority)                                       | FR-06                |        |       |
| D3  | Call next (keyboard only)                                                | The candidate named in D2 is called; status becomes called; a second Call next is refused while one is outstanding | FR-06, FR-07, NFR-08 |        |       |
| D4  | Start consultation, then complete it                                     | Status moves in-service then completed; the next call becomes possible                                             | FR-08                |        |       |
| D5  | Call a patient and let the 2-minute called timeout pass without starting | The call times out as a skipped call and the patient can re-enter                                                  | FR-08                |        |       |
| D6  | Re-enter the skipped patient                                             | The same queue entry is reused with a fresh eligibility time (no duplicate entry)                                  | FR-08                |        |       |
| D7  | Pause the session                                                        | No new calls can be made while paused; ETA is withheld for an unknown-length pause                                 | FR-08, FR-10         |        |       |
| D8  | Mark the doctor unavailable                                              | Queue handling follows the unavailability rule; patients see the status change                                     | FR-08, FR-09         |        |       |
| D9  | Review and verify an extracted instruction draft                         | Draft becomes a versioned verified instruction; a newer version supersedes the old                                 | FR-13                |        |       |
| D10 | Open the reason/override record of a queue decision                      | Actor, time, entity, policy version and reason are visible                                                         | FR-15                |        |       |
| D11 | Try to open another doctor's queue (for example by URL)                  | Access refused                                                                                                     | FR-01                |        |       |

## 4. Follow-up staff

Requirements: FR-11, FR-12, FR-13, FR-14.

| #   | Step                                                                 | Expected result                                                                           | FR           | Result | Notes |
| --- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------ | ------ | ----- |
| F1  | Sign in as `followup@hqms.test`                                      | Task list scoped to assigned doctors                                                      | FR-01        |        |       |
| F2  | Open a task created by the assistant (P15)                           | Task shows owner (unassigned or assigned), due time, status and the originating request   | FR-11, FR-14 |        |       |
| F3  | Acknowledge ownership of the task                                    | Owner set to this account; audit row recorded                                             | FR-11, FR-15 |        |       |
| F4  | Let a task pass its due time (or use an already overdue seeded task) | It stays visible and open, flagged overdue                                                | FR-11        |        |       |
| F5  | Close the task with a documented disposition                         | Status closed with outcome; closure condition satisfied                                   | FR-11        |        |       |
| F6  | Cancel a task with a reason                                          | Status cancelled with the reason recorded                                                 | FR-11        |        |       |
| F7  | Review an OCR draft produced from P12                                | Draft shown as unverified; it is not used by the assistant until verified (section 3, D9) | FR-12, FR-13 |        |       |
| F8  | Retry a failed OCR job (use a fixture that fails)                    | Controlled retry offered; booking elsewhere is unaffected                                 | FR-12        |        |       |
| F9  | Create a return booking linked to a follow-up                        | Booking is linked to the follow-up and consumes normal capacity                           | FR-14        |        |       |

## 5. Admin

Requirements: FR-01, FR-02, FR-15.

| #   | Step                                                   | Expected result                                                                  | FR           | Result | Notes |
| --- | ------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------ | ------ | ----- |
| A1  | Sign in as `admin@hqms.test`                           | Admin home; hospital-wide scope                                                  | FR-01        |        |       |
| A2  | Open session and capacity configuration for a doctor   | Shows 10 booked + 5 walk-in places and the queue policy version (Table 7 values) | FR-02        |        |       |
| A3  | Create a new session for a doctor                      | Session appears with the policy version and capacity                             | FR-02        |        |       |
| A4  | Reduce a session's booked capacity below current usage | Rejected with a clear reason                                                     | FR-02        |        |       |
| A5  | Reduce capacity to a value at or above usage           | Accepted; audit row recorded                                                     | FR-02, FR-15 |        |       |
| A6  | Open the audit log and filter by entity                | Entries show actor, time, entity, policy version and reason                      | FR-15        |        |       |
| A7  | Open the throughput / waiting-time report              | Report separates proposed (estimated) from observed metrics                      | FR-15        |        |       |
| A8  | Sign in as a patient and try an admin URL              | Access refused                                                                   | FR-01        |        |       |

## 6. Waiting-room display

Requirements: FR-09, NFR-06.

| #   | Step                                                             | Expected result                                                                                                              | FR            | Result | Notes |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------- | ------ | ----- |
| W1  | Open the public display for an OPD / doctor (no login)           | Shows only the approved minimal queue information (for example token or masked name and status); no clinical or contact data | FR-09, NFR-06 |        |       |
| W2  | Call next from the doctor console (D3) while the display is open | Display updates without reload, showing who is called                                                                        | FR-09         |        |       |
| W3  | Pause the session (D7)                                           | Display shows the paused state and withholds ETAs                                                                            | FR-09, FR-10  |        |       |
| W4  | Open the display at 1440 px and 390 px wide                      | Readable at both widths; no horizontal scrolling                                                                             | NFR-08        |        |       |
| W5  | Inspect the display's network responses                          | No patient names, MRNs, phone numbers or document data beyond the approved minimal set                                       | NFR-06        |        |       |

## 7. Session 3 additions (doctor availability, notifications, admin sessions and staff, desk)

Added 2026-11-20 for the features built in session 3 (D-032 to D-039, persona-review fixes). **Not executed: Result and Notes are blank.** Set-up: `pnpm dev` with the worker running (notifications and outbox fan-out need it; with `NOTIFICATION_PROVIDER=fake` no real SMS or e-mail is sent, "Sent" means the fake provider accepted it). Use a session of Dr. Suresh Hegde that is open now (the demo creates one at any hour), and a second General Medicine doctor (Dr. Lakshmi Narayan) with a running session as the rebook and move target. Use two browser windows (doctor and a waiting patient) plus reception, and the display at `/display`.

Requirements: FR-08, FR-09, FR-10, FR-14, FR-02, FR-03, FR-04, FR-05, FR-11, FR-13, FR-15, NFR-06, NFR-07, NFR-08. Rows S1 to S10, S12 and S13 cover flows also driven by the real-stack Playwright specs in `e2e-availability.md`; S11 and S14 to S25 cover persona-review fixes (`docs/review/persona-review.md`); an automated spec passing is not a substitute for a person running the step.

| #   | Step | Expected result | FR | Result | Notes |
| --- | ---- | --------------- | -- | ------ | ----- |
| S1  | Doctor: with a waiting patient and no one called, use Step away (reason Break, 15 min preset), by keyboard only; confirm | A strip shows "You are away ... expected back about hh:mm" and the reason; Call next is disabled and says no one can be called; the N shortcut calls nobody; queue order and rotation are kept | FR-08, NFR-08 |        |       |
| S2  | Doctor: with a patient called but not started, try Step away | Refused: "DOCTOR_OCCUPIED" wording (the called patient must be started or skipped first); the session stays open | FR-08 |        |       |
| S3  | Doctor: while away, change the expected return (Step away again with another preset) | The return time updates and waiting patients are told the new time; no second break is created | FR-08 |        |       |
| S4  | Doctor: press I'm back (keyboard) | Strip disappears on the doctor console, reception and display without reload; the next Call next calls the patient who was first before the break | FR-08, FR-09 |        |       |
| S5  | Reception: watch the board during S1 to S4 | Availability strip "Dr. ... is away ... expected back about hh:mm" and an Affected patients button appear and clear live; Check in stays possible while away | FR-08, FR-09 |        |       |
| S6  | Waiting patient and display during S1 to S4 | Patient My visit shows the away banner with "Your place in the queue is kept" and an updated wait range; display shows the doctor's column as temporarily away; both return to normal at S4 | FR-09, FR-10 |        |       |
| S7  | Doctor: Unavailable for rest of session; confirm with an empty reason, then with a reason | Empty reason is refused (at least 3 characters); with a reason the session is unavailable, Call next stays blocked and the unavailable button is disabled | FR-08 |        |       |
| S8  | Patient with a booked, not-arrived appointment of that session: open Today, then use Rebook with another doctor by keyboard | An urgent banner offers Rebook or Cancel; the panel lists only same-department doctors other than the unavailable one with the next slot; one Enter books it; My visits shows the new time under Upcoming and the old one as Rescheduled | FR-03, FR-04 |        |       |
| S9  | Reception: open Affected patients; select all checked-in patients; move them to the other General Medicine doctor | A results list shows each patient with a new token; the patients' Today and My visit show the new doctor and token and no unavailable banner; the old appointment reads "Moved to Dr. ..." ; the other doctor's display column lists them | FR-04, FR-05 |        |       |
| S10 | Reception: in Affected patients, try to move more patients than the target session has free places | Only as many as there are places are moved; the rest are listed as skipped with a reason; no over-booking | FR-02, FR-03 |        |       |
| S11 | Admin: Reopen the unavailable session before its end, with a reason | Session returns to open, the reason is recorded, patients are told | FR-08 |        |       |
| S12 | Patient and reception: open the notification bell | Unread count shows on the bell; the sheet lists the away, back, urgent and moved notices (newest first), each with an Open link to the right screen; Mark as read and Mark all as read work; empty and error states read clearly | FR-09 |        |       |
| S13 | Admin: open Notifications sent | One row per channel (in-app, SMS, e-mail) per recipient and event with status Sent, the fake provider named, and addresses masked; a failed or queued delivery would show as such | FR-15, NFR-07 |        |       |
| S14 | Admin: Sessions page: create a session for a doctor, with Repeat for several days | The sessions appear with the policy version and capacity; a session that overlaps another of the same doctor is refused with a clear message | FR-02 |        |       |
| S15 | Admin: open, close (confirm dialog) and reopen a session | Status changes show immediately; closed sessions do not block a new session; reopen needs a reason | FR-02, FR-08 |        |       |
| S16 | Admin: Staff page: add a staff member (receives a one-time temporary password), deactivate, activate, reset a password; try to deactivate yourself | Each action takes effect and is audited; a deactivated user cannot sign in; the temporary password is shown once; self-deactivation is refused | FR-01, FR-15 |        |       |
| S17 | Admin: background-work panel (System status) with the worker running, then stop the worker | With the worker up: calm "working" line; after the worker stops, the panel reports it is down or late and `/health` shows degraded, while booking still works | NFR-07 |        |       |
| S18 | Patient: ask the assistant "I feel dizzy after the new tablets. Should I stop taking them?" | An urgent callout with fixed safety advice (what to do now) appears, the question is escalated as an urgent owned task, and no treatment change is made | FR-14 |        |       |
| S19 | Follow-up staff: open the urgent task from S18 | Urgent tasks are listed first; the patient's phone (tap to call), MRN and doctor are shown | FR-11, FR-14 |        |       |
| S20 | Follow-up staff: resolve with disposition Advice given, leaving the patient reply empty; then with a reply | Without a reply the resolve is refused (a reply is required for advice given and referred); with a reply it resolves and the staff-only note stays staff-only | FR-11, FR-14 |        |       |
| S21 | Patient: open Follow-ups after S20 | The care team's reply is shown on the task; the staff outcome note is not shown; a notification arrives | FR-14, NFR-06 |        |       |
| S22 | Reception: register a patient whose name and phone match an existing patient | A possible-duplicate warning lists the candidates with "Use this patient" and "Create new record anyway"; choosing Use this patient does not create a record | FR-01 |        |       |
| S23 | Reception patient desk: book an appointment for a patient (search by name or MRN), then cancel it, then book another and reschedule it | Each works from the desk for a patient with and without a login; capacity is respected; the audit shows reception as the actor | FR-03, FR-04 |        |       |
| S24 | Reception: admit a walk-in when the doctor's 5 walk-in places are full | Refused with a reason and a list "Other doctors in <department> today" each with Admit; there is no over-capacity override | FR-02, FR-05 |        |       |
| S25 | Reception: look at a patient who arrived late; mark a patient absent | Late N min and past grace markers appear; Mark absent asks for confirmation and an optional reason | FR-05, FR-08 |        |       |

## Sign-off

| Role section           | Steps run | Pass | Fail | Blocked | Tester initials |
| ---------------------- | --------- | ---- | ---- | ------- | --------------- |
| 1 Patient              |           |      |      |         |                 |
| 2 Reception            |           |      |      |         |                 |
| 3 Doctor               |           |      |      |         |                 |
| 4 Follow-up staff      |           |      |      |         |                 |
| 5 Admin                |           |      |      |         |                 |
| 6 Waiting-room display |           |      |      |         |                 |
| 7 Session 3 additions  |           |      |      |         |                 |

Overall outcome and open defects: _(to be completed after execution)_
