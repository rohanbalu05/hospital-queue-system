/**
 * Shared helpers for the real-stack end-to-end specs: the time-of-day-proof session fixture, API shortcuts used only to
 * PREPARE a scenario (the UI steps under test never use them), keyboard helpers and page watchers.
 *
 * Fixture rules (all specs):
 *  - the doctor's other sessions today are closed in SQL first, so the fixture session never overlaps (PR-41) and the
 *    waiting-room display and the pickers show only the fixture;
 *  - the fixture session started `STARTED_MIN_AGO` minutes ago and runs four hours. With 20-minute slots its first
 *    slot is already past the late-grace window (not bookable), the next one is a few minutes ahead (the first booking
 *    gets it) and is eligible at once (early eligibility is 10 minutes);
 *  - the label comes from `sessionLabelFor` (D-037), so a "morning" session is never called "evening".
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { sessionLabelFor } from '../../packages/contracts/src/scheduling.js';
import { stableId } from '../../db/seed/seed.js';
import { type ApiClient, login } from '../support/client.js';

export const SHOTS = path.resolve(import.meta.dirname, '../../docs/evidence/screenshots');
export const EVIDENCE = path.resolve(import.meta.dirname, '../../docs/evidence');
export const WEB = (): string => process.env['E2E_WEB_URL'] as string;
export const API = (): string => process.env['E2E_API_URL'] as string;
export const DB = (): string => process.env['E2E_DATABASE_URL'] as string;
export const PASSWORD = 'demo1234';

/** Minutes before "now" at which the fixture session starts. */
export const STARTED_MIN_AGO = 12;

export const doctorId = (n: number): string => stableId(`doctor:${n}`);
export const patientId = (n: number): string => stableId(`patient:${n}`);
/** Login email of seeded patient n (1..10 have logins: patient@, patient2@ ...). */
export const patientEmail = (n: number): string => `patient${n === 1 ? '' : n}@hqms.test`;
export const doctorEmail = (n: number): string => `doctor${n === 1 ? '' : n}@hqms.test`;

export const istDate = (d: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);

/** Same rendering as the web app's formatIST(…, 'time'): "9:22 am". */
export const clock = (value: string | Date): string =>
  new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
    .format(new Date(value))
    .replace(/\s?(am|pm)$/i, (_m, mer: string) => ` ${mer.toLowerCase()}`);

export const labelWord = (label: string): string => label.charAt(0).toUpperCase() + label.slice(1);

export interface FixtureSession {
  sessionId: string;
  doctorNumber: number;
  doctorName: string;
  label: string;
  startsAt: string;
  endsAt: string;
  /** "Morning 9:22 am": the reception tab name (label word plus start time). */
  tabName: string;
  roomLabel: string;
}

export const DOCTORS: Record<number, { name: string; room: string }> = {
  1: { name: 'Dr. Suresh Hegde', room: 'OPD 1' },
  2: { name: 'Dr. Lakshmi Narayan', room: 'OPD 2' },
};

export function newPool(): pg.Pool {
  return new pg.Pool({ connectionString: DB(), max: 2 });
}

/**
 * A clean day for the run: every still-booked appointment of today is cancelled through the API (as reception, so
 * capacity is released the normal way) and every session of today that is not closed is closed in SQL. After this the
 * seed's demo sessions and bookings no longer clutter the patient's Today page, the display or the pickers.
 */
export async function resetToday(): Promise<void> {
  const pool = newPool();
  try {
    const today = istDate(new Date());
    const reception = await login(API(), 'reception@hqms.test');
    const booked = await pool.query<{ id: string; version: number }>(
      `SELECT a.id, a.version FROM appointments a JOIN sessions s ON s.id = a.session_id
        WHERE s.session_date = $1 AND a.status = 'booked'`,
      [today],
    );
    for (const row of booked.rows) {
      const res = await reception.post(`/appointments/${row.id}/cancel`, {
        expectedVersion: row.version,
        reason: 'e2e fixture reset',
      });
      if (res.status !== 200) throw new Error(`reset cancel ${row.id}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    // A patient left in `called` by an earlier run would hold the doctor's single active allocation; the 2-minute
    // call timeout would skip them anyway, so reset them the same way.
    await pool.query(
      `UPDATE queue_entries SET state = 'skipped', skipped_at = now(), version = version + 1 WHERE state = 'called'`,
    );
    await pool.query(`UPDATE sessions SET status = 'closed' WHERE session_date = $1 AND status <> 'closed'`, [today]);
  } finally {
    await pool.end();
  }
}

/** Create and open a fresh session for doctor `n` that started STARTED_MIN_AGO minutes ago and runs four hours. */
export async function createSession(n: number, admin: ApiClient): Promise<FixtureSession> {
  const pool = newPool();
  try {
    let startMs = Math.floor((Date.now() - STARTED_MIN_AGO * 60_000) / 60_000) * 60_000;
    // The (doctor, starts_at) pair is unique and the seed starts sessions on the hour: step back one minute on a clash.
    for (;;) {
      const clash = await pool.query(`SELECT 1 FROM sessions WHERE doctor_id = $1 AND starts_at = $2`, [
        doctorId(n),
        new Date(startMs).toISOString(),
      ]);
      if (clash.rowCount === 0) break;
      startMs -= 60_000;
    }
    const startsAt = new Date(startMs).toISOString();
    const endsAt = new Date(startMs + 4 * 3_600_000).toISOString();
    const label = sessionLabelFor(startsAt);
    const res = await admin.post(
      '/sessions',
      {
        doctorId: doctorId(n),
        sessionDate: istDate(new Date(startMs)),
        label,
        startsAt,
        endsAt,
        bookedCapacity: 10,
        walkinCapacity: 5,
      },
      null,
    );
    if (res.status !== 201) throw new Error(`fixture session: ${res.status} ${JSON.stringify(res.body)}`);
    const opened = await admin.post(`/sessions/${res.body.id}/open`, {});
    if (opened.status !== 200) throw new Error(`fixture open: ${opened.status} ${JSON.stringify(opened.body)}`);
    const info = DOCTORS[n] ?? { name: `Doctor ${n}`, room: '' };
    return {
      sessionId: res.body.id,
      doctorNumber: n,
      doctorName: info.name,
      label,
      startsAt,
      endsAt,
      tabName: `${labelWord(label)} ${clock(startsAt)}`,
      roomLabel: info.room,
    };
  } finally {
    await pool.end();
  }
}

/** Preparation only: a patient books the next free slot of a session (same API the Book page uses). */
export async function bookAs(
  patientNumber: number,
  sessionId: string,
): Promise<{ id: string; scheduledAt: string; version: number }> {
  const client = await login(API(), patientEmail(patientNumber));
  const res = await client.post('/appointments', { sessionId });
  if (res.status !== 201)
    throw new Error(`book as patient ${patientNumber}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Preparation only: reception checks a booked appointment in. */
export async function checkIn(
  reception: ApiClient,
  appointmentId: string,
): Promise<{ token: string; queueEntryId: string; visitId: string }> {
  const res = await reception.post(`/appointments/${appointmentId}/check-in`, {});
  if (res.status !== 200 && res.status !== 201)
    throw new Error(`check-in ${appointmentId}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Preparation only: reception admits a walk-in. */
export async function admitWalkIn(
  reception: ApiClient,
  sessionId: string,
  patientNumber: number,
): Promise<{ token: string; queueEntryId: string; visitId: string }> {
  const res = await reception.post(`/sessions/${sessionId}/walk-ins`, { patientId: patientId(patientNumber) });
  if (res.status !== 200 && res.status !== 201)
    throw new Error(`walk-in ${patientNumber}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export const shot = async (page: Page, name: string, fullPage = false): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `e2e-${name}.png`), fullPage });
};

/**
 * Keyboard-only navigation: press Tab until `target` has focus; if it is not found going forward (it sits above the
 * current focus), press Shift+Tab. Fails loudly if the control is unreachable by keyboard.
 */
export async function tabTo(page: Page, target: Locator, max = 40): Promise<void> {
  const focused = (): Promise<boolean> => target.evaluate((el) => el === document.activeElement).catch(() => false);
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < max; i += 1) {
      if (await focused()) return;
      await page.keyboard.press(key);
    }
  }
  await expect(target).toBeFocused();
}

/** Focus `target` with Tab presses and activate it with Enter. */
export async function pressByKeyboard(page: Page, target: Locator): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.press('Enter');
}

export async function loginByKeyboard(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await expect(page.getByLabel('Email')).toBeFocused();
  await page.keyboard.type(email);
  await page.keyboard.press('Tab');
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press('Enter');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

export interface Problems {
  fiveXx: string[];
  fourXx: string[];
  pageErrors: string[];
}
export const newProblems = (): Problems => ({ fiveXx: [], fourXx: [], pageErrors: [] });

/** Track failures on a page: any 5xx response and any uncaught page error. 4xx responses are listed separately. */
export function watch(page: Page, who: string, sink: Problems): void {
  page.on('response', (res) => {
    const status = res.status();
    if (status >= 500) sink.fiveXx.push(`${who} ${status} ${res.request().method()} ${res.url()}`);
    else if (status >= 400)
      sink.fourXx.push(`${who} ${status} ${res.request().method()} ${new URL(res.url()).pathname}`);
  });
  page.on('pageerror', (err) => sink.pageErrors.push(`${who}: ${err.message}`));
}

export async function newContext(
  browser: Browser,
  width: number,
  height: number,
  deviceScaleFactor = 1,
): Promise<BrowserContext> {
  return browser.newContext({ baseURL: WEB(), viewport: { width, height }, deviceScaleFactor });
}

/** Count and group 4xx responses so the evidence says which ones were expected. */
export function summariseFourXx(list: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of list) {
    const key = line.replace(/^\S+ /, '');
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** Reception desk: make sure the doctor's session tab is the selected one (pointer-operated pickers, see the evidence notes). */
export async function selectReceptionSession(page: Page, session: FixtureSession): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Reception desk', level: 1 })).toBeVisible();
  const doctorSelect = page.getByRole('combobox', { name: 'Doctor' });
  if (!(await doctorSelect.innerText()).includes(session.doctorName)) {
    await doctorSelect.click();
    await page.getByRole('option', { name: new RegExp(session.doctorName) }).click();
  }
  await page.getByRole('tab', { name: session.tabName }).click();
  await expect(page.getByText(/Last updated/)).toBeVisible();
}
