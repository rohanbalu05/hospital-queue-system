/**
 * Admin reports against the REAL stack (seeded PostgreSQL, built API, nothing mocked).
 *
 * The mock-backed specs cannot honestly show "Measured" figures, so this spec produces a few real visits through the
 * API (five walk-ins, each called, started and completed, in real time) and then photographs the report the admin
 * sees. The samples are tiny and the waits are seconds, not minutes: that is what a few real visits measure. The
 * screenshot is evidence of how the screen reads real data, not of hospital performance.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { login } from '../../../tests/support/client.js';
import { stableId } from '../../../db/seed/seed.js';

const SHOTS = path.resolve(import.meta.dirname, '../../../docs/evidence/screenshots');
const API = (): string => process.env['E2E_API_URL'] as string;

const DOCTOR_NUMBER = 3;
const WALK_IN_PATIENTS = [21, 22, 23, 24, 25];

const istDate = (d: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

async function runRealVisits(): Promise<void> {
  {
    const admin = await login(API(), 'admin@hqms.test');
    const doctor = await login(API(), `doctor${DOCTOR_NUMBER === 1 ? '' : DOCTOR_NUMBER}@hqms.test`);
    const startMs = Math.floor((Date.now() - 5 * 60_000) / 60_000) * 60_000;
    const date = istDate(new Date(startMs));
    // The seed already has this doctor's sessions today: close them (through the API) so the new session is the only one.
    const existing = await admin.get(`/sessions?date=${date}&doctorId=${stableId(`doctor:${DOCTOR_NUMBER}`)}`);
    const list = (Array.isArray(existing.body) ? existing.body : (existing.body.items ?? [])) as Array<{ id: string; status: string }>;
    for (const s of list) {
      if (s.status === 'closed') continue;
      const closed = await admin.post(`/sessions/${s.id}/close`, {});
      if (closed.status !== 200) throw new Error(`close ${s.id}: ${closed.status} ${JSON.stringify(closed.body)}`);
    }
    const made = await admin.post(
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
    if (made.status !== 201) throw new Error(`session: ${made.status} ${JSON.stringify(made.body)}`);
    const sessionId = made.body.id as string;
    const opened = await admin.post(`/sessions/${sessionId}/open`, {});
    if (opened.status !== 200) throw new Error(`open: ${opened.status} ${JSON.stringify(opened.body)}`);

    for (const n of WALK_IN_PATIENTS) {
      const arrival = await admin.post(`/sessions/${sessionId}/walk-ins`, { patientId: stableId(`patient:${n}`) });
      if (arrival.status !== 201 && arrival.status !== 200) throw new Error(`walk-in ${n}: ${arrival.status} ${JSON.stringify(arrival.body)}`);
    }
    for (let i = 0; i < WALK_IN_PATIENTS.length; i += 1) {
      const called = await doctor.post(`/sessions/${sessionId}/call-next`, {});
      if (called.status !== 200 || !called.body.entry) throw new Error(`call-next: ${called.status} ${JSON.stringify(called.body)}`);
      const entry = called.body.entry as { visitId: string; version: number };
      const started = await doctor.post(`/visits/${entry.visitId}/start`, { expectedVersion: entry.version });
      if (started.status !== 200) throw new Error(`start: ${started.status} ${JSON.stringify(started.body)}`);
      const done = await doctor.post(`/visits/${entry.visitId}/complete`, { expectedVersion: started.body.entry.version });
      if (done.status !== 200) throw new Error(`complete: ${done.status} ${JSON.stringify(done.body)}`);
    }
  }
}

test.describe('admin reports, real stack, 1440', () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

  test('measured rows come from the visits that just ran; targets stay labelled Target', async ({ page }) => {
    await runRealVisits();

    await page.goto('/login');
    await page.getByLabel('Email').fill('admin@hqms.test');
    await page.getByLabel('Password').fill('demo1234');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/admin/);
    await page.goto('/admin/reports');
    await expect(page.getByRole('heading', { name: 'Throughput' })).toBeVisible();

    const completed = page.getByRole('row', { name: /Completed visits/ });
    await expect(completed).toContainText(String(WALK_IN_PATIENTS.length));
    // Walk-in group has the five real waits; priority has none.
    await expect(page.getByRole('row', { name: /Walk-in/ }).first()).toContainText(String(WALK_IN_PATIENTS.length));
    await expect(page.locator('tr[data-kind="target"]').first()).toBeVisible();
    for (const r of await page.locator('tr[data-kind]').all()) {
      const kind = await r.getAttribute('data-kind');
      await expect(r.locator(`[data-kind="${kind}"]`)).toHaveText(kind === 'measured' ? 'Measured' : 'Target');
    }

    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, 'w3-admin-reports-1440.png'), fullPage: true, animations: 'disabled' });
  });
});
