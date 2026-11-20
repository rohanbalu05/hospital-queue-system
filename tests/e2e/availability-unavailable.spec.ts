/**
 * End-to-end, REAL stack (D-032, D-033, D-034): the doctor becomes unavailable for the rest of the session.
 *
 *   doctor A marks "Unavailable for rest of session" (confirmation dialog + reason) -> the booked patient's Today shows the
 *   urgent banner and is notified (worker) -> "Rebook with another doctor" lists doctor B of the same department with the
 *   next slot -> one click books it, the old appointment shows Rescheduled -> reception opens "Affected patients" and moves
 *   the checked-in patients to doctor B's session, sees the per-patient result with new tokens -> the moved patient's My visit
 *   shows the new doctor and token -> the waiting-room display says doctor A is not available for the rest of the session.
 *
 * Nothing is mocked (built API + built worker + Vite + seeded PostgreSQL). API/SQL are used only to prepare the scenario
 * (bookings, check-ins, walk-in) and to verify the database afterwards.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { login } from '../support/client.js';
import {
  API,
  EVIDENCE,
  admitWalkIn,
  bookAs,
  checkIn,
  clock,
  createSession,
  loginByKeyboard,
  newContext,
  newPool,
  newProblems,
  patientEmail,
  pressByKeyboard,
  resetToday,
  selectReceptionSession,
  shot,
  summariseFourXx,
  tabTo,
  watch,
} from './fixtures.js';

const RAW = path.join(EVIDENCE, 'e2e-availability-unavailable.raw.json');

const P_QUEUED = 10; // Farida Begum: booked with doctor A, checked in (appointment group A)
const P_BOOKED = 2; // Sunita Devi: booked with doctor A, has not arrived
const P_WALKIN = 4; // Anitha Shankar: walk-in with doctor A, waiting
const NAME: Record<number, string> = { 10: 'Farida Begum', 2: 'Sunita Devi', 4: 'Anitha Shankar' };
const REASON = 'Called to emergency theatre';

async function openBell(page: Page) {
  await page.getByTestId('notification-bell').click();
  const sheet = page.getByRole('dialog', { name: 'Notifications' });
  await expect(sheet).toBeVisible();
  return sheet;
}
async function closeBell(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Notifications' })).toHaveCount(0);
}

test('unavailable -> urgent banner, notification, one-click rebook, reception moves the queue, display says so', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  await resetToday();
  const admin = await login(API(), 'admin@hqms.test');
  const reception = await login(API(), 'reception2@hqms.test');
  const A = await createSession(1, admin);
  const B = await createSession(2, admin);
  const problems = newProblems();
  const timings: Record<string, number> = {};

  // ---------------------------------------------------------------- fixture (API only)
  const apptQueued = await bookAs(P_QUEUED, A.sessionId); // first bookable slot
  const apptBooked = await bookAs(P_BOOKED, A.sessionId); // next slot, 20 minutes later; not arrived
  const inQ = await checkIn(reception, apptQueued.id);
  const inW = await admitWalkIn(reception, A.sessionId, P_WALKIN);
  expect(inQ.token).toBe('A-001');
  expect(inW.token).toBe('W-001');

  const ctxs = {
    doctor: await newContext(browser, 1440, 900),
    doctorNarrow: await newContext(browser, 390, 844, 2),
    booked: await newContext(browser, 390, 844, 2),
    bookedWide: await newContext(browser, 1440, 900),
    queued: await newContext(browser, 390, 844, 2),
    queuedWide: await newContext(browser, 1440, 900),
    display: await newContext(browser, 1920, 1080),
    reception: await newContext(browser, 1440, 900),
    receptionNarrow: await newContext(browser, 390, 844, 2),
  };
  const page = {
    doctor: await ctxs.doctor.newPage(),
    doctorNarrow: await ctxs.doctorNarrow.newPage(),
    booked: await ctxs.booked.newPage(),
    bookedWide: await ctxs.bookedWide.newPage(),
    queued: await ctxs.queued.newPage(),
    queuedWide: await ctxs.queuedWide.newPage(),
    display: await ctxs.display.newPage(),
    reception: await ctxs.reception.newPage(),
    receptionNarrow: await ctxs.receptionNarrow.newPage(),
  };
  for (const [who, p] of Object.entries(page)) watch(p, who, problems);

  const pool = newPool();
  try {
    // -------------------------------------------------------------- 1. log in, open the screens
    await loginByKeyboard(page.doctor, 'doctor@hqms.test');
    await page.doctor.goto(`/doctor?session=${A.sessionId}`);
    await expect(page.doctor.getByRole('heading', { name: 'Doctor console', level: 1 })).toBeVisible();
    await expect(page.doctor.getByText(/Last updated/)).toBeVisible();
    await loginByKeyboard(page.doctorNarrow, 'doctor@hqms.test');
    await page.doctorNarrow.goto(`/doctor?session=${A.sessionId}`);
    await expect(page.doctorNarrow.getByText(/Last updated/)).toBeVisible();

    await loginByKeyboard(page.booked, patientEmail(P_BOOKED));
    await loginByKeyboard(page.bookedWide, patientEmail(P_BOOKED));
    await page.booked.goto('/patient');
    await expect(page.booked.getByTestId('today-appointment')).toContainText(A.doctorName);
    await expect(page.booked.getByTestId('availability-banner')).toHaveCount(0);
    await shot(page.booked, '32-patient-booked-before-390', true);

    await loginByKeyboard(page.queued, patientEmail(P_QUEUED));
    await page.queued.goto(`/patient/visit/${A.sessionId}`);
    await expect(page.queued.getByText(inQ.token).first()).toBeVisible();
    await loginByKeyboard(page.queuedWide, patientEmail(P_QUEUED));

    await page.display.goto('/display');
    const colA = page.display.getByRole('region', { name: new RegExp(`${A.roomLabel}, `) });
    const colB = page.display.getByRole('region', { name: new RegExp(`${B.roomLabel}, `) });
    await expect(colA).toBeVisible();
    await expect(colB).toBeVisible();
    await expect(page.display.getByTestId('display-column')).toHaveCount(2);
    await shot(page.display, '32-display-before-1920');

    await loginByKeyboard(page.reception, 'reception2@hqms.test');
    await selectReceptionSession(page.reception, A);
    await loginByKeyboard(page.receptionNarrow, 'reception2@hqms.test');
    await selectReceptionSession(page.receptionNarrow, A);

    // -------------------------------------------------------------- 2. doctor A: Unavailable for rest of session (keyboard)
    await pressByKeyboard(page.doctor, page.doctor.getByRole('button', { name: 'Unavailable for rest of session' }));
    const dialog = page.doctor.getByRole('dialog', { name: /Unavailable for the rest of this session/ });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('This cannot be undone');
    // The confirm button names the consequence; an empty reason is refused first.
    const confirm = dialog.getByRole('button', { name: 'Mark unavailable and notify patients' });
    await tabTo(page.doctor, dialog.getByLabel('Reason'));
    await page.doctor.keyboard.press('Tab'); // past the field to Cancel
    await tabTo(page.doctor, confirm);
    await page.doctor.keyboard.press('Enter');
    await expect(dialog.getByText('Give a reason of at least 3 characters.')).toBeVisible();
    await dialog.getByLabel('Reason').focus();
    await page.doctor.keyboard.type(REASON);
    await shot(page.doctor, '30-doctor-unavailable-dialog-1440');
    await tabTo(page.doctor, confirm);
    const tUnavailable = Date.now();
    await page.doctor.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);

    const strip = page.doctor.getByTestId('availability-strip');
    await expect(strip).toHaveAttribute('data-state', 'unavailable');
    await expect(strip).toContainText('You are unavailable for the rest of this session');
    await expect(strip).toContainText(`Reason: ${REASON}`);
    await expect(page.doctor.locator('#call-blocked')).toContainText('unavailable for the rest of this session');
    await expect(page.doctor.getByRole('button', { name: 'Unavailable for rest of session' })).toBeDisabled();
    timings['unavailableToDoctorStripMs'] = Date.now() - tUnavailable;
    await shot(page.doctor, '31-doctor-unavailable-1440', true);
    await expect(page.doctorNarrow.getByTestId('availability-strip')).toHaveAttribute('data-state', 'unavailable');
    await shot(page.doctorNarrow, '31-doctor-unavailable-390', true);

    // -------------------------------------------------------------- 3. display: doctor A's column says so (live, no reload)
    const displayBanner = colA.getByTestId('display-banner');
    await expect(displayBanner).toHaveAttribute('data-state', 'unavailable');
    timings['unavailableToDisplayMs'] = Date.now() - tUnavailable;
    await expect(displayBanner).toContainText('is not available for the rest of this session');
    await expect(displayBanner).toContainText('Please see reception');
    await expect(colB.getByTestId('display-banner')).toHaveCount(0);
    await shot(page.display, '33-display-unavailable-1920');

    // -------------------------------------------------------------- 4. reception sees the strip live and the way into Affected patients
    const recepStrip = page.reception.getByTestId('availability-strip');
    await expect(recepStrip).toHaveAttribute('data-state', 'unavailable');
    await expect(recepStrip).toContainText(`${A.doctorName} is unavailable for the rest of this session`);
    await expect(page.reception.getByRole('button', { name: /Affected patients/ })).toBeVisible();
    await expect(page.receptionNarrow.getByTestId('availability-strip')).toHaveAttribute('data-state', 'unavailable');

    // -------------------------------------------------------------- 5. the booked patient: urgent banner, notification, rebook
    await page.booked.reload();
    const banner = page.booked.getByTestId('availability-banner');
    await expect(banner).toHaveAttribute('data-state', 'unavailable');
    await expect(banner).toHaveAttribute('role', 'alert');
    await expect(banner).toContainText(`${A.doctorName} is not available for the rest of this session`);
    await expect(banner.getByRole('link', { name: 'Rebook with another doctor' })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Cancel appointment' })).toBeVisible();
    await shot(page.booked, '34-patient-booked-unavailable-390', true);
    await page.bookedWide.goto('/patient');
    await expect(page.bookedWide.getByTestId('availability-banner')).toHaveAttribute('data-state', 'unavailable');
    await shot(page.bookedWide, '34-patient-booked-unavailable-1440', true);

    await expect(page.booked.getByTestId('notification-bell')).toHaveAttribute(
      'aria-label',
      /Notifications, \d+ unread/,
      { timeout: 25_000 },
    );
    timings['unavailableToBookedBellMs'] = Date.now() - tUnavailable;
    const sheet = await openBell(page.booked);
    const note = sheet.getByTestId('notification').filter({ hasText: 'not available for the rest of' }).first();
    await expect(note).toBeVisible();
    await expect(note).toContainText('rebook with another General Medicine doctor');
    await expect(note).toHaveAttribute('data-severity', 'urgent');
    const noteText = (await note.innerText()).replace(/\s+/g, ' ');
    await shot(page.booked, '35-patient-notification-unavailable-390');
    await closeBell(page.booked);
    const wideSheet = await openBell(page.bookedWide);
    await expect(
      wideSheet.getByTestId('notification').filter({ hasText: 'not available for the rest of' }).first(),
    ).toBeVisible();
    await shot(page.bookedWide, '35-patient-notification-unavailable-1440');
    await closeBell(page.bookedWide);

    // The checked-in patients are told to see reception, in-app.
    await expect(page.queued.getByTestId('notification-bell')).toHaveAttribute(
      'aria-label',
      /Notifications, \d+ unread/,
      { timeout: 25_000 },
    );
    await expect(page.queued.getByTestId('availability-banner')).toHaveAttribute('data-state', 'unavailable');
    await expect(page.queued.getByTestId('availability-banner')).toContainText('Please see reception');
    await shot(page.queued, '36-patient-queued-unavailable-390', true);

    // Rebook with another doctor, keyboard: Tab to the link, Enter.
    await pressByKeyboard(page.booked, banner.getByRole('link', { name: 'Rebook with another doctor' }));
    await expect(page.booked).toHaveURL(/\/patient\/visits\?rebook=/);
    const panel = page.booked.getByTestId('rebook-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(`${A.doctorName} is not available for the rest of this session`);
    const options = panel.getByTestId('rebook-option');
    await expect(options.first()).toBeVisible();
    // Only doctors of the same department (General Medicine) are offered, never the unavailable doctor.
    const optionTexts = await options.allInnerTexts();
    for (const text of optionTexts) {
      expect(text).toContain('General Medicine');
      expect(text).not.toContain(A.doctorName);
    }
    // Doctor B's session today comes first, then his sessions on the following days (up to six options in all).
    const optionB = options.filter({ hasText: B.doctorName }).filter({ hasText: 'Today' });
    await expect(optionB).toHaveCount(1);
    await expect(options.first()).toContainText('Today');
    const nextSlotText = (await optionB.innerText()).replace(/\s+/g, ' ');
    const nextSlotClock = /Next slot (\d{1,2}:\d{2} (?:am|pm))/.exec(nextSlotText)?.[1];
    expect(nextSlotClock, nextSlotText).toBeTruthy();
    const bookButton = optionB.getByRole('button', { name: new RegExp(`^Book ${nextSlotClock} with ${B.doctorName}`) });
    await expect(bookButton).toBeVisible();
    await shot(page.booked, '37-patient-rebook-options-390', true);
    const tRebook = Date.now();
    await pressByKeyboard(page.booked, bookButton);
    const done = page.booked.getByTestId('rebook-done');
    await expect(done).toBeVisible();
    timings['rebookClickToConfirmedMs'] = Date.now() - tRebook;
    await expect(done).toContainText(B.doctorName);
    await expect(done).toContainText(nextSlotClock as string);
    await expect(done).toContainText('Your earlier appointment has been released');
    await shot(page.booked, '38-patient-rebooked-390', true);

    // Today and My visits now show the new doctor and time; the old appointment is Rescheduled.
    await pressByKeyboard(page.booked, done.getByRole('button', { name: 'See my visits' }));
    const upcomingB = page.booked.getByTestId('visit-line').filter({ hasText: B.doctorName });
    await expect(upcomingB).toHaveCount(1);
    await expect(upcomingB).toContainText(nextSlotClock as string);
    await expect(
      page.booked.getByTestId('visit-line').filter({ hasText: A.doctorName }).filter({ hasText: 'Booked' }),
    ).toHaveCount(0);
    await page.booked.getByRole('button', { name: /Past and cancelled/ }).click();
    const oldLine = page.booked
      .getByTestId('visit-line')
      .filter({ hasText: A.doctorName })
      .filter({ hasText: 'Rescheduled' });
    await expect(oldLine).toHaveCount(1);
    await shot(page.booked, '39-patient-visits-after-rebook-390', true);
    await page.bookedWide.goto('/patient');
    await expect(page.bookedWide.getByTestId('today-appointment')).toHaveCount(1);
    await expect(page.bookedWide.getByTestId('today-appointment')).toContainText(B.doctorName);
    await expect(page.bookedWide.getByTestId('today-appointment')).toContainText(nextSlotClock as string);
    await expect(page.bookedWide.getByTestId('availability-banner')).toHaveCount(0);
    await shot(page.bookedWide, '39-patient-today-after-rebook-1440', true);
    await page.booked.goto('/patient');
    await expect(page.booked.getByTestId('today-appointment')).toContainText(B.doctorName);
    await shot(page.booked, '39-patient-today-after-rebook-390', true);

    // -------------------------------------------------------------- 6. reception: Affected patients -> move the queue to doctor B
    const affectedButton = page.reception.getByRole('button', { name: /Affected patients/ });
    await expect(affectedButton).toBeVisible();
    await affectedButton.focus();
    await page.reception.keyboard.press('Enter');
    const affected = page.reception.getByRole('dialog', { name: /Affected patients/ });
    await expect(affected).toBeVisible();
    await expect(affected.getByRole('heading', { name: `Affected patients, ${A.doctorName}` })).toBeVisible();
    const inQueue = affected.getByRole('region', { name: 'In the queue' });
    await expect(inQueue).toContainText(NAME[P_QUEUED] as string);
    await expect(inQueue).toContainText(NAME[P_WALKIN] as string);
    // The patient who rebooked herself is no longer in this session's list: nobody is moved twice. The list is polled
    // every 20 s (staleTime 5 s), so a list opened a moment after her rebook can still show her until the next refresh.
    const tList = Date.now();
    await expect(affected.getByRole('region', { name: 'Booked, not arrived' })).not.toContainText(
      NAME[P_BOOKED] as string,
      { timeout: 30_000 },
    );
    timings['affectedListDroppedRebookedPatientAfterMs'] = Date.now() - tList;
    await affected.getByLabel('Select all').click();
    await expect(affected.getByTestId('affected-count')).toContainText('2 of 2 selected');
    const target = affected.getByRole('radio', { name: new RegExp(`${B.doctorName}.*Today`) });
    await expect(target).toBeVisible();
    await target.click();
    const moveButton = affected.getByRole('button', { name: `Move 2 patients to ${B.doctorName}` });
    await expect(moveButton).toBeEnabled();
    await shot(page.reception, '40-reception-affected-1440');
    const tMove = Date.now();
    await moveButton.focus();
    await page.reception.keyboard.press('Enter');
    const results = affected.getByTestId('move-results');
    await expect(results).toBeVisible();
    timings['moveClickToResultsMs'] = Date.now() - tMove;
    await expect(results).toContainText(`2 moved to ${B.doctorName}`);
    const movedRows = results.locator('li[data-outcome="moved"]');
    await expect(movedRows).toHaveCount(2);
    const newTokens: Record<string, string> = {};
    for (const n of [P_QUEUED, P_WALKIN]) {
      const row = movedRows.filter({ hasText: NAME[n] as string });
      await expect(row).toHaveCount(1);
      const token = /New token ([A-Z]-\d{3})/.exec(await row.innerText())?.[1];
      expect(token, `result row for ${NAME[n]}`).toBeTruthy();
      newTokens[NAME[n] as string] = token as string;
    }
    await shot(page.reception, '41-reception-move-results-1440');
    await page.reception.keyboard.press('Escape');
    // The board of doctor A no longer lists them as waiting.
    await expect(affected).toHaveCount(0);

    // Narrow reception: the affected dialog and its (empty) state at 390.
    await page.receptionNarrow.getByRole('button', { name: /Affected patients/ }).click();
    const affectedNarrow = page.receptionNarrow.getByRole('dialog', { name: /Affected patients/ });
    await expect(affectedNarrow).toBeVisible();
    await shot(page.receptionNarrow, '41-reception-affected-after-390');
    await page.receptionNarrow.keyboard.press('Escape');

    // -------------------------------------------------------------- 7. the moved patient follows to doctor B
    await page.queuedWide.goto('/patient');
    const moved = page.queuedWide.getByTestId('today-visit').filter({ hasText: B.doctorName });
    await expect(moved).toHaveCount(1);
    await expect(moved).toContainText(newTokens[NAME[P_QUEUED] as string] as string);
    await shot(page.queuedWide, '42-patient-moved-today-1440', true);
    await page.queued.goto(`/patient/visit/${B.sessionId}`);
    await expect(page.queued.getByText(newTokens[NAME[P_QUEUED] as string] as string).first()).toBeVisible();
    await expect(page.queued.getByTestId('visit-state')).toHaveText('You are in the queue');
    await expect(page.queued.getByTestId('availability-banner')).toHaveCount(0);
    await shot(page.queued, '42-patient-moved-visit-390', true);
    await expect(page.queued.getByTestId('notification-bell')).toHaveAttribute(
      'aria-label',
      /Notifications, \d+ unread/,
      { timeout: 25_000 },
    );
    const movedSheet = await openBell(page.queued);
    const movedNote = movedSheet.getByTestId('notification').filter({ hasText: 'You have been moved to' }).first();
    await expect(movedNote).toContainText(B.doctorName);
    await expect(movedNote).toContainText(`Your new token is ${newTokens[NAME[P_QUEUED] as string]}`);
    await shot(page.queued, '43-patient-moved-notification-390');
    await closeBell(page.queued);

    // Doctor B's column on the display now shows the moved patients as next; A's column keeps the unavailable banner.
    await expect(colB.getByTestId('next-tokens')).toContainText(newTokens[NAME[P_QUEUED] as string] as string);
    await expect(colA.getByTestId('display-banner')).toContainText('is not available for the rest of this session');
    await shot(page.display, '44-display-after-move-1920');

    // -------------------------------------------------------------- 8. what the database says
    const old = await pool.query(`SELECT status FROM appointments WHERE id = $1`, [apptBooked.id]);
    expect(old.rows[0].status).toBe('rescheduled');
    const next = await pool.query(
      `SELECT a.status, a.session_id, a.scheduled_at, a.rescheduled_from_id FROM appointments a WHERE a.rescheduled_from_id = $1`,
      [apptBooked.id],
    );
    expect(next.rows).toHaveLength(1);
    expect(next.rows[0].session_id).toBe(B.sessionId);
    expect(next.rows[0].status).toBe('booked');
    expect(clock(next.rows[0].scheduled_at)).toBe(nextSlotClock);
    const visits = await pool.query(
      `SELECT p.full_name, v.kind, v.status, v.session_id, q.token, q.state
         FROM visits v JOIN patients p ON p.id = v.patient_id JOIN queue_entries q ON q.visit_id = v.id
        WHERE p.full_name = ANY($1) ORDER BY p.full_name, v.created_at`,
      [[NAME[P_QUEUED], NAME[P_WALKIN]]],
    );
    const byPatient = (name: string) => visits.rows.filter((r) => r.full_name === name);
    for (const n of [P_QUEUED, P_WALKIN]) {
      const rows = byPatient(NAME[n] as string);
      expect(rows.map((r) => `${r.kind}/${r.status}/${r.state}`)).toEqual([
        'appointment/transferred/cancelled'.replace('appointment', n === P_WALKIN ? 'walkin' : 'appointment'),
        'transfer/open/waiting',
      ]);
      expect(rows[1].session_id).toBe(B.sessionId);
    }
    const sessionA = await pool.query(`SELECT status, pause_reason FROM sessions WHERE id = $1`, [A.sessionId]);
    expect(sessionA.rows[0].status).toBe('unavailable');
    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events WHERE session_id = ANY($1) AND event_type IN ('SessionUnavailable','QueuePatientTransferred','AppointmentRescheduled') ORDER BY position`,
      [[A.sessionId, B.sessionId]],
    );
    const deliveries = await pool.query<{
      event_type: string;
      channel: string;
      recipient: string;
      status: string;
      n: number;
    }>(
      `SELECT e.event_type, d.channel, CASE WHEN d.patient_id IS NOT NULL THEN 'patient' ELSE 'staff' END AS recipient, d.status, count(*)::int AS n
         FROM notification_deliveries d JOIN outbox_events e ON e.id = d.event_id
        WHERE d.session_id = ANY($1) GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`,
      [[A.sessionId, B.sessionId]],
    );
    const notSent = deliveries.rows.filter((r) => r.status !== 'sent');

    mkdirSync(path.dirname(RAW), { recursive: true });
    writeFileSync(
      RAW,
      `${JSON.stringify(
        {
          spec: 'availability-unavailable',
          fixture: {
            doctorA: A,
            doctorB: B,
            tokens: { queuedAppointment: inQ.token, walkin: inW.token },
            reason: REASON,
          },
          rebook: {
            nextSlotShownForDoctorB: nextSlotClock,
            optionsShown: optionTexts.length,
            notificationText: noteText,
          },
          reception: { newTokens },
          timingsMs: timings,
          databaseAfter: {
            sessionAStatus: sessionA.rows[0].status,
            oldAppointmentStatus: old.rows[0].status,
            newAppointment: { status: next.rows[0].status, scheduledAt: next.rows[0].scheduled_at },
            visitsOfMovedPatients: visits.rows,
            outboxEvents: events.rows.map((r) => r.event_type),
            deliveriesByEventChannelRecipientStatus: deliveries.rows,
            deliveriesNotSent: notSent.length,
          },
          fourXxResponsesSeenByBrowsers: summariseFourXx(problems.fourXx),
          fiveXxResponses: problems.fiveXx,
          pageErrors: problems.pageErrors,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await pool.end();
    await Promise.all(Object.values(ctxs).map((c) => c.close()));
  }

  expect(problems.fiveXx, 'no 5xx response anywhere in the flow').toEqual([]);
  expect(problems.pageErrors, 'no uncaught page error').toEqual([]);
});
