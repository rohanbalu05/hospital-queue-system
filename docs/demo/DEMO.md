# HQMS demo script (click path)

A 15-20 minute walk through one hospital morning, including the real-world cases the first review said were missing:
the doctor steps away and comes back, the doctor leaves for the rest of the session, and patients and staff are told.
Every step below was checked against the running stack on the session-3 build. It does not depend on the time of day:
the launcher opens a running session for Dr. Hegde and Dr. Narayan at any hour, labelled for that hour.

## 0. Start (2 minutes before the demo)

| Machine | Do this |
| --- | --- |
| macOS | `./start-demo.sh` (Homebrew `postgresql@16`; see README "macOS") |
| Windows | double-click `start-demo.bat` (see README "Windows") |
| Linux / Codespaces | `./init.sh`, then `pnpm dev`, then `node scripts/demo-session-now.mjs` |

Each launcher resets the demo data to today, starts api + worker + web and prints a line like
`[demo-session] OPEN: Dr. Suresh Hegde, Morning session 09:00-13:00 IST (seeded)`.
Open four browser windows (or profiles) side by side and sign in. Every password is `demo1234`.

| Window | URL | Account |
| --- | --- | --- |
| Patient (phone size, ~390 px wide) | http://localhost:5173 | `patient2@hqms.test` (Sunita Devi) |
| Reception | http://localhost:5173 | `reception@hqms.test` |
| Doctor | http://localhost:5173 | `doctor@hqms.test` (Dr. Suresh Hegde, General Medicine, OPD 1) |
| Waiting-room display (big screen) | http://localhost:5173/display | no login |

Keep a fifth tab for `admin@hqms.test` and `followup@hqms.test` later.

Check first: Admin home shows **Background work: Worker running**. If it says *Worker stopped*, the worker is not running
and timers and notifications will not happen.

## 1. Book, check in, call (the normal day, 3 min)

1. **Patient** → **Book** → *General Medicine* → *Dr. Suresh Hegde* → today → the running session → **Book**.
   The confirmation shows the time given. Booking never assigns a slot whose late-grace window is about to close
   (D-035), so the patient always has at least 10 minutes to arrive.
2. **Patient** → **Today**: the appointment, with "Check in at reception when you arrive". (No queue link yet: the
   queue position appears after check-in.)
3. **Reception** → choose *Dr. Suresh Hegde* and the running session → press `/`, type `Sunita`, wait for the row,
   press **Enter** (keyboard only). The board shows her token. (Enter only acts on rows that match what is typed.)
4. Admit a walk-in: search a name with no booking (e.g. `Kiran`), **Register new patient** if needed, then **Admit walk-in**.
   Registering the same phone twice shows **This may be an existing patient** with the match.
5. **Doctor** → press `N`, then **Enter** to call next. The reason appears ("Called by rotation …"). **Start**, then
   **Complete**. After completing, **Create follow-up** is offered for the patient just seen.
6. **Display** shows *Now calling* and *Next* tokens only, never names.

## 2. The doctor steps away and comes back (5 min)

1. **Doctor** → **Step away** → reason **Break** → **15 min** (or *Custom time*) → **Step away**.
   The console shows "You are away · since … · expected back about hh:mm". **Call next** is disabled with the reason.
   The queue order is kept. (If a patient has been called but not started, Step away is refused: start or skip first.)
2. **Patient** → **My visit** (from Today, *See my place in the queue*): banner "Dr. Suresh Hegde has stepped away and is
   expected back about hh:mm. Your place in the queue is kept." The wait estimate now starts no earlier than the
   expected return.
3. **Patient** → the **bell** (top right) shows an unread count. Open it: "Dr. Suresh Hegde has stepped away and is
   expected back about hh:mm …". **Open** goes to My visit; **Mark all as read** clears the badge.
4. **Display**: the OPD 1 column says "Dr. Hegde is temporarily away, expected back about hh:mm".
5. **Reception**: the board shows the away banner; the receptionist's bell has "Dr. Suresh Hegde stepped away (back about
   hh:mm). N waiting, M booked not arrived." Reception can also use **Step away / I'm back** for the doctor.
6. **Admin** → **Notifications sent**: one row per recipient per channel: *In-app*, *SMS* (masked number) and *Email*,
   status *Sent*, provider *fake*. No real SMS or email is sent: the NotificationProvider adapter is the fake one.
7. Optional: **Doctor** → **Change return time** → 30 min. Patients get "Update: …" with the new time.
8. **Doctor** → **I'm back**. Every screen clears the banner live (no reload). The patient gets "Dr. Suresh Hegde is back
   and seeing patients again." Press `N`, **Enter**: the next patient is the one who was next before the break.

## 3. The doctor leaves for the rest of the session (5 min)

1. **Patient** (`patient2`): book again with Dr. Hegde (or use a booking that is not yet checked in).
2. **Doctor** → **Unavailable for rest of session** → reason (e.g. "Called to theatre") → **Mark unavailable and notify
   patients**. The dialog says this cannot be undone by the doctor.
3. **Patient** → **Today**: urgent banner "Dr. Suresh Hegde is not available for the rest of this session" with
   **Rebook with another doctor** and **Cancel appointment**. The bell has the same message.
4. **Rebook with another doctor**: other General Medicine doctors' sessions with their next slot and places left. Click
   **Book hh:mm with Dr. Lakshmi Narayan**. Today now shows the new doctor and time; the old appointment is *Rescheduled*.
5. **Reception** → the board shows the unavailable banner; **Check in** is disabled for that session. Click
   **Affected patients (N)**: *In the queue* and *Booked, not arrived*. Tick patients, choose **Dr. Lakshmi Narayan**'s
   session, **Move N patients to Dr. Lakshmi Narayan**. Each row shows the new token or time, or why it was skipped
   (e.g. no place left: capacity rules apply). A moved patient's My visit shows the new doctor and token.
6. **Display**: OPD 1 says "Dr. Hegde is not available for the rest of this session. Please see reception."
7. **Admin** → **Sessions and capacity**: the session is *Unavailable*; **Reopen** (with a reason) undoes a mistaken
   unavailable while the session has not ended. Patients already moved stay moved; the rest are told the doctor is
   available again.

## 4. Admin, reception desk and follow-up (optional, 5 min)

- **Admin** → **Sessions and capacity** → **New session**: doctor, date, times (label filled in from the time of day),
  capacities, *Repeat for the next N days*. An overlapping session is refused with the clashing times.
- **Admin** → **Staff** → **Add staff member**: the temporary password is shown once. **Deactivate**, **Reset password**.
- **Reception** → **Open patient desk** for a patient: book, cancel or reschedule for them (works for patients registered
  at the desk, who have no login). When walk-in places are full, **Other doctors in General Medicine today** offers
  *Admit to Dr. …*.
- **Patient** (`patient@hqms.test`) → **Questions** → "I have chest pain after the new tablets, should I stop them?":
  the urgent advice (call 108 / Emergency) is shown first and an urgent task is created for the care team (due in 2 h).
- **Follow-up** (`followup@hqms.test`) → **Inbox**: urgent tasks first. Open the task: the patient's phone (tap to call),
  MRN and doctor. Resolve with **Advice given**, a **Reply to the patient** (the patient reads it) and a staff-only note.
- **Patient** → **Follow-ups**: "Reply from the care team".

## 5. If something goes wrong

| Symptom | Fix |
| --- | --- |
| Admin says *Worker stopped* | the worker is not running; restart the launcher (it starts api, worker and web) |
| No session to choose for Dr. Hegde | run `node scripts/demo-session-now.mjs` (it prints what it opened) |
| A screen says *Reconnecting…* | the live connection dropped; it refetches by itself when the network is back |
| Booking says no free slot | the session is nearly over; the demo script opens or creates a running one |
