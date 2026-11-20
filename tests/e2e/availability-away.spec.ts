/**
 * End-to-end, REAL stack (D-032, D-034): the doctor steps away and comes back.
 *
 *   doctor calls, starts and completes one patient -> Step away (Break, 15 min) -> call-next is blocked with the reason
 *   -> the waiting patient's My visit, the booked patient's Today, the waiting-room display and the reception board
 *   all say "away, back about hh:mm" live -> the worker fans the event out: in-app notification (patient bell) plus SMS
 *   through the fake provider, listed in Admin > Notifications sent -> I'm back -> every banner clears live, the patient
 *   is told, and the next Call next calls the patient who was next before the doctor stepped away.
 *
 * Nothing is mocked: built API, built worker (fake notification provider), Vite dev server, freshly seeded PostgreSQL.
 * The API/SQL are used only to prepare the scenario (bookings, check-ins, walk-ins) and to verify the database after.
 * The doctor's whole interaction (call, start, complete, step away, I'm back, call) is keyboard only.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { type ApiClient, login } from '../support/client.js';
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

const RAW = path.join(EVIDENCE, 'e2e-availability-away.raw.json');

// Seeded patients (logins patient6@ .. patient9@). None of them is used by another e2e spec.
const P_APPT = 6; // Pooja Hegde: booked, checked in, called and completed before the doctor steps away
const P_BOOKED = 7; // Mohan Das: booked, has not arrived (gets the "running behind" wording and the booked banner)
const P_WALK1 = 8; // Lakshmi Bai: walk-in, waiting (the patient we watch live)
const P_WALK2 = 9; // Santosh Patil: walk-in, waiting behind her
const NAME: Record<number, string> = { 6: 'Pooja Hegde', 7: 'Mohan Das', 8: 'Lakshmi Bai', 9: 'Santosh Patil' };

/** Wait for a UI condition and return how long it took, in ms, from `since`. */
async function seenAfter(since: number, check: () => Promise<unknown>): Promise<number> {
  await check();
  return Date.now() - since;
}

async function openBell(page: Page): Promise<Locator> {
  await page.getByTestId('notification-bell').click();
  const sheet = page.getByRole('dialog', { name: 'Notifications' });
  await expect(sheet).toBeVisible();
  return sheet;
}

async function closeBell(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Notifications' })).toHaveCount(0);
}

test('away -> patient, display, reception and admin log all follow -> back -> same order continues', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  await resetToday();
  const admin = await login(API(), 'admin@hqms.test');
  const reception: ApiClient = await login(API(), 'reception2@hqms.test');
  const fx = await createSession(1, admin);
  const problems = newProblems();
  const timings: Record<string, number> = {};

  // ---------------------------------------------------------------- fixture (API only): who is in the room
  const apptP = await bookAs(P_APPT, fx.sessionId); // the session's first bookable slot, a few minutes ahead and already eligible
  await bookAs(P_BOOKED, fx.sessionId); // the next slot, 20 minutes later; this patient has not arrived
  const inP = await checkIn(reception, apptP.id);
  const w1 = await admitWalkIn(reception, fx.sessionId, P_WALK1);
  const w2 = await admitWalkIn(reception, fx.sessionId, P_WALK2);
  expect(inP.token).toBe('A-001');
  const tokens = { appointment: inP.token, walk1: w1.token, walk2: w2.token };

  // ---------------------------------------------------------------- six browser contexts, real people
  const doctorCtx = await newContext(browser, 1440, 900);
  const doctorNarrowCtx = await newContext(browser, 390, 844, 2);
  const patientCtx = await newContext(browser, 390, 844, 2); // Lakshmi Bai, waiting
  const patientWideCtx = await newContext(browser, 1440, 900); // the same Lakshmi Bai on a desktop
  const bookedCtx = await newContext(browser, 390, 844, 2); // Mohan Das, booked
  const displayCtx = await newContext(browser, 1920, 1080);
  const receptionCtx = await newContext(browser, 1440, 900);
  const receptionNarrowCtx = await newContext(browser, 390, 844, 2);
  const adminCtx = await newContext(browser, 1440, 900);
  const adminNarrowCtx = await newContext(browser, 390, 844, 2);
  const doctor = await doctorCtx.newPage();
  const doctorNarrow = await doctorNarrowCtx.newPage();
  const patient = await patientCtx.newPage();
  const patientWide = await patientWideCtx.newPage();
  const booked = await bookedCtx.newPage();
  const display = await displayCtx.newPage();
  const recep = await receptionCtx.newPage();
  const recepNarrow = await receptionNarrowCtx.newPage();
  const adminPage = await adminCtx.newPage();
  const adminNarrow = await adminNarrowCtx.newPage();
  const pages: Array<[Page, string]> = [
    [doctor, 'doctor'],
    [doctorNarrow, 'doctor-390'],
    [patient, 'patient-w1'],
    [patientWide, 'patient-w1-1440'],
    [booked, 'patient-booked'],
    [display, 'display'],
    [recep, 'reception'],
    [recepNarrow, 'reception-390'],
    [adminPage, 'admin'],
    [adminNarrow, 'admin-390'],
  ];
  for (const [page, who] of pages) watch(page, who, problems);

  const pool = newPool();
  try {
    // -------------------------------------------------------------- 1. everyone logs in and opens their screen
    await loginByKeyboard(doctor, 'doctor@hqms.test');
    await expect(doctor.getByRole('heading', { name: 'Doctor console', level: 1 })).toBeVisible();
    await expect(doctor.getByText(/Last updated/)).toBeVisible();
    await expect(doctor.getByRole('region', { name: 'Waiting, in call order' })).toContainText(NAME[P_WALK1] as string);

    await loginByKeyboard(patient, patientEmail(P_WALK1));
    await expect(patient).toHaveURL(/\/patient/);
    await patient.goto(`/patient/visit/${fx.sessionId}`);
    await expect(patient.getByText(w1.token).first()).toBeVisible();
    await expect(patient.getByTestId('visit-state')).toHaveText('You are in the queue');

    await loginByKeyboard(patientWide, patientEmail(P_WALK1));
    await patientWide.goto(`/patient/visit/${fx.sessionId}`);
    await expect(patientWide.getByText(w1.token).first()).toBeVisible();

    await loginByKeyboard(booked, patientEmail(P_BOOKED));
    await expect(booked.getByTestId('today-appointment')).toBeVisible();

    await display.goto('/display');
    const column = display.getByRole('region', { name: new RegExp(`${fx.roomLabel}, `) });
    await expect(column).toBeVisible();
    await expect(display.getByTestId('display-column')).toHaveCount(1);

    await loginByKeyboard(recep, 'reception2@hqms.test');
    await selectReceptionSession(recep, fx);
    await expect(recep.getByTestId('availability-strip')).toHaveCount(0);

    await loginByKeyboard(recepNarrow, 'reception2@hqms.test');
    await selectReceptionSession(recepNarrow, fx);
    await loginByKeyboard(doctorNarrow, 'doctor@hqms.test');
    await expect(doctorNarrow.getByRole('heading', { name: 'Doctor console', level: 1 })).toBeVisible();

    // -------------------------------------------------------------- 2. the doctor sees one patient, keyboard only
    const callNext = doctor.getByRole('button', { name: /^Call next/ });
    await doctor.keyboard.press('n');
    await expect(callNext).toBeFocused();
    await doctor.keyboard.press('Enter');
    await expect(doctor.getByTestId('now-active')).toContainText(tokens.appointment);
    await expect(doctor.getByRole('button', { name: 'Start', exact: true })).toBeFocused();
    await doctor.keyboard.press('Enter');
    await expect(doctor.getByTestId('now-state')).toContainText('In service');
    await expect(doctor.getByRole('button', { name: 'Complete', exact: true })).toBeFocused();
    await doctor.keyboard.press('Enter');
    await expect(doctor.getByText('No patient with you')).toBeVisible();

    // Who is next before the doctor steps away: the head of "Waiting, in call order" (the policy's projected order).
    const waiting = doctor.getByRole('region', { name: 'Waiting, in call order' });
    const waitingTokensBefore = await waiting
      .locator('[data-token]')
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset['token'] ?? ''));
    expect(waitingTokensBefore).toEqual([tokens.walk1, tokens.walk2]);
    const nextBefore = waitingTokensBefore[0] as string;
    const decisionsBefore = await pool.query(`SELECT count(*)::int AS n FROM queue_decisions WHERE session_id = $1`, [
      fx.sessionId,
    ]);

    // -------------------------------------------------------------- 3. Step away (Break, 15 min), keyboard only
    await pressByKeyboard(doctor, doctor.getByRole('button', { name: 'Step away', exact: true }));
    const dialog = doctor.getByRole('dialog', { name: 'Step away' });
    await expect(dialog).toBeVisible();
    const breakRadio = dialog.getByRole('radio', { name: 'Break' });
    await breakRadio.focus();
    await doctor.keyboard.press('Space');
    await expect(breakRadio).toBeChecked();
    await pressByKeyboard(doctor, dialog.getByRole('button', { name: '15 min', exact: true }));
    await expect(dialog.getByRole('button', { name: '15 min', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const backAbout = await dialog.getByTestId('back-about').innerText();
    const backClock = /^Back about (.+)$/.exec(backAbout)?.[1];
    expect(backClock, `dialog says "${backAbout}"`).toBeTruthy();
    await shot(doctor, '20-doctor-step-away-dialog-1440');
    await tabTo(doctor, dialog.getByRole('button', { name: 'Step away', exact: true }));
    const tAway = Date.now();
    await doctor.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);

    // -------------------------------------------------------------- 4. the doctor's own screen
    const strip = doctor.getByTestId('availability-strip');
    await expect(strip).toHaveAttribute('data-state', 'away');
    await expect(strip).toContainText('You are away');
    await expect(strip).toContainText(`expected back about ${backClock}`);
    await expect(strip).toContainText('Reason: Break');
    await expect(callNext).toHaveAttribute('aria-disabled', 'true');
    await expect(doctor.locator('#call-blocked')).toContainText('You are away, so no one can be called');
    // Call next is blocked: neither the shortcut nor Enter calls anyone, and the server refuses a direct call too.
    await doctor.keyboard.press('n');
    await doctor.keyboard.press('Enter');
    await expect(doctor.getByText('No patient with you')).toBeVisible();
    const doctorApi = await login(API(), 'doctor@hqms.test');
    const direct = await doctorApi.post(`/sessions/${fx.sessionId}/call-next`, {});
    expect(direct.status).toBe(409);
    expect(direct.body.code ?? direct.body.error?.code).toBe('SESSION_NOT_CALLABLE');
    timings['awayToDoctorStripMs'] = Date.now() - tAway;
    await shot(doctor, '21-doctor-away-1440', true);
    await expect(doctorNarrow.getByTestId('availability-strip')).toContainText('You are away');
    await shot(doctorNarrow, '21-doctor-away-390', true);

    // -------------------------------------------------------------- 5. patient, display, reception follow without a reload
    const banner = patient.getByTestId('availability-banner');
    timings['awayToPatientBannerMs'] = await seenAfter(tAway, () =>
      expect(banner).toHaveAttribute('data-state', 'away'),
    );
    await expect(banner).toContainText(`expected back about ${backClock}`);
    await expect(banner).toContainText('Your place in the queue is kept');
    await expect(banner).toContainText(/Updated wait: about|new estimate|estimate/);
    const bannerText = (await banner.innerText()).replace(/\s+/g, ' ');
    await shot(patient, '22-patient-away-390', true);
    await expect(patientWide.getByTestId('availability-banner')).toContainText(`expected back about ${backClock}`);
    await shot(patientWide, '22-patient-away-1440', true);

    // The booked patient (no queue entry yet) reads the session; reload to be sure this view is current.
    await booked.reload();
    const bookedBanner = booked.getByTestId('availability-banner');
    await expect(bookedBanner).toHaveAttribute('data-state', 'away');
    await expect(bookedBanner).toContainText(`expected back about ${backClock}`);
    await expect(bookedBanner).toContainText('Your appointment is kept');
    await shot(booked, '22-patient-booked-away-390', true);

    const displayBanner = column.getByTestId('display-banner');
    timings['awayToDisplayBannerMs'] = await seenAfter(tAway, () => expect(displayBanner).toBeVisible());
    await expect(displayBanner).toHaveAttribute('data-state', 'away');
    // The display names the doctor by surname (D-028 privacy short label): "Dr. Hegde · General Medicine is temporarily away ...".
    await expect(displayBanner).toContainText(
      new RegExp(`Dr\\. Hegde.* is temporarily away, expected back about ${backClock}`),
    );
    await shot(display, '23-display-away-1920');

    const recepStrip = recep.getByTestId('availability-strip');
    timings['awayToReceptionStripMs'] = await seenAfter(tAway, () =>
      expect(recepStrip).toHaveAttribute('data-state', 'away'),
    );
    await expect(recepStrip).toContainText(`${fx.doctorName} is away`);
    await expect(recepStrip).toContainText(`expected back about ${backClock}`);
    await expect(recep.getByRole('button', { name: /Affected patients/ })).toBeVisible();
    await shot(recep, '24-reception-away-1440', true);
    await expect(recepNarrow.getByTestId('availability-strip')).toContainText(`${fx.doctorName} is away`);
    await shot(recepNarrow, '24-reception-away-390', true);

    // -------------------------------------------------------------- 6. the worker fans the event out: patient bell
    const bell = patient.getByTestId('notification-bell');
    await expect(bell).toHaveAttribute('aria-label', /Notifications, \d+ unread/, { timeout: 25_000 });
    timings['awayToPatientBellMs'] = Date.now() - tAway;
    const unreadAfterAway = Number(/(\d+) unread/.exec((await bell.getAttribute('aria-label')) ?? '')?.[1] ?? 0);
    const sheet = await openBell(patient);
    const awayNote = sheet.getByTestId('notification').filter({ hasText: 'stepped away' }).first();
    await expect(awayNote).toBeVisible();
    await expect(awayNote).toHaveAttribute('data-unread', 'true');
    await expect(awayNote).toContainText(fx.doctorName);
    await expect(awayNote).toContainText(`expected back about ${backClock}`);
    const awayNoteText = (await awayNote.innerText()).replace(/\s+/g, ' ');
    await shot(patient, '25-patient-notifications-390');
    await closeBell(patient);
    await expect(patientWide.getByTestId('notification-bell')).toHaveAttribute(
      'aria-label',
      /Notifications, \d+ unread/,
      { timeout: 25_000 },
    );
    const wideSheet = await openBell(patientWide);
    await expect(wideSheet.getByTestId('notification').filter({ hasText: 'stepped away' }).first()).toBeVisible();
    await shot(patientWide, '25-patient-notifications-1440');
    await closeBell(patientWide);
    // The booked patient was told too, in the booked wording.
    await expect(booked.getByTestId('notification-bell')).toHaveAttribute('aria-label', /Notifications, \d+ unread/, {
      timeout: 25_000,
    });
    const bookedSheet = await openBell(booked);
    await expect(bookedSheet.getByTestId('notification').filter({ hasText: 'running behind' }).first()).toBeVisible();
    await closeBell(booked);
    // Reception staff are told in-app as well.
    await expect(recep.getByTestId('notification-bell')).toHaveAttribute('aria-label', /Notifications, \d+ unread/, {
      timeout: 25_000,
    });

    // -------------------------------------------------------------- 7. Admin > Notifications sent: in-app plus SMS rows, fake provider, sent
    await loginByKeyboard(adminPage, 'admin@hqms.test');
    await adminPage.goto('/admin/notifications');
    await expect(adminPage.getByRole('heading', { name: 'Notifications sent' })).toBeVisible();
    const rows = adminPage.locator('tr[data-testid="notification-row"]');
    const w1Rows = rows.filter({ hasText: NAME[P_WALK1] as string }).filter({ hasText: 'stepped away' });
    const refresh = adminPage.getByRole('button', { name: /Refresh|Refreshing/ });
    await expect
      .poll(
        async () => {
          await refresh.click();
          const sms = w1Rows.filter({ hasText: 'SMS' }).filter({ hasText: 'Sent' });
          const inApp = w1Rows.filter({ hasText: 'In-app' }).filter({ hasText: 'Sent' });
          return `${await inApp.count()}/${await sms.count()}`;
        },
        { timeout: 25_000, intervals: [500, 1000, 1500] },
      )
      .toBe('1/1');
    timings['awayToAdminLogSentMs'] = Date.now() - tAway;
    await expect(adminPage.locator('tr[data-testid="notification-row"]').filter({ hasText: 'Failed' })).toHaveCount(0);
    await shot(adminPage, '26-admin-notifications-sent-1440', true);
    await loginByKeyboard(adminNarrow, 'admin@hqms.test');
    await adminNarrow.goto('/admin/notifications');
    await expect(adminNarrow.getByRole('heading', { name: 'Notifications sent' })).toBeVisible();
    await expect(adminNarrow.locator('li[data-testid="notification-row"]').first()).toBeVisible();
    await shot(adminNarrow, '26-admin-notifications-sent-390', true);

    const awayDeliveries = await pool.query<{ channel: string; status: string; provider: string | null; n: number }>(
      `SELECT d.channel, d.status, d.provider, count(*)::int AS n
         FROM notification_deliveries d JOIN outbox_events e ON e.id = d.event_id
        WHERE d.session_id = $1 AND e.event_type = 'SessionPaused'
        GROUP BY d.channel, d.status, d.provider ORDER BY d.channel, d.status`,
      [fx.sessionId],
    );

    // -------------------------------------------------------------- 8. I'm back, keyboard only
    const tBack = Date.now();
    await pressByKeyboard(doctor, doctor.getByRole('button', { name: "I'm back" }));
    await expect(doctor.getByTestId('availability-strip')).toHaveCount(0);
    await expect(callNext).not.toHaveAttribute('aria-disabled', 'true');
    timings['backToDoctorMs'] = Date.now() - tBack;
    await shot(doctor, '27-doctor-back-1440', true);
    await expect(doctorNarrow.getByTestId('availability-strip')).toHaveCount(0);
    await shot(doctorNarrow, '27-doctor-back-390', true);

    // Patient: the away banner is gone and a short "is back" confirmation replaces it; reception and display clear too.
    timings['backToPatientMs'] = await seenAfter(tBack, () =>
      expect(patient.getByTestId('availability-banner')).toHaveAttribute('data-state', 'back'),
    );
    await expect(patient.getByTestId('availability-banner')).toContainText(`${fx.doctorName} is back`);
    await expect(patient.getByText('has stepped away')).toHaveCount(0);
    await shot(patient, '28-patient-back-390', true);
    await expect(patientWide.getByTestId('availability-banner')).toHaveAttribute('data-state', 'back');
    await shot(patientWide, '28-patient-back-1440', true);
    timings['backToDisplayMs'] = await seenAfter(tBack, () =>
      expect(column.getByTestId('display-banner')).toHaveCount(0),
    );
    await shot(display, '29-display-back-1920');
    timings['backToReceptionMs'] = await seenAfter(tBack, () =>
      expect(recep.getByTestId('availability-strip')).toHaveCount(0),
    );
    await shot(recep, '29-reception-back-1440', true);
    await expect(recepNarrow.getByTestId('availability-strip')).toHaveCount(0);
    await shot(recepNarrow, '29-reception-back-390', true);

    // The patient is told about the return (worker fan-out again).
    const unreadOf = async (): Promise<number> =>
      Number(
        /(\d+) unread/.exec((await patient.getByTestId('notification-bell').getAttribute('aria-label')) ?? '')?.[1] ??
          0,
      );
    await expect.poll(unreadOf, { timeout: 25_000 }).toBeGreaterThan(unreadAfterAway);
    const sheet2 = await openBell(patient);
    const backNote = sheet2.getByTestId('notification').filter({ hasText: 'is back' }).first();
    await expect(backNote).toBeVisible();
    await expect(backNote).toContainText('Your place in the queue is unchanged');
    timings['backToPatientBellMs'] = Date.now() - tBack;
    await shot(patient, '29-patient-notifications-back-390');
    await closeBell(patient);

    // -------------------------------------------------------------- 9. same order: Call next calls who was next before
    await doctor.keyboard.press('n');
    await expect(callNext).toBeFocused();
    await doctor.keyboard.press('Enter');
    await expect(doctor.getByTestId('now-active')).toContainText(nextBefore);
    await expect(doctor.getByTestId('now-active')).toContainText(NAME[P_WALK1] as string);
    await expect(doctor.getByTestId('decision')).toBeVisible();
    await shot(doctor, '29-doctor-called-after-back-1440', true);
    await expect(patient.getByTestId('visit-state')).toHaveText('It is your turn');
    await shot(patient, '29-patient-called-after-back-390', true);

    // Leave the room tidy for the next spec: start and complete the called patient, keyboard only.
    await expect(doctor.getByRole('button', { name: 'Start', exact: true })).toBeFocused();
    await doctor.keyboard.press('Enter');
    await expect(doctor.getByTestId('now-state')).toContainText('In service');
    await doctor.keyboard.press('Enter');
    await expect(doctor.getByText('No patient with you')).toBeVisible();
    await expect(patient.getByTestId('visit-state')).toHaveText('Your visit is complete');
    await shot(patient, '29-patient-completed-390', true);

    // -------------------------------------------------------------- 10. what the database says
    const session = await pool.query(
      `SELECT status, paused_at, pause_until, pause_reason FROM sessions WHERE id = $1`,
      [fx.sessionId],
    );
    expect(session.rows[0].status).toBe('open');
    const decisions = await pool.query<{ token: string; reason: string }>(
      `SELECT q.token, d.reason FROM queue_decisions d JOIN queue_entries q ON q.id = d.queue_entry_id
        WHERE d.session_id = $1 ORDER BY d.decided_at, d.id`,
      [fx.sessionId],
    );
    expect(decisions.rows.map((r) => r.token)).toEqual([tokens.appointment, nextBefore]);
    expect(decisions.rows.length).toBe((decisionsBefore.rows[0].n as number) + 1); // the blocked attempts added no decision
    const ops = await pool.query<{ operation: string; actor_role: string }>(
      `SELECT operation, actor_role FROM audit_events WHERE entity_id = $1 AND operation LIKE 'session.%' ORDER BY id`,
      [fx.sessionId],
    );
    const sessionOps = ops.rows.map((r) => `${r.operation} (${r.actor_role})`);
    expect(sessionOps).toEqual(expect.arrayContaining(['session.pause (doctor)', 'session.resume (doctor)']));
    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events WHERE session_id = $1 AND event_type IN ('SessionPaused','SessionResumed') ORDER BY position`,
      [fx.sessionId],
    );
    expect(events.rows.map((r) => r.event_type)).toEqual(['SessionPaused', 'SessionResumed']);
    const undelivered = await pool.query(
      `SELECT count(*)::int AS n FROM notification_deliveries WHERE session_id = $1 AND status <> 'sent'`,
      [fx.sessionId],
    );
    expect(undelivered.rows[0].n).toBe(0);
    const deliveriesAll = await pool.query<{ event_type: string; channel: string; recipient: string; n: number }>(
      `SELECT e.event_type, d.channel,
              CASE WHEN d.patient_id IS NOT NULL THEN 'patient' ELSE 'staff' END AS recipient, count(*)::int AS n
         FROM notification_deliveries d JOIN outbox_events e ON e.id = d.event_id
        WHERE d.session_id = $1 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
      [fx.sessionId],
    );

    mkdirSync(path.dirname(RAW), { recursive: true });
    writeFileSync(
      RAW,
      `${JSON.stringify(
        {
          spec: 'availability-away',
          fixture: {
            ...fx,
            tokens,
            awayUntilShownInDialog: backClock,
            expectedBackClockForThisRun: backClock,
            nowClock: clock(new Date()),
          },
          waitingOrderBeforeAway: waitingTokensBefore,
          calledAfterBack: nextBefore,
          patientBannerText: bannerText,
          patientBellText: awayNoteText,
          timingsMs: timings,
          databaseAfter: {
            sessionStatus: session.rows[0].status,
            decisionTokens: decisions.rows.map((r) => `${r.token} (${r.reason})`),
            sessionAuditOperations: sessionOps,
            outboxEvents: events.rows.map((r) => r.event_type),
            deliveriesForSessionPausedByChannelStatusProvider: awayDeliveries.rows,
            deliveriesAllByEventChannelRecipient: deliveriesAll.rows,
            deliveriesNotSent: undelivered.rows[0].n,
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
    await Promise.all([
      doctorCtx.close(),
      doctorNarrowCtx.close(),
      patientCtx.close(),
      patientWideCtx.close(),
      bookedCtx.close(),
      displayCtx.close(),
      receptionCtx.close(),
      receptionNarrowCtx.close(),
      adminCtx.close(),
      adminNarrowCtx.close(),
    ]);
  }

  expect(problems.fiveXx, 'no 5xx response anywhere in the flow').toEqual([]);
  expect(problems.pageErrors, 'no uncaught page error').toEqual([]);
});
