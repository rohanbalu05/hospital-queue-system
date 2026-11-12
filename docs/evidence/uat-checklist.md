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

## Sign-off

| Role section           | Steps run | Pass | Fail | Blocked | Tester initials |
| ---------------------- | --------- | ---- | ---- | ------- | --------------- |
| 1 Patient              |           |      |      |         |                 |
| 2 Reception            |           |      |      |         |                 |
| 3 Doctor               |           |      |      |         |                 |
| 4 Follow-up staff      |           |      |      |         |                 |
| 5 Admin                |           |      |      |         |                 |
| 6 Waiting-room display |           |      |      |         |                 |

Overall outcome and open defects: _(to be completed after execution)_
