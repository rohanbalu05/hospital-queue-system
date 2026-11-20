# HQMS persona review (production readiness)

- **Date:** Fri 20 Nov 2026. **Run window:** 08:46 to 09:17 IST.
- **Build reviewed:** `250c691` (HEAD when the run started). HEAD at the end was `1461b64`, because the orchestrator merged B1 to B4 into the shared tree during the run (see "Run conditions").
- **How it was run:** I used each portal as the real person would, with Playwright (Chromium) scripts at 1440x900 and 390x844 (deviceScaleFactor 1, timezone Asia/Kolkata). I read the page text after every step and looked at the screenshots. Database state was read with `psql` (read only). All data was created through the UI or the API. Demo accounts were used: patient@, patient2..10, reception@, reception2@, reception3@, doctor@, doctor2@, doctor3@, followup@, followup2@ and admin@.
- **Evidence:** 29 screenshots in `docs/review/screenshots/`, named `pr-<role>-<what>-<1440|390>.png`.

## Run conditions (read first)

1. **Worker not running.** The stack's worker had exited at start-up. I confirmed why: running the HEAD worker without `DATABASE_URL` prints `{"msg":"worker.fatal","error":"DATABASE_URL is not set"}`. Effects during the run:
   - The `reservation_release`, `call_timeout` and `ocr_document` jobs stayed `pending`.
   - 60 outbox events were never dispatched.
   - `notifications` stayed at 0 rows.

   I was not allowed to start a second worker against the shared database. So **no-show release, the 2-minute call timeout, OCR, the review inbox and notification delivery could not be observed working**. This is reported as finding PR-01.
2. **Uncommitted contract edits.** From 08:50:45 IST the shared working tree held uncommitted edits to `packages/contracts` (`availability` became required on `StaffQueueSnapshot`). After that, the running web on :5173 showed "The session board could not be loaded. The server sent a response this screen cannot read." on every board with a queue. To keep reviewing HEAD, I served the web from a clean `git archive HEAD` copy on **:5174**, with the same `/api` proxy to :3000. Every UI observation below is from the :5174 HEAD web, except two booking screenshots taken earlier on :5173 (patient booking screens, unaffected).
3. **API code changed mid-run.** The API on :3000 ran `250c691` code until **09:13:35 IST**. At that point the orchestrator merged B1+B2, then B3/B4 at 09:14:32, and tsx-watch reloaded the API. Every finding comes from runs before 09:13:35 except these three, which are marked:
   - absent/re-enter (09:14)
   - the Enter-key re-run on Dr. Shetty (09:14:49; a client-side defect, and the web was still HEAD)
   - the no-show check (09:16)
4. **Data left in `hqms` by this review:**
   - **Sessions:**
     - Dr. Prakash Naik 08:35-10:35 "morning", open.
     - Dr. Shweta Kulkarni 10:30-11:30 "evening" and 10:31-11:30 "morning", both scheduled.
     - Dr. Shweta Kulkarni 30 Nov morning.
   - **Patients registered:** Kiran Walkin (two records), Venkatesh Rao, Shanthi Urgent, Race Patient x3.
   - **Session state:** Dr. Lakshmi Narayan's morning session is **unavailable**. This cannot be undone (PR-30).
   - **Queues:** several check-ins, walk-ins and calls in the morning sessions of Hegde, Bhat, Meera, Naik and Narayan.
   - **Bookings and follow-up:** one cancellation, two reschedules, one follow-up task and one return booking.

Severity scale: **P0** blocks a real hospital day or loses or leaks data. **P1** real users will hit it and be confused or blocked, but there is a workaround. **P2** polish.

## Findings

### Platform and cross-cutting

| ID | Role | Scenario / area | What happened (repro) | Sev | Fix or future work | Screenshot |
| --- | --- | --- | --- | --- | --- | --- |
| PR-01 | All | Background work | Started with `./init.sh && pnpm dev`, the stack's worker exits at boot: `DATABASE_URL is not set`. The API defaults the URL; the worker has no default, and nothing loads the `.env` that `init.sh` creates. Observed effects: (1) the 08:35 booking's `reservation_release` job (run_at 08:50) stayed `pending`, so the appointment never went Missed; (2) W-003 at Dr. Hegde stayed "called" from 09:07 to the end of the run, with no auto-skip after the 2 min timeout; (3) an uploaded document stayed "Uploaded. We have your file and will start reading it shortly"; (4) 0 notifications and 60 undispatched outbox events. | P0 | Give the worker the same `DATABASE_URL` default as the API, or load `.env` in both (`node --env-file`). Fail `pnpm dev` loudly when a process exits. | pr-patient-document-stuck-390.png |
| PR-02 | Admin / ops | Monitoring | `GET /health` returned `{"status":"ok","db":"up"}` the whole time the worker was dead. No screen shows the job backlog, stuck OCR or undelivered notifications. | P1 | Add a worker heartbeat row and oldest-pending-job age to `/health`, plus an admin "Background jobs" panel. | - |
| PR-03 | Patient | Notifications | No patient screen has a notification centre, bell or inbox. `GET /notifications` exists, but the web never calls it. It returned `[]` for patient@ after booking, reschedule, call and cancel events (worker down). The build has no SMS, e-mail or WhatsApp provider. Patients were not told when the doctor paused or became unavailable (PR-12) or when they were called. | P1 | In-app notification list with unread count on the patient nav. Add an SMS/WhatsApp adapter (fake by default) for: called, doctor away/unavailable, booking changed, follow-up answered. | pr-patient-today-doctor-unavailable-390.png |
| PR-04 | Patient, Reception, Display | Scenario 9 offline | With `context.setOffline(true)` for 60 s, patient My visit, the reception board and `/display` showed **no stale or offline banner**. The only cue was "Last updated 9:04:53 am", which stopped changing. Meanwhile W-002 was called; all three screens still said "No one is being called". After going back online they recovered within 5 s ("Now calling W-002", "Last updated 9:06:00"). | P1 | Client watchdog: if no SSE event or heartbeat arrives for N s, show "Connection lost, information may be out of date". Server sends SSE heartbeats. | pr-patient-offline-stale-390.png, pr-reception-offline-stale-1440.png |
| PR-05 | Patient | Session expiry (known defect) | Logged in as patient@, then cleared the session cookie to simulate expiry. Client navigation to **My visits still rendered Ramesh Kumar's appointments**, with no redirect to sign-in. Follow-ups showed "You are signed out. Your session has ended. Sign in again." with a useless "Try again" button and the header still offering "Sign out". | P1 | On any 401, clear the query cache and redirect to `/login`. Never render cached account data without a valid `/me`. | pr-patient-expired-session-no-redirect-390.png |
| PR-06 | Team process | Shared tree | Uncommitted contract edits in the main tree (08:50:45 IST) broke the running :5173 web for everyone ("The session board could not be loaded"). The worker of the same `pnpm dev` was already down (PR-01). | P2 | Edit contracts in a worktree and merge them together with the API change, or run the demo stack from a separate checkout. | - |

### Patient

| ID | Role | Scenario / area | What happened (repro) | Sev | Fix or future work | Screenshot |
| --- | --- | --- | --- | --- | --- | --- |
| PR-07 | Patient | Walk-in Today (known defect) | Reception admitted Sunita Devi (patient2) as walk-in W-001 at Dr. Vikram Bhat. Her Today page said "**No visit today**. Your token... appear here once you check in at the hospital." Same for Santosh Patil (W-001 at Dr. Narayan) and Manjunath Gowda (W-003 at Dr. Bhat); each Today page showed only their booked appointments. | P1 | Build Today from the patient's open visits and queue entries, not only from appointments. | pr-patient-today-walkin-novisit-390.png |
| PR-08 | Patient | My visit before check-in | Today and My visits show "See my place in the queue" on a **booked, not checked-in** appointment. Clicking it (Pooja Hegde, Santosh Patil) gives `/sessions/{id}/queue` 404. The screen says "We could not find your visit in this session. The server could not find what this screen asked for..." and shows a Reference id. | P1 | Hide the link until check-in, or show a "Not checked in yet" state with the arrival window. | pr-patient-myvisit-booked-error-390.png |
| PR-09 | Patient | Scenario 10 booking at grace end (known defect) | At 08:49 Farida Begum booked Dr. Naik's session that started 08:35. Confirm step: "Your time **8:35 am**". After booking: "Arrive 10 minutes early and check in at reception". At 08:55 (6 min after booking) reception check-in returned 409 `LATE_ARRIVAL_REQUIRES_REVIEW` (20 min late). She had to be admitted as a late arrival, using walk-in place W-001. The Missed transition itself was not observed (PR-01). | P1 | Offer only slots whose start is at least about 10 min in the future, or treat the booking time as the arrival-window start for same-day bookings. Never show "arrive early" for a past time. | pr-patient-book-confirm-grace-390.png, pr-reception-late-dialog-1440.png |
| PR-10 | Patient | Scenario 1 pause ETA | Doctor paused at 08:58 with "Back at 9:13 am". Ramesh (A-002, next in line) saw "The doctor has paused this session" and "Estimated wait **about 7-23 min**". The lower bound (09:05) is before the doctor's stated return (09:13), and the return time itself is not shown to the patient. Reception did see "Resumes about 9:13 am". | P1 | Clamp the ETA lower bound to `pauseUntil` and show "Doctor expected back about 9:13 am" on My visit and the display. | pr-patient-myvisit-paused-390.png |
| PR-11 | Patient | Scenario 2 unavailable (waiting) | After Dr. Narayan was marked unavailable, waiting patient Rahul Verma (A-001) saw three conflicting messages: a banner "The doctor is not available for this session. Please check with the front desk."; "You are in the queue. Stay near the waiting area... Number 1. **You are next.**"; and "Estimate paused. The doctor has **paused** this session." | P1 | One unavailable state: "Dr. X cannot see patients for the rest of this session", what happens next (moved to another doctor or rebook), and no "You are next". | pr-patient-myvisit-unavailable-390.png |
| PR-12 | Patient | Scenario 2 unavailable (booked, not arrived) | Pooja Hegde (09:20 with Dr. Narayan, not arrived) still saw "Booked. Check in at reception when you arrive." on Today and My visits, with no warning. She can reschedule herself only if she happens to open My visits. Nobody tells her. | P1 | Flag affected bookings on Today ("This session is cancelled, choose another time") and notify them (PR-03). | pr-patient-today-doctor-unavailable-390.png |
| PR-13 | Patient | Questions (assistant) | Asked "I feel dizzy after the new tablets. Should I stop taking them?". Reply: "Sent to the follow-up team. You'll hear back by **21 Nov, 9:02 am**" (24 h). There is no safety-net advice for a possible adverse drug reaction. | P1 | Detect red-flag symptom words and show urgent-care advice (call the hospital number, go to Emergency). Shorten the SLA for medication-safety questions. | pr-patient-assistant-escalated-390.png |
| PR-14 | Patient | Follow-up answer | After staff acted on the task, the patient's Follow-ups page only said "Being handled. You'll hear back by...". The staff form says "Outcome note: ... **Staff see this; the patient does not**." The patient has no way to read the answer in the app. | P1 | Add a patient-visible reply field to resolve, shown on Follow-ups and as a notification. | pr-followup-task-detail-1440.png |
| PR-15 | Patient | Today after visit | After Manjunath's consultation was completed, his Today page said "No visit today" (no summary, no next steps). The return visit booked by follow-up staff is not labelled as a follow-up return on My visits. | P2 | Show "Visit completed at 9:00 with Dr. Hegde" and any instructions or return visit, labelled. | - |
| PR-16 | Patient | Reschedule | The reschedule dialog lists only the **same doctor's** sessions. When Dr. Narayan was unavailable, Pooja could not move to Dr. Hegde (also General Medicine) without cancelling and rebooking. Sunday sessions are offered (22 Nov). | P2 | Offer same-department doctors. Add hospital holiday and closed-day support. | - |
| PR-17 | Patient | Booking time | The patient cannot pick a time, only "The next free time. It is confirmed when you book." | P2 | Let the patient choose among free slots, defaulting to the next one. | pr-patient-book-confirm-grace-390.png |
| PR-18 | Patient | ETA honesty | At 08:57 (session starts 09:00, doctor not yet calling), Manjunath saw "Estimated wait about 0 min". At 09:04 Ramesh saw "about 2-8 min" although he was not callable until 09:10 (eligibility). | P2 | Lower bound is the later of session start, the patient's eligibility time and the doctor's pause end. | - |
| PR-19 | Patient | Cancel | The cancel dialog is clear ("Keep appointment" / "Cancel appointment"), but no reason is collected and there is no undo or "book again" link afterwards. | P2 | Optional reason and a "Book a new time" button after cancelling. | - |

### Reception

| ID | Role | Scenario / area | What happened (repro) | Sev | Fix or future work | Screenshot |
| --- | --- | --- | --- | --- | --- | --- |
| PR-20 | Reception | Enter key (known defect) | **Confirmed twice.** (a) 08:50, Dr. Hegde morning, list order Manjunath, Ramesh, Anitha: press `/`, type `Anitha` (no delay), press Enter. **Manjunath Gowda** was checked in (A-001); Anitha stayed Booked. (b) 09:14 on the HEAD web, Dr. Shetty afternoon: type `Divya` + Enter, and **Karthik Raman** was checked in (A-001, five hours before his 14:00 slot). The action uses the list from the 200 ms debounced query. There is **no undo check-in**. | P0 | Enter must act only when the visible list matches the current query (or do nothing while it is pending). Add "Undo check-in" for about 2 min. Warn when checking in more than about 1 h early. | pr-reception-enter-wrong-checkin-1440.png |
| PR-21 | Reception | Phone booking / desk booking | Reception has no screen to book, cancel or reschedule an appointment for a patient. Patients registered at the desk have no login (`hasLogin:false`), so they can **never** get a future appointment. Only a same-day walk-in is possible. | P1 | Add "Book for patient", "Cancel" and "Reschedule" to the reception desk (the API already allows reception to book). | - |
| PR-22 | Reception | Register patient | Registering "Kiran Walkin, +91 9900011122" twice created two records, BLR-001000 and BLR-001001, with no duplicate warning. Both were admitted (W-004, W-005). | P1 | Search by phone and name before creating; show "possible existing patient". | pr-reception-walkin-full-1440.png |
| PR-23 | Reception | Scenario 5 walk-in full | Dr. Bhat reached 5/5 walk-ins after 3 admissions and 2 registrations. "Admit walk-in: Pooja Hegde" was disabled, "Register and admit walk-in" was disabled, and "Walk-in places are full for this session." appeared. There is no emergency override and no suggestion of Dr. Shweta Kulkarni (same department, 0/5 used). Only an admin can raise capacity. | P1 | Show same-department doctors with free walk-in places. Allow a recorded override (doctor or charge nurse). Allow registering without admitting. | pr-reception-walkin-full-1440.png |
| PR-24 | Reception | Scenario 2 unavailable | The doctor's dialog says "reception will need to rebook or advise them", but reception has no rebook or move tool (PR-21). On the already-open reception2@ board, the header chip still said **"Open"** and **"Check in" stayed enabled** for Pooja after the doctor went unavailable; only a reload showed "Doctor unavailable" and disabled it. Waiting A-001 and W-001 stay in "Waiting" with no action. | P1 | Refresh session status from live events. Add an "Affected patients" panel with "Move to Dr. X" and "Rebook" actions. | pr-reception-board-unavailable-1440.png |
| PR-25 | Reception | Duplicate queues | The same patient can be in two doctors' queues at once without warning: Manjunath (A-001 at Hegde and W-003 at Bhat), Kiran Walkin BLR-001000 (W-004 at Bhat and W-001 at Meera) and BLR-001001 (W-005 at Bhat and W-002 at Hegde). Mohan Das was admitted as a walk-in at Bhat while holding a 09:00 booking with Dr. Meera. | P2 | Warn "This patient is already waiting for Dr. X". | - |
| PR-26 | Reception | Scenario 3/4 late and no-show | No lateness marker: at 08:55 Farida (08:35 slot) showed as plain "Booked" until Check in was pressed. At 09:16 (16 min after Mohan Das's 09:00 slot) he was still under "Expected", "Booked", with an active Check in button. Reception has no manual "Mark no-show". (The automatic release needs the worker, PR-01.) | P2 | Show "Late 20 min" or "Past grace" badges. Add a manual "Did not attend" action. | pr-reception-noshow-still-expected-1440.png |
| PR-27 | Reception | Absent / re-enter (09:14, after merge) | Reception's "Mark absent" acted immediately with no confirmation or reason (the doctor's absent dialog asks for a reason). Re-enter was also one click. Both worked, and the patient saw "You are marked as not present. Please see the front desk if you are here." | P2 | Confirm, and record a reason for absent. | - |
| PR-28 | Reception | Early check-in | Karthik Raman was checked in at 09:14 for a 14:00 appointment with no warning (see PR-20b). | P2 | Warn outside a configurable arrival window. | - |
| PR-50 | Reception | Scenario 8 two receptionists | Safe. reception@ and reception3@ pressed Check in on Lakshmi Bai at the same moment: 201 and 200 replay, same token A-001, both screens "Checked in". Both pressed Admit walk-in on BLR-001000: one 201 (W-001); the other got "Not admitted. This patient already has an active place in this session. The list has changed. Check the arrival again, then retry." | - | None (positive). | - |

### Doctor

| ID | Role | Scenario / area | What happened (repro) | Sev | Fix or future work | Screenshot |
| --- | --- | --- | --- | --- | --- | --- |
| PR-29 | Doctor | Scenario 7 emergency priority | At 09:00 the doctor set **Class 1 "Chest pain, ECG changes"** on Anitha Shankar (A-003, appointment 09:40, eligible 09:30). The dialog promises "called ahead of the rotation". Call next then called walk-in **W-001 by rotation**: "walk-in turn of A, A, W; appointment turn skipped (no appointments waiting)", while the list showed A-002 and A-003 (P) as "Waiting, in call order". The urgent patient cannot be called before 09:30 and the doctor has no "call this patient" override. Priority on an already-eligible walk-in did work (W-003, "Clinical priority (class 1)"). Root cause is the spec (6.4 eligibility before priority). | P0 | Clinical priority must bypass early eligibility (or add an audited "Call now" override). Fix the reason text ("not yet eligible" vs "no one waiting"). Show "not before 9:30" on waiting rows. | pr-doctor-priority-called-1440.png |
| PR-30 | Doctor | Scenario 2 undo | "Mark unavailable" cannot be undone. `POST /sessions/{id}/resume` and `/open` as doctor2@ **and admin@**: 409 `INVALID_TRANSITION` ("A unavailable session cannot be resumed/opened"). A mis-click or early return loses the whole session. Booking into it: 409 "This session is not open for booking". | P1 | Allow admin (or doctor within N minutes) to reopen, with audit. Otherwise offer "Create replacement session". | pr-doctor-unavailable-dialog-1440.png |
| PR-31 | Doctor | Scenario 1 pause with called patient | Pause was accepted (200) while W-003 was "called" and not started. The display then showed **"Now calling W-003"** together with "Doctor has paused". The called patient walks to an empty room, and with the worker running would be timed out to Skipped. | P1 | Block pause while a call is outstanding (start or skip first), or freeze the call timer and hide "Now calling" while paused. | pr-display-paused-1440.png |
| PR-32 | Doctor | Complete visit | Complete takes no outcome or notes. The console has no "Create follow-up", "Book return" or "Add instruction" action, and no web screen calls `POST /follow-up-tasks`. Follow-up tasks come only from assistant escalations. | P1 | Add a "Finish visit" panel: outcome, follow-up needed (creates an owned task), return interval. | - |
| PR-33 | Doctor | Review inbox "New version of" (known defect) | **Not reproduced end to end.** No document reached the review inbox, because OCR never ran (PR-01), so the inbox showed "Nothing to verify". Code check on HEAD: `InstructionForm.tsx` sends `instructionId` without `expectedCurrentVersionId`, and `documents.service.ts:263` answers 400 "expectedCurrentVersionId is required when instructionId is given". | P1 | Send the current version id from the form. Add an e2e test once the worker runs. | - |
| PR-34 | Doctor | Session label | After Pause, and after Mark unavailable, the session selector still read "Morning 9:00 am to 1:00 pm, General Medicine, OPD 2 **(open)**", while the banner said "Session marked unavailable". | P2 | Refresh the session list on status events. | pr-doctor-unavailable-after-1440.png, pr-doctor-paused-1440.png |
| PR-35 | Doctor | Skip | "Skip" on a called patient acts immediately (no confirmation). Recovery is Re-enter via the Skipped lane. | P2 | Confirm or offer a 10 s undo. | - |
| PR-36 | Doctor | Mobile 390 px | The console renders 453 px wide at 390 px: the session selector overflows and names truncate ("Ramesh Ku..."). | P2 | Wrap the selector; stack the row actions. | pr-doctor-console-overflow-390.png |

### Follow-up staff

| ID | Role | Scenario / area | What happened (repro) | Sev | Fix or future work | Screenshot |
| --- | --- | --- | --- | --- | --- | --- |
| PR-37 | Follow-up | Reschedule after return booking (known defect) | **Confirmed.** followup@ acknowledged the task, then "Book return visit" with Dr. Hegde on Sat 21 Nov 9:40 (appointment `10b14f1d`, `follow_up_task_id` set). patient@ then rescheduled it from My visits to Fri 20 Nov 2:00 pm. The new appointment `ce96dca8` has `follow_up_task_id = NULL`. The task's `return_appointment_id` still points to the old, now `rescheduled`, appointment. The patient's Follow-ups page still says "A return visit was booked for you". | P1 | Carry `follow_up_task_id` across reschedule and update `return_appointment_id` in the same transaction. | - |
| PR-38 | Follow-up | Contacting the patient | The task detail shows only "Patient: Ramesh Kumar". No phone, MRN or doctor is shown. There is no "message patient" action; the outcome note is staff-only (PR-14). Staff cannot actually reach the patient from this screen. | P1 | Show phone (masked, tap to reveal with audit), MRN and last visit. Add a patient-visible reply. | pr-followup-task-detail-1440.png |
| PR-39 | Follow-up | Return booking dialog | The doctor selector defaulted to "Dr. Shweta Kulkarni, Dermatology" (alphabetically first) for a General Medicine patient. The header says "Session, next 14 days" but only 7 days exist. | P2 | Default to the patient's last doctor; show the real range. | - |

### Admin

| ID | Role | Scenario / area | What happened (repro) | Sev | Fix or future work | Screenshot |
| --- | --- | --- | --- | --- | --- | --- |
| PR-40 | Admin | Sessions | The admin UI cannot create, open, close or cancel sessions or plan a doctor's leave. The only button is "Edit capacity". From 28 Nov: "No sessions on Sat, 28 Nov. Choose another date. Sessions are created from the doctor schedule." There is no doctor-schedule screen. After the 7 seeded days nobody can book. All extra sessions in this review had to be created with `POST /sessions`. | P0 | Add a weekly doctor template, a "Generate sessions" action, add/cancel single sessions, and leave or holiday blocks. | pr-admin-no-sessions-no-create-1440.png |
| PR-41 | Admin | Overlapping sessions | The API accepted overlapping sessions for the same doctor: Naik 08:35-10:35 and 09:00-13:00; Kulkarni 09:00-13:00, 10:30-11:30 and 10:31-11:30 (all 201). Both Naik sessions were bookable ("Morning 8:35 am" and "Morning 9:00 am" side by side in Book). The display showed OPD 12 twice. | P1 | Reject overlapping sessions per doctor (exclusion constraint on tstzrange). | pr-patient-book-session-list-390.png, pr-admin-sessions-evening-label-1440.png |
| PR-42 | Admin | Staff | The Staff page offers only "Edit assignments". There is no create user, deactivate, reset password or role change. | P1 | Staff lifecycle screens with audit. | - |
| PR-43 | Admin | Session labels | A session labelled `evening` starting 10:30 am was accepted and shown as "**Evening, 10:30 am to 11:30 am**". `scripts/demo-session-now.mjs` always labels its session "evening" whatever the hour. | P2 | Derive the label from the start time (or validate it). | pr-admin-sessions-evening-label-1440.png |
| PR-44 | Admin | Reports | At 08:48, before any session had started, the report said "Completed visits 0, **Sessions held 20**". Today's not-yet-run sessions are counted as held. | P2 | Count sessions that opened and had at least one call, or label it "Sessions scheduled". | - |
| PR-45 | Admin | Audit | A patient sign-in is listed as "Ramesh Kumar, Patient, Signed in, **Staff account**". | P2 | Entity label "User account". | - |
| PR-46 | Admin | Mobile 390 px | Sessions table: page is 419 px wide, and the Session, Status and Actions columns are off-screen. The date input shows "11/20/2026". | P2 | Card layout under 640 px; dd/mm/yyyy. | pr-admin-sessions-overflow-390.png |
| PR-47 | Admin | Policy | "Current queue policy" is read only; there is no way to create policy v2 in the UI. | P2 | Policy edit creating a new version (future work). | - |

### Waiting-room display (`/display`)

| ID | Role | Scenario / area | What happened (repro) | Sev | Fix or future work | Screenshot |
| --- | --- | --- | --- | --- | --- | --- |
| PR-48 | Display | Scenario 2 unavailable | After Dr. Narayan was marked unavailable, **OPD 2 disappeared from the display** (API `/display/sessions` stopped returning it). Patients waiting outside OPD 2 see nothing. | P1 | Keep the column with "Dr. Narayan is not available this session. Please see reception." | pr-display-unavailable-1440.png |
| PR-49 | Display | Layout | Six rooms per page, 2 pages: OPD 1 was only on page 2. With overlapping sessions OPD 12 appeared on both pages. Long labels truncate ("Dr. Krishnamurthy · Paediatr..."). The display has no offline indicator (PR-04). | P2 | Fit all rooms, or group by floor; one column per room. | pr-display-paused-1440.png |

### Things that worked (for balance)

- **NFR-06 (privacy).**
  - patient@ got 404 on another session's queue, 404 on another patient's appointments and appointment by id, and 403 on patient search and decisions.
  - The patient snapshot holds only `myEntry` and `nowCalling` (no other names).
  - reception2@ got 403 on an unassigned doctor's queue and walk-ins.
  - The display shows tokens only.
- **NFR-08 (keyboard).**
  - Keyboard-only booking works (Tab to radio, arrows, Space, Enter at each step, Tab to "Book appointment", Enter: 201).
  - Doctor "N" then Enter called the next patient (CLINICAL_PRIORITY W-003).
- **Late arrival.** The dialog is clear: "Arrived 20 min late... Admitting uses a walk-in place and walk-in order. Not now / Admit as late arrival". The result is W-001 with "Late arrival, walk-in order".
- **Capacity.** Reducing capacity below usage gives a clear error: "Capacity not reduced. Capacity cannot be reduced below places already in use. Nothing was changed."
- **Two receptionists.** The race is safe (PR-50).

## Known defects: status

| Known defect | Status | Exact repro |
| --- | --- | --- |
| Reception Enter key checks in a row that does not match the search | **Confirmed** | Reception, Dr. Hegde, Morning. Press `/`, type `Anitha` with no delay, press Enter at once. Manjunath Gowda (first row of the unfiltered list) is checked in. Re-confirmed on Dr. Shetty, Afternoon: type `Divya` + Enter checks in Karthik Raman. (PR-20) |
| Stale account-scoped cache after session expiry / logout and login as another user | **Confirmed for expiry; not reproduced for sign-out** | Expiry: log in as patient@, visit My visits, Follow-ups and Today, clear cookies, click My visits. Ramesh's appointments are still rendered and there is no redirect. Sign-out path: patient@ signs out, patient2@ signs in; Today, My visits and Follow-ups showed only Sunita's data at 150-300 ms. reception@ signs out, reception2@ signs in; the doctor list showed only Hegde and Narayan. (PR-05) |
| "New version of" instruction verify returns 400 | **Not reproduced (blocked)** | No document reached the review inbox because the worker was not running (PR-01). The code on HEAD matches the defect (PR-33). |
| Walk-in patient's Today page shows "No visit today" | **Confirmed** | Reception admits patient2 (Sunita Devi) as a walk-in at Dr. Bhat (W-001). Log in as patient2: Today shows "No visit today". (PR-07) |
| Live sync version race | **Not reproduced** | Three rounds at Dr. Meera, each a parallel walk-in plus call-next, then start and complete, then a final call-next, with doctor3 console, reception board and patient8 My visit open. After 6 s all three matched the API snapshot v15 (active W-003 called, completed 3). |
| Reschedule loses the follow-up task link | **Confirmed** | Follow-up return booking, then patient reschedule: the new appointment has `follow_up_task_id` NULL and the task still points to the old appointment. (PR-37) |
| Booking at 10:45 gets the 10:30 slot, which goes Missed immediately | **Confirmed in part** | Booking at 08:49 assigned the 08:35 slot (grace ends 08:50), with "Arrive 10 minutes early" copy. The Missed transition was not observed because the release job never ran (worker down). At 08:55 check-in demanded late review (20 min late). (PR-09) |

## Scenarios (observed end to end)

### 1. Doctor steps away mid-session and comes back (Dr. Hegde, 08:57-08:58)

Setup: Manjunath A-001 was called, started and completed. Ramesh A-002 and Anitha A-003 were waiting. The doctor clicked **Pause session** and entered Back at 9:13 and reason "Called to ward 3 for an emergency".

- **Doctor:**
  - The banner said "Session paused. Back at 9:13 am. Patients see a resume time and their estimates continue."
  - Call next was disabled: "The session is paused. Resume it to call the next patient."
  - The selector still read "(open)" (PR-34).
- **Reception:** "Session Paused. Resumes about 9:13 am."
- **Patient (Ramesh):**
  - The patient saw "The doctor has paused this session. Your place in the queue is kept." and "about 7-23 min" (PR-10).
  - The return time was not shown.
- **Display:** the session's column was on page 2. In a later pause at 09:12 (no return time) it showed "Doctor has paused" next to "Now calling W-003" (PR-31).
- **Resume:** one click, with no dialog. The ETA became "about 5-18 min". The patient banner was removed.
- **Open-ended pause:** the patient saw "Estimate paused. ... We'll show a new estimate when it resumes" (correct ETA withholding).
- **Today's limits:** the doctor can pause and resume any number of times. The doctor cannot pause while keeping the call timer frozen.

### 2. Doctor leaves for the rest of the session (Dr. Narayan, 08:59)

Setup: Rahul A-001 (appointment) and Santosh W-001 (walk-in) were waiting. Pooja was booked for 09:20 and had not arrived.

- **Dialog:** "You will not be seeing the remaining patients... reception will need to rebook or advise them." A reason is required.
- **After marking:**
  - Doctor: "Session marked unavailable", call next disabled. Waiting patients remain listed with no action.
  - Undo is impossible, even for admin (PR-30).
- **Reception:**
  - The open board kept "Open" and an enabled Check in until reload (PR-24).
  - There is no move or rebook tool (PR-21).
- **Patients:**
  - Rahul saw contradictory "You are next" and "paused" copy (PR-11).
  - Pooja saw "Booked, check in when you arrive" (PR-12). She could reschedule herself, to the same doctor only (PR-16).
  - Santosh's walk-in did not appear on his Today page (PR-07).
- **Notifications:** none (PR-03).
- **Display:** OPD 2 vanished (PR-48).
- **Booking:** new bookings into the session were rejected with 409.

### 3. Patient arrives after the grace period (Farida, Dr. Naik 08:35 slot, arrived 08:55)

- Reception Check in returned 409 `LATE_ARRIVAL_REQUIRES_REVIEW`. The dialog read "Arrived 20 min late ... Admitting uses a walk-in place and walk-in order."
- "Admit as late arrival" gave **W-001**, "Late arrival, walk-in order". Booked capacity went 1/10 to 0/10 and walk-in 0/5 to 1/5.
- Patient Today: "8:35 am, Dr. Prakash Naik, Checked in".
- Not tested: a late arrival when walk-in places are already full (no session was in that state at the right time).

### 4. No-show (Mohan Das, Dr. Meera 09:00)

- Not observable as designed, because the worker was down (PR-01).
- At 09:16:
  - `appointments.status` was still `booked` and the release job was `pending`.
  - Reception showed him under "Expected", "Booked", with Check in enabled, and no late or no-show marker (PR-26).
  - His Today page said "Booked. Check in at reception when you arrive."
- Reception has no manual "did not attend" action.

### 5. Walk-in surge until full (Dr. Bhat morning, 08:56)

- W-001 to W-005 were admitted in about 10 s: Sunita, Mohan Das (who holds a booking elsewhere), Manjunath (already in Hegde's queue) and Kiran Walkin twice (duplicate record, PR-22).
- The board showed "Walk-in 5/5 full" and "Workload: High. Walk-in places are full (5 of 5) and 5 patients are still waiting."
- For the 6th patient, both Admit and Register were disabled, with no alternative offered (PR-23).

### 6. Patient cancels (Santosh Patil, Dr. Meera 09:40)

- My visits, then Cancel. The dialog read "Cancel this appointment? ... Your place is released so another patient can book it." He chose "Cancel appointment", which returned 200.
- The appointment moved to "Past and cancelled (1)". Reception listed it under "Missed or cancelled: Santosh Patil, Cancelled".
- There is no reason and no undo (PR-19). No notification was delivered (PR-03).

### 7. Emergency priority (Dr. Hegde, 09:00 and 09:07)

- Priority on a not-yet-eligible appointment patient was **ignored by Call next** (PR-29, P0).
- Priority on a newly admitted walk-in worked: "Clinical priority (class 1)". The waiting list shows a "P Priority" tag and the reason.
- Only doctors can set priority. Reception has no "emergency" flag, and a walk-in-full session cannot admit an emergency at all (PR-23).

### 8. Two receptionists on the same patient (reception@ and reception3@, Dr. Meera, 09:01)

- This is safe. Details are in PR-50.

### 9. Connection lost and restored (Dr. Hegde, 09:04-09:06)

- During 60 s offline there was no stale banner on any of the three screens. They showed outdated "No one is being called" (PR-04).
- After reconnecting, they caught up within 5 s.

### 10. Booking as a slot's grace period ends (Dr. Naik session that started 08:35, booked 08:49)

- The session list offered "Morning 8:35 am to 10:35 am" and "Morning 9:00 am to 1:00 pm" for the same doctor (PR-41). The confirm step said "Your time 8:35 am".
- After booking the patient saw "Arrive 10 minutes early and check in at reception".
- The Missed transition at 08:50 did not happen (worker down). The patient was still treated as late 6 minutes after booking (PR-09).

## Not tested, and why

- **Call timeout auto-skip (2 min), automatic no-show release, notification delivery, OCR, review inbox verify and the assistant answering from a verified instruction:** all need the worker, which was not running (PR-01). I was not permitted to start one.
- **Text contrast measurements:** not measured with a tool. Visual check only: patient text at 390 px is 16 px or larger for main content, with secondary lines about 14 px in grey.
- **Behaviour of the B1 to B4 changes merged at 09:13 to 09:14 IST:** out of scope. This review covers `250c691`.

## Disposition (session 3, after B1-B6)

Every P0 and P1 above was fixed in this session, test-first, unless marked otherwise. "B1"..."B6" are the build items in
`docs/review/final-report.md`; decisions are in `DECISIONS.md` (D-032..D-039). P2 items were fixed where they were cheap;
the rest are future work with a reason.

| ID | Sev | Disposition | Where / why |
| --- | --- | --- | --- |
| PR-01 | P0 | Fixed (B6) | Worker defaults `DATABASE_URL` like the API outside production; heartbeat rows (migration 0010) |
| PR-02 | P1 | Fixed (B6) | `/health` reports `worker: up/down` (`degraded`, still 200); admin **Background work** panel from `GET /admin/system` |
| PR-03 | P1 | Fixed (B2) | Notification bell for every role; worker fan-out for away/back/unavailable/transfer/reply; SMS/email through the fake `NotificationProvider`; admin **Notifications sent** |
| PR-04 | P1 | Fixed (B6) | Offline/stale banner on doctor, reception, display and My visit; refetch on reconnect |
| PR-05 | P1 | Fixed (B4) | Account-scoped cache cleared on 401, logout and user change; "Your session has ended" on sign-in |
| PR-06 | P2 | Fixed (process) | Contracts committed before builders started; the demo stack runs from merged commits only |
| PR-07 | P1 | Fixed (B4) | `GET /me/visits/today`; Today shows walk-in, late-admission and transfer visits |
| PR-08 | P1 | Fixed (B6) | No queue link before check-in; My visit shows "You have not checked in yet" instead of an error |
| PR-09 | P1 | Fixed (B4) | Slot assignable only if `slot + grace >= now + 10 min` everywhere (D-035) |
| PR-10 | P1 | Fixed (B1/B6) | Away banner shows "expected back about hh:mm"; ETA lower bound never before the stated return |
| PR-11 | P1 | Fixed (B1) | One consistent message set when away/unavailable; no "You are next" |
| PR-12 | P1 | Fixed (B2/B3) | Urgent banner + notification for booked patients; one-click rebook or cancel |
| PR-13 | P1 | Fixed (B6) | Red-flag questions get fixed 108/Emergency advice first and an urgent task due in 2 h; negation biased to escalate (D-039) |
| PR-14 | P1 | Fixed (B6) | Staff reply the patient reads on Follow-ups; notification says a reply is waiting (no reply text in it) |
| PR-15 | P2 | Fixed (B6) | Today shows "Visit completed … with Dr. X"; return visits labelled |
| PR-16 | P2 | Partly fixed | Doctor unavailable → other doctors of the same department offered (B3). General reschedule to another doctor, and hospital holidays/closed days: **future work** (needs a holiday calendar and a doctor-schedule model) |
| PR-17 | P2 | Future work | Patient picking a specific slot: the next-free-slot rule keeps capacity and fairness simple; choosing needs slot holds |
| PR-18 | P2 | Partly fixed | Lower bound respects the doctor's return (B6). Clamping to session start and the patient's own eligibility time: **future work** (small, in `packages/domain/src/eta.ts`) |
| PR-19 | P2 | Partly fixed | "Book a new time" after cancelling (B6). Optional cancel reason on the patient side: **future work** |
| PR-20 | P0 | Fixed (B4) | Enter acts only on rows for the current query; a fast Enter waits for the current results instead of being dropped (polish) |
| PR-21 | P1 | Fixed (B6) | Reception **patient desk**: book, cancel, reschedule for a patient (incl. desk-registered patients) |
| PR-22 | P1 | Fixed (B6) | 409 POSSIBLE_DUPLICATE with candidates; "Use this patient" or "Create new record anyway" |
| PR-23 | P1 | Fixed (B6) | Walk-in full → "Other doctors in <department> today" with Admit. No over-capacity override by design (capacity guard, T1) |
| PR-24 | P1 | Fixed (B1/B3) | Board follows the live state; Check in disabled when unavailable; **Affected patients** move tool |
| PR-25 | P2 | Partly fixed | Warning when the patient has a booking/check-in with another doctor today. A walk-in place held in another queue is not detected: **future work** (needs a per-patient live-place read) |
| PR-26 | P2 | Fixed (B6) | "Late N min" / "past grace" markers; automatic no-show release works again with the worker (PR-01). A manual "Mark no-show" button: **future work** |
| PR-27 | P2 | Fixed (B6) | Mark absent asks for confirmation and an optional reason |
| PR-28 | P2 | Future work | Early check-in warning (configurable arrival window): low risk, the patient only becomes eligible 10 min before the slot |
| PR-29 | P0 | Fixed (B6) | A clinical priority makes a present patient eligible now; selection procedure unchanged (D-038) |
| PR-30 | P1 | Fixed (B6) | Admin **Reopen** (unavailable → open before the end, reason, patients told) |
| PR-31 | P1 | Fixed (B1) | Step away refused with DOCTOR_OCCUPIED while a patient is called but not started |
| PR-32 | P1 | Partly fixed | Doctor creates a follow-up task for the current or just-completed patient (B6). Clinical outcome notes: **out of scope** (no EMR, report §2) |
| PR-33 | P1 | Fixed (B4) | The web sends `expectedCurrentVersionId`; 409 shows a refresh prompt |
| PR-34 | P2 | Fixed (B1) | Session picker follows live status ("away") |
| PR-35 | P2 | Fixed (B6) | Skip asks for confirmation |
| PR-36 | P2 | Fixed (B1) | Doctor console no longer overflows at 390 px |
| PR-37 | P1 | Fixed (B4) | Reschedule keeps `follow_up_task_id` and moves the task's return pointer in the same transaction |
| PR-38 | P1 | Fixed (B6) | Task detail shows phone (tap to call), MRN and doctor |
| PR-39 | P2 | Fixed (B6) | Return booking defaults to the task's doctor and states the real date range |
| PR-40 | P0 | Fixed (B6) | Admin creates (with repeat), opens, closes and reopens sessions. Recurring doctor schedule templates and leave planning: **future work** (a schedule model is a feature of its own) |
| PR-41 | P1 | Fixed (B6) | Overlapping sessions refused (409 SESSION_OVERLAP); closed sessions do not block |
| PR-42 | P1 | Fixed (B6) | Admin creates staff (one-time temporary password), deactivates/activates, resets passwords. Forced password change at first sign-in: **future work** |
| PR-43 | P2 | Fixed (B5) | Labels by time of day incl. `night` (`sessionLabelFor`, migration 0009); demo script labels correctly |
| PR-44 | P2 | Future work | "Sessions held" counts scheduled sessions; should count sessions that opened. Report wording change, low risk |
| PR-45 | P2 | Fixed (B6) | Audit labels a patient sign-in "User account" |
| PR-46 | P2 | Fixed (B6) | Sessions and staff lists stack under 640 px; dates shown as "Fri, 20 Nov" |
| PR-47 | P2 | Future work | Policy editing creates a new policy version: needs a reviewed workflow (policy changes affect fairness evidence) |
| PR-48 | P1 | Fixed (B1) | Unavailable doctors stay on the display with "not available … please see reception" |
| PR-49 | P2 | Future work | Display pages 6 rooms at a time (OPD 1 on page 2 with 10 doctors); a denser layout or floor grouping. The offline indicator part is fixed (PR-04) |
| PR-50 | — | Pass | Two receptionists on one patient stay consistent |

Also found and fixed after the review, on the real-stack e2e run: display banner leaked the department into the doctor's
name; the Affected-patients list could be ~15 s stale; a fast Enter on reception search was dropped; a moved patient's
original appointment still read "Checked in" (now "Moved to Dr. Y (token)"); the doctor console could open a closed
earlier session after "Unavailable". And from the concurrency/security review (D-039): per-recipient SMS for shared
phones, red-flag negation, batch idempotency for moves, admin lock order, stale fan-out, rate limits, alternatives scope.
