/**
 * End-to-end, REAL stack (report 5.6 / NFR-08-b): book -> check in -> call -> start -> complete, as four real
 * people in four browser contexts, against the built API, a freshly seeded PostgreSQL and the Vite dev server
 * of apps/web. Nothing is mocked and the API is never called from the test while a step is being exercised
 * through the UI; the API and SQL are used only to prepare the fixture and to verify the result afterwards.
 *
 * Keyboard only: login, booking (patient), search and check-in (reception) and call, start, complete (doctor)
 * are driven with page.keyboard only. Navigation URLs (goto) and the doctor/session pickers on the reception
 * desk are the only pointer-free exceptions listed in docs/evidence/e2e-full-visit.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { login } from '../support/client.js';
import { stableId } from '../../db/seed/seed.js';

const SHOTS = path.resolve(import.meta.dirname, '../../docs/evidence/screenshots');
const RAW = path.resolve(import.meta.dirname, '../../docs/evidence/e2e-full-visit.raw.json');
const WEB = (): string => process.env['E2E_WEB_URL'] as string;
const API = (): string => process.env['E2E_API_URL'] as string;
const DB = (): string => process.env['E2E_DATABASE_URL'] as string;

const DOCTOR_NUMBER = 1; // Dr. Suresh Hegde, General Medicine, OPD 1 (login doctor@hqms.test)
const PATIENT_NAME = 'Ramesh Kumar'; // login patient@hqms.test
const PASSWORD = 'demo1234';

const shot = async (page: Page, name: string, fullPage = false): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `e2e-${name}.png`), fullPage });
};

/** Press Tab until `target` has focus: keyboard-only navigation, fails loudly if it is unreachable. */
async function tabTo(page: Page, target: Locator, max = 40): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

/** Radio group: Tab into it, then arrow keys / Space until the named option is selected. */
async function chooseRadio(page: Page, group: string, option: RegExp | string): Promise<void> {
  const radios = page.getByRole('radiogroup', { name: group });
  await tabTo(page, radios.locator('[role="radio"]:not([disabled])').first());
  const target = radios.getByRole('radio', { name: option });
  for (let i = 0; i < 12; i += 1) {
    if ((await target.getAttribute('aria-checked')) === 'true') return;
    const focused = await target.evaluate((el) => el === document.activeElement);
    await page.keyboard.press(focused ? 'Space' : 'ArrowDown');
  }
  await expect(target).toBeChecked();
}

async function loginByKeyboard(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await expect(page.getByLabel('Email')).toBeFocused(); // autofocus: the first key typed goes in the field
  await page.keyboard.type(email);
  await page.keyboard.press('Tab');
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press('Enter');
}

interface Fixture {
  sessionId: string;
  startsAt: string;
  roomLabel: string;
}

const istDate = (d: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);

/**
 * Fixture (API + SQL only, before any UI step): one clean TODAY session for the doctor. The seed already has the
 * doctor's morning and afternoon sessions today, so those are closed (SQL) and a fresh "evening" session is created
 * that started 16 to 17 minutes ago: its first slot is past the 15-minute grace (not bookable), the second slot is
 * 3 to 4 minutes in the future (the patient gets it) and is already eligible (early eligibility is 10 minutes).
 */
async function prepareFixture(): Promise<Fixture> {
  const pool = new pg.Pool({ connectionString: DB(), max: 2 });
  try {
    const admin = await login(API(), 'admin@hqms.test');
    const startMs = Math.floor((Date.now() - 16 * 60_000) / 60_000) * 60_000;
    const date = istDate(new Date(startMs));
    await pool.query(`UPDATE sessions SET status = 'closed' WHERE doctor_id = $1 AND session_date = $2`, [
      stableId(`doctor:${DOCTOR_NUMBER}`),
      date,
    ]);
    const res = await admin.post(
      '/sessions',
      {
        doctorId: stableId(`doctor:${DOCTOR_NUMBER}`),
        sessionDate: date,
        label: 'evening',
        startsAt: new Date(startMs).toISOString(),
        endsAt: new Date(startMs + 4 * 3_600_000).toISOString(),
        bookedCapacity: 10,
        walkinCapacity: 5,
      },
      null,
    );
    if (res.status !== 201) throw new Error(`fixture session: ${res.status} ${JSON.stringify(res.body)}`);
    const opened = await admin.post(`/sessions/${res.body.id}/open`, {});
    if (opened.status !== 200) throw new Error(`fixture open: ${opened.status} ${JSON.stringify(opened.body)}`);
    return { sessionId: res.body.id, startsAt: new Date(startMs).toISOString(), roomLabel: 'OPD 1' };
  } finally {
    await pool.end();
  }
}

/** Track failures on a page: any 5xx response and any uncaught page error. 4xx responses are listed separately. */
function watch(page: Page, who: string, sink: { fiveXx: string[]; pageErrors: string[]; fourXx: string[] }): void {
  page.on('response', (res) => {
    const status = res.status();
    if (status >= 500) sink.fiveXx.push(`${who} ${status} ${res.request().method()} ${res.url()}`);
    else if (status >= 400)
      sink.fourXx.push(`${who} ${status} ${res.request().method()} ${new URL(res.url()).pathname}`);
  });
  page.on('pageerror', (err) => sink.pageErrors.push(`${who}: ${err.message}`));
}

async function context(
  browser: Browser,
  width: number,
  height: number,
  deviceScaleFactor = 1,
): Promise<BrowserContext> {
  return browser.newContext({ baseURL: WEB(), viewport: { width, height }, deviceScaleFactor });
}

test('book -> check in -> call -> start -> complete, keyboard only, real stack', async ({ browser }) => {
  const fx = await prepareFixture();
  const problems = { fiveXx: [] as string[], pageErrors: [] as string[], fourXx: [] as string[] };
  const timings: Record<string, number> = {};

  const patientCtx = await context(browser, 390, 844, 2);
  const receptionCtx = await context(browser, 1440, 900);
  const doctorCtx = await context(browser, 1440, 900);
  const displayCtx = await context(browser, 1920, 1080);
  const patient = await patientCtx.newPage();
  const reception = await receptionCtx.newPage();
  const doctor = await doctorCtx.newPage();
  const display = await displayCtx.newPage();
  watch(patient, 'patient', problems);
  watch(reception, 'reception', problems);
  watch(doctor, 'doctor', problems);
  watch(display, 'display', problems);

  // ------------------------------------------------------------------ 1. patient books (keyboard only, 390 px)
  await loginByKeyboard(patient, 'patient@hqms.test');
  await expect(patient).toHaveURL(/\/patient/);
  // The patient nav tab is "Book" (earlier builds also had a "Book appointment" link on Today).
  const bookLink = patient.getByRole('link', { name: /^Book( appointment)?$/ }).first();
  await tabTo(patient, bookLink);
  await patient.keyboard.press('Enter');

  await expect(patient.getByRole('heading', { name: 'Choose a department' })).toBeVisible();
  await chooseRadio(patient, 'Department', 'General Medicine');
  await patient.keyboard.press('Enter');

  await expect(patient.getByRole('heading', { name: 'Choose a doctor' })).toBeFocused();
  await chooseRadio(patient, 'Doctor', /Suresh Hegde/);
  await patient.keyboard.press('Enter');

  await expect(patient.getByRole('heading', { name: 'Choose a day' })).toBeFocused();
  await chooseRadio(patient, 'Day', /Today/);
  await expect(patient.getByRole('radio', { name: /Today/ })).toBeEnabled();
  await patient.keyboard.press('Enter');

  await expect(patient.getByRole('heading', { name: 'Choose a session' })).toBeFocused();
  await expect(patient.getByRole('radio', { name: /Evening/ })).toBeEnabled();
  await chooseRadio(patient, 'Session', /Evening/);
  await shot(patient, '01-patient-choose-session-390');
  await patient.keyboard.press('Enter');

  await expect(patient.getByRole('heading', { name: 'Check and book' })).toBeFocused();
  await expect(patient.getByText('OPD 1')).toBeVisible();
  const bookButton = patient.getByRole('button', { name: 'Book appointment' });
  await tabTo(patient, bookButton);
  await shot(patient, '02-patient-confirm-390');
  await patient.keyboard.press('Enter');
  await expect(patient).toHaveURL(/\/patient\/visits$/);
  await expect(patient.getByText('Booked', { exact: true }).first()).toBeVisible();
  await shot(patient, '03-patient-booked-390', true);

  // The appointment really exists, is in the future and belongs to this patient.
  const pool = new pg.Pool({ connectionString: DB(), max: 2 });
  try {
    const appt = await pool.query(
      `SELECT a.id, a.status, a.scheduled_at FROM appointments a JOIN patients p ON p.id = a.patient_id
        WHERE a.session_id = $1 AND p.full_name = $2`,
      [fx.sessionId, PATIENT_NAME],
    );
    expect(appt.rows).toHaveLength(1);
    expect(appt.rows[0].status).toBe('booked');
    expect(new Date(appt.rows[0].scheduled_at).getTime()).toBeGreaterThan(Date.now());

    // -------------------------------------------------------------- 2. reception finds the patient and checks in (1440 px)
    await loginByKeyboard(reception, 'reception2@hqms.test'); // assigned to Dr. Hegde and Dr. Narayan only
    await expect(reception.getByRole('heading', { name: 'Reception desk', level: 1 })).toBeVisible();
    // Doctor and session pickers are pointer-operated here (not part of the keyboard-only requirement).
    const doctorSelect = reception.getByRole('combobox', { name: 'Doctor' });
    if (!(await doctorSelect.innerText()).includes('Suresh Hegde')) {
      await doctorSelect.click();
      await reception.getByRole('option', { name: /Suresh Hegde/ }).click();
    }
    await reception.getByRole('tab', { name: /Evening/ }).click();
    await expect(reception.getByRole('option', { name: new RegExp(PATIENT_NAME) })).toBeVisible();

    await reception.getByRole('tab', { name: /Evening/ }).evaluate((el) => (el as HTMLElement).blur());
    await reception.keyboard.press('/');
    await expect(reception.getByRole('combobox', { name: 'Find an arrival' })).toBeFocused();
    await reception.keyboard.type('Ramesh');
    await expect(reception.getByRole('listbox', { name: 'Arrivals' }).getByRole('option')).toHaveCount(1);
    await reception.keyboard.press('Enter');
    const outcome = reception.getByTestId('arrival-outcome');
    await expect(outcome).toContainText('Checked in');
    await expect(outcome).toContainText('A-001');
    await expect(outcome).toContainText('Appointment');
    await shot(reception, '04-reception-checked-in-1440', true);

    // -------------------------------------------------------------- 3. waiting-room display and the patient's live page
    await display.goto('/display');
    const column = display.getByRole('region', { name: new RegExp(`${fx.roomLabel}, `) });
    await expect(column).toBeVisible();
    // Earlier finding (fixed, D-028): the seed leaves ~20 sessions "open"; the public display now lists only sessions
    // in their time window (or with waiting/called patients), and pages through at most 6 columns.
    expect(await display.getByTestId('display-column').count()).toBeLessThanOrEqual(6);
    await pool.query(
      `UPDATE sessions SET status = 'closed' WHERE session_date = $1 AND id <> $2 AND status IN ('open', 'paused')`,
      [istDate(new Date(fx.startsAt)), fx.sessionId],
    );
    await display.reload();
    await expect(display.getByTestId('display-column')).toHaveCount(1);
    await expect(column).toBeVisible();
    await shot(display, '05-display-waiting-1920');
    await expect(column.getByTestId('now-calling-idle')).toBeVisible();
    await expect(column.getByTestId('next-tokens')).toContainText('A-001');
    await shot(display, '05-display-waiting-1920');

    await patient.goto(`/patient/visit/${fx.sessionId}`);
    await expect(patient.getByText('A-001').first()).toBeVisible();
    await expect(patient.getByTestId('visit-state')).toHaveText('You are in the queue');
    await expect(patient.getByTestId('position')).toContainText('Number 1');
    await shot(patient, '06-patient-waiting-390', true);

    // -------------------------------------------------------------- 4. doctor: call next, start, complete (keyboard only, 1440 px)
    await loginByKeyboard(doctor, 'doctor@hqms.test');
    await expect(doctor.getByRole('heading', { name: 'Doctor console', level: 1 })).toBeVisible();
    const callNext = doctor.getByRole('button', { name: /^Call next/ });
    await expect(callNext).toBeVisible();
    await expect(doctor.getByText(/Last updated/)).toBeVisible(); // the live stream is connected
    await expect(doctor.getByRole('region', { name: 'Waiting, in call order' })).toContainText('A-001');

    await doctor.keyboard.press('n');
    await expect(callNext).toBeFocused();
    const tCall = Date.now();
    await doctor.keyboard.press('Enter');
    const decision = doctor.getByTestId('decision');
    await expect(decision).toContainText('Called by rotation: 1st appointment of A, A, W');
    await expect(decision).toContainText('Policy v1');
    await expect(doctor.getByTestId('now-active')).toContainText('A-001');
    await expect(doctor.getByTestId('now-active')).toContainText(PATIENT_NAME);
    await expect(doctor.getByTestId('now-state')).toContainText('Called');
    await shot(doctor, '07-doctor-called-1440', true);

    // The waiting room and the patient follow without a reload.
    await expect(column.getByTestId('now-calling')).toHaveAttribute('data-token', 'A-001');
    timings['callToDisplayMs'] = Date.now() - tCall;
    await shot(display, '08-display-now-calling-1920');
    await expect(patient.getByTestId('visit-state')).toHaveText('It is your turn');
    timings['callToPatientMs'] = Date.now() - tCall;
    await shot(patient, '09-patient-called-390', true);

    await expect(doctor.getByRole('button', { name: 'Start', exact: true })).toBeFocused();
    await doctor.keyboard.press('Enter');
    await expect(doctor.getByTestId('now-state')).toContainText('In service');
    await expect(patient.getByTestId('visit-state')).toHaveText('You are with the doctor');
    await shot(doctor, '10-doctor-in-service-1440', true);
    await shot(patient, '11-patient-in-service-390', true);

    await expect(doctor.getByRole('button', { name: 'Complete', exact: true })).toBeFocused();
    const tComplete = Date.now();
    await doctor.keyboard.press('Enter');
    await expect(doctor.getByText('No patient with you')).toBeVisible();
    await expect(patient.getByTestId('visit-state')).toHaveText('Your visit is complete');
    timings['completeToPatientMs'] = Date.now() - tComplete;
    await expect(column.getByTestId('now-calling-idle')).toBeVisible();
    await shot(doctor, '12-doctor-completed-1440', true);
    await shot(patient, '13-patient-completed-390', true);
    await shot(display, '14-display-after-1920');

    // -------------------------------------------------------------- 5. what the database says
    const visit = await pool.query(
      `SELECT v.id, v.status, v.kind, v.started_at, v.completed_at, q.state AS entry_state, q.token, q.call_count, a.status AS appointment_status
         FROM visits v JOIN queue_entries q ON q.visit_id = v.id JOIN appointments a ON a.id = v.appointment_id
        WHERE v.session_id = $1`,
      [fx.sessionId],
    );
    expect(visit.rows).toHaveLength(1);
    expect(visit.rows[0]).toMatchObject({
      status: 'completed',
      kind: 'appointment',
      entry_state: 'completed',
      token: 'A-001',
      call_count: 1,
    });
    expect(visit.rows[0].started_at).not.toBeNull();
    expect(visit.rows[0].completed_at).not.toBeNull();
    const decisions = await pool.query(
      `SELECT reason, policy_version, explanation FROM queue_decisions WHERE session_id = $1`,
      [fx.sessionId],
    );
    expect(decisions.rows).toEqual([
      { reason: 'ROTATION', policy_version: 1, explanation: 'Called by rotation: 1st appointment of A, A, W' },
    ]);
    const audit = await pool.query(
      `SELECT operation, actor_role FROM audit_events
        WHERE operation IN ('appointment.book','visit.check_in','queue.call_next','consultation.start','consultation.complete')
          AND (entity_id = $1 OR entity_id = $2 OR entity_id = $3 OR entity_id = $4) ORDER BY id`,
      [
        visit.rows[0].id,
        appt.rows[0].id,
        (await pool.query(`SELECT id FROM queue_entries WHERE visit_id = $1`, [visit.rows[0].id])).rows[0].id,
        fx.sessionId,
      ],
    );
    const operations = audit.rows.map(
      (r: { operation: string; actor_role: string }) => `${r.operation} (${r.actor_role})`,
    );
    expect(operations).toEqual([
      'appointment.book (patient)',
      'visit.check_in (reception)',
      'queue.call_next (doctor)',
      'consultation.start (doctor)',
      'consultation.complete (doctor)',
    ]);
    const active = await pool.query(
      `SELECT count(*)::int AS n FROM queue_entries WHERE doctor_id = $1 AND state IN ('called','in_service')`,
      [stableId(`doctor:${DOCTOR_NUMBER}`)],
    );
    expect(active.rows[0].n).toBe(0);

    mkdirSync(path.dirname(RAW), { recursive: true });
    writeFileSync(
      RAW,
      `${JSON.stringify(
        {
          fixture: fx,
          timingsMs: timings,
          databaseAfter: {
            visit: visit.rows[0],
            decisions: decisions.rows,
            auditOperations: operations,
            activeAllocationsForDoctor: active.rows[0].n,
          },
          fourXxResponsesSeen: problems.fourXx,
          fiveXxResponses: problems.fiveXx,
          pageErrors: problems.pageErrors,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await pool.end();
    await Promise.all([patientCtx.close(), receptionCtx.close(), doctorCtx.close(), displayCtx.close()]);
  }

  expect(problems.fiveXx, 'no 5xx response anywhere in the flow').toEqual([]);
  expect(problems.pageErrors, 'no uncaught page error').toEqual([]);
});
