/* eslint-disable @typescript-eslint/no-non-null-assertion -- fixtures look up ids this file created */
import { expect, test, type Page } from '@playwright/test';
import { setupW3, shot } from './w3-helpers';
import { SYSTEM_DOWN, TEMP_PASSWORD, applyW6Admin } from './w6-admin-mocks';

async function open(page: Page, path: string) {
  const world = await setupW3(page, 'admin');
  const admin = await applyW6Admin(page, world.sched);
  return { world, admin, go: () => page.goto(path) };
}

const noSideScroll = async (page: Page) => {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
};

const rowFor = (page: Page, doctor: string, text: string) => page.getByTestId('session-row').filter({ hasText: doctor }).filter({ hasText: text });

for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const) {
  test.describe(`admin runs the hospital at ${width}`, () => {
    test.use({ viewport: { width, height }, deviceScaleFactor: 1 });

    test(`sessions: availability words, actions by status, nothing scrolls sideways (${width})`, async ({ page }) => {
      const { go } = await open(page, '/admin');
      await go();
      await expect(page.getByRole('heading', { name: 'Administration', level: 1 })).toBeVisible();
      await expect(page.getByTestId('session-row')).toHaveCount(10);
      await expect(page.getByTestId('session-date-words')).toHaveText('Wed, 11 Nov');

      const rao = rowFor(page, 'Dr. Meenakshi Rao', 'Morning');
      await expect(rao).toContainText('Available');
      await expect(rao.getByRole('button', { name: /^Close session/ })).toBeVisible();
      await expect(rao.getByRole('button', { name: /^Open session/ })).toHaveCount(0);

      const siddiqui = rowFor(page, 'Dr. Farah Siddiqui', 'Morning');
      await expect(siddiqui).toContainText('Away until 10:35 am');

      const kulkarni = rowFor(page, 'Dr. Arvind Kulkarni', 'Morning');
      await expect(kulkarni).toContainText('Unavailable');
      await expect(kulkarni.getByRole('button', { name: /^Reopen session/ })).toBeVisible();

      const afternoon = rowFor(page, 'Dr. Meenakshi Rao', 'Afternoon');
      await expect(afternoon).toContainText('Not started');
      await expect(afternoon.getByRole('button', { name: /^Open session/ })).toBeVisible();

      await expect(page.getByRole('region', { name: 'Background work' })).toContainText('Worker running');
      await noSideScroll(page);
      await shot(page, `w6-admin-sessions-${width}`);
    });

    test(`new session: an overlap is explained in words with the other session's times, then a free time is created (${width})`, async ({ page }) => {
      const { admin, go } = await open(page, '/admin');
      await go();
      await page.getByRole('button', { name: 'New session' }).first().click();
      const dialog = page.getByRole('dialog', { name: 'New session' });
      await expect(dialog.getByLabel('Booked places')).toHaveValue('10');
      await expect(dialog.getByLabel('Walk-in places')).toHaveValue('5');
      await expect(dialog.getByLabel('Date')).toHaveValue('2026-11-11');
      await dialog.getByRole('combobox', { name: 'Doctor' }).click();
      await page.getByRole('option', { name: /Meenakshi Rao/ }).click();
      await expect(dialog.getByTestId('new-session-label')).toHaveText('Morning');
      await dialog.getByRole('button', { name: 'Create session' }).click();

      const alert = dialog.getByRole('alert').filter({ hasText: 'Session not created' });
      await expect(alert).toContainText('Dr. Meenakshi Rao already has a session from 9:00 am to 1:00 pm on Wed, 11 Nov.');
      await shot(page, `w6-admin-new-session-overlap-${width}`, false);

      await dialog.getByLabel('Start time').fill('18:00');
      await dialog.getByLabel('End time').fill('20:00');
      await expect(dialog.getByTestId('new-session-label')).toHaveText('Evening');
      await dialog.getByRole('button', { name: 'Create session' }).click();
      await expect(dialog).toBeHidden();
      await expect(rowFor(page, 'Dr. Meenakshi Rao', 'Evening')).toContainText('Not started');
      const post = admin.requests.filter((r) => r.line === 'POST /sessions').at(-1)!;
      expect(post.body).toMatchObject({ label: 'evening', startsAt: '2026-11-11T18:00:00+05:30', endsAt: '2026-11-11T20:00:00+05:30', bookedCapacity: 10, walkinCapacity: 5 });
      expect(post.key).toBeTruthy();
      await noSideScroll(page);
      await shot(page, `w6-admin-sessions-created-${width}`);
    });

    test(`new session: repeat for the next days lists each day and skips the ones that overlap (${width})`, async ({ page }) => {
      const { admin, go } = await open(page, '/admin');
      await go();
      await page.getByRole('button', { name: 'New session' }).first().click();
      const dialog = page.getByRole('dialog', { name: 'New session' });
      await dialog.getByRole('combobox', { name: 'Doctor' }).click();
      await page.getByRole('option', { name: /Pooja Bhat/ }).click();
      await dialog.getByLabel('Date').fill('2026-11-17');
      await dialog.getByLabel('Repeat for the next days').fill('3');
      await expect(dialog.getByText('Creates 4 sessions: Tue, 17 Nov to Fri, 20 Nov.')).toBeVisible();
      await dialog.getByRole('button', { name: 'Create 4 sessions' }).click();

      const results = dialog.getByTestId('create-result');
      await expect(results).toHaveCount(4);
      await expect(results.nth(0)).toContainText('Tue, 17 Nov: overlaps Morning 9:00 am to 1:00 pm');
      await expect(results.nth(1)).toContainText('Wed, 18 Nov: overlaps Morning 9:00 am to 1:00 pm');
      await expect(results.nth(2)).toContainText('Thu, 19 Nov: created');
      await expect(results.nth(3)).toContainText('Fri, 20 Nov: created');
      await expect(dialog.getByText('2 of 4 sessions created. 2 were skipped.')).toBeVisible();
      expect(admin.requests.filter((r) => r.line === 'POST /sessions')).toHaveLength(4);
      await shot(page, `w6-admin-new-session-repeat-${width}`, false);

      await dialog.getByRole('button', { name: 'Done' }).click();
      await expect(dialog).toBeHidden();
      // The page jumps to the first day that was created, past the seeded week.
      await expect(page.getByTestId('session-date-words')).toHaveText('Thu, 19 Nov');
      await expect(page.getByTestId('session-row')).toHaveCount(1);
      await expect(page.getByTestId('session-row')).toContainText('Dr. Pooja Bhat');
    });

    test(`empty day past the seeded week: says so and offers New session for that date (${width})`, async ({ page }) => {
      const { go } = await open(page, '/admin');
      await go();
      await page.getByLabel('Date', { exact: true }).fill('2026-11-28');
      await expect(page.getByRole('heading', { name: 'No sessions on Sat, 28 Nov' })).toBeVisible();
      await noSideScroll(page);
      await shot(page, `w6-admin-sessions-empty-${width}`);
      await page.getByRole('button', { name: 'New session' }).last().click();
      await expect(page.getByRole('dialog', { name: 'New session' }).getByLabel('Date')).toHaveValue('2026-11-28');
    });

    test(`reopen needs a reason; close asks first (${width})`, async ({ page }) => {
      const { admin, go } = await open(page, '/admin');
      await go();
      const kulkarni = rowFor(page, 'Dr. Arvind Kulkarni', 'Morning');
      await kulkarni.getByRole('button', { name: /^Reopen session/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Reopen this session' });
      await dialog.getByRole('button', { name: 'Reopen session' }).click();
      await expect(dialog.getByText('Give a reason of at least 3 characters.')).toBeVisible();
      await dialog.getByLabel('Reason').fill('Marked unavailable by mistake, doctor is back on the floor');
      await shot(page, `w6-admin-reopen-${width}`, false);
      await dialog.getByRole('button', { name: 'Reopen session' }).click();
      await expect(dialog).toBeHidden();
      await expect(kulkarni).toContainText('Available');
      expect(admin.requests.find((r) => r.line.endsWith('/reopen'))!.body).toEqual({ reason: 'Marked unavailable by mistake, doctor is back on the floor' });

      const rao = rowFor(page, 'Dr. Meenakshi Rao', 'Morning');
      await rao.getByRole('button', { name: /^Close session/ }).click();
      const confirm = page.getByRole('dialog', { name: 'Close this session?' });
      await expect(confirm).toContainText('cannot be opened again');
      await shot(page, `w6-admin-close-confirm-${width}`, false);
      await confirm.getByRole('button', { name: 'Close session' }).click();
      await expect(rao).toContainText('Ended');
      await expect(rao.getByRole('button', { name: /^Close session/ })).toHaveCount(0);
    });

    test(`new session works by keyboard: open, choose the doctor, submit, close (${width})`, async ({ page }) => {
      const { admin, go } = await open(page, '/admin');
      await go();
      await page.getByRole('button', { name: 'New session' }).first().focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'New session' });
      await expect(dialog).toBeVisible();
      await page.getByRole('combobox', { name: 'Doctor' }).focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('combobox', { name: 'Doctor' })).toContainText('Dr. Meenakshi Rao');
      await dialog.getByLabel('Start time').fill('21:00');
      await dialog.getByLabel('End time').fill('23:00');
      await dialog.getByLabel('Repeat for the next days').focus();
      await page.keyboard.press('Enter');
      await expect(dialog).toBeHidden();
      expect(admin.requests.some((r) => r.line === 'POST /sessions')).toBe(true);
      await expect(rowFor(page, 'Dr. Meenakshi Rao', 'Night')).toBeVisible();

      await page.getByRole('button', { name: 'New session' }).first().focus();
      await page.keyboard.press('Enter');
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    });

    test(`staff: add a member, see the temporary password once, deactivate and reset (${width})`, async ({ page }) => {
      const { admin, go } = await open(page, '/admin/staff');
      await go();
      const rows = page.getByTestId('staff-row');
      await expect(rows).toHaveCount(6);
      await expect(rows.filter({ hasText: 'Rakesh Pai' })).toContainText('Deactivated');
      await expect(rows.filter({ hasText: 'Rakesh Pai' })).toHaveAttribute('data-active', 'false');
      await noSideScroll(page);
      await shot(page, `w6-admin-staff-${width}`);

      await page.getByRole('button', { name: 'Add staff member' }).click();
      const add = page.getByRole('dialog', { name: 'Add staff member' });
      await add.getByLabel('Name').fill('Kavya Rangan');
      await add.getByLabel('Email').fill('kavya.rangan@hospital.example');
      await add.getByRole('combobox', { name: 'Role' }).click();
      await page.getByRole('option', { name: 'Reception' }).click();
      await add.getByRole('checkbox', { name: /Dr\. Farah Siddiqui/ }).click();
      await shot(page, `w6-admin-staff-add-${width}`, false);
      await add.getByRole('button', { name: 'Create account' }).click();

      const pw = page.getByRole('dialog', { name: 'Temporary password' });
      await expect(pw.getByTestId('temp-password')).toHaveText(TEMP_PASSWORD);
      await expect(pw).toContainText('Give this to the staff member. It is shown only once.');
      await shot(page, `w6-admin-staff-password-${width}`, false);
      await pw.getByRole('button', { name: 'Done' }).click();
      await expect(pw).toBeHidden();
      await expect(page.getByText(TEMP_PASSWORD)).toHaveCount(0);
      await expect(rows).toHaveCount(7);
      expect(admin.requests.find((r) => r.line === 'POST /admin/staff')!.key).toBeTruthy();

      // Deactivate with a reason: the row is marked in words.
      await rows.filter({ hasText: 'Lata Menon' }).getByRole('button', { name: 'Deactivate, Lata Menon' }).click();
      const dlg = page.getByRole('dialog', { name: 'Deactivate this account?' });
      await dlg.getByLabel('Reason').fill('Moved to the Whitefield branch');
      await dlg.getByRole('button', { name: 'Deactivate account' }).click();
      await expect(dlg).toBeHidden();
      await expect(rows.filter({ hasText: 'Lata Menon' })).toContainText('Deactivated');
      await expect(rows.filter({ hasText: 'Lata Menon' }).getByRole('button', { name: 'Activate, Lata Menon' })).toBeVisible();
      await shot(page, `w6-admin-staff-deactivated-${width}`);

      // An admin cannot deactivate themself.
      await rows.filter({ hasText: 'Vikram Shetty' }).getByRole('button', { name: 'Deactivate, Vikram Shetty' }).click();
      const self = page.getByRole('dialog', { name: 'Deactivate this account?' });
      await self.getByLabel('Reason').fill('Testing');
      await self.getByRole('button', { name: 'Deactivate account' }).click();
      await expect(self.getByRole('alert')).toContainText('You cannot deactivate your own account. Ask another admin to do it.');
      await shot(page, `w6-admin-staff-self-${width}`, false);
      await self.getByRole('button', { name: 'Cancel' }).click();

      // Reset a password: a new temporary password is shown once.
      await rows.filter({ hasText: 'Deepa Nair' }).getByRole('button', { name: 'Reset password, Deepa Nair' }).click();
      const reset = page.getByRole('dialog', { name: 'Reset password' });
      await reset.getByLabel('Reason').fill('Forgot it at the desk');
      await reset.getByRole('button', { name: 'Reset password' }).click();
      await expect(page.getByRole('dialog', { name: 'Temporary password' })).toContainText('Password reset for Deepa Nair');
    });

    test(`staff: a new doctor can be linked or created (${width})`, async ({ page }) => {
      const { admin, go } = await open(page, '/admin/staff');
      await go();
      await page.getByRole('button', { name: 'Add staff member' }).click();
      const add = page.getByRole('dialog', { name: 'Add staff member' });
      await add.getByLabel('Name').fill('Dr. Arvind Kulkarni');
      await add.getByLabel('Email').fill('arvind.kulkarni@hospital.example');
      await add.getByRole('combobox', { name: 'Role' }).click();
      await page.getByRole('option', { name: 'Doctor' }).click();
      await add.getByRole('combobox', { name: 'Doctor record' }).click();
      // Dr. Rao already has a sign-in, so is not offered.
      await expect(page.getByRole('option', { name: /Meenakshi Rao/ })).toHaveCount(0);
      await page.getByRole('option', { name: /Arvind Kulkarni/ }).click();
      await shot(page, `w6-admin-staff-add-doctor-${width}`, false);
      await add.getByRole('button', { name: 'Create account' }).click();
      await expect(page.getByRole('dialog', { name: 'Temporary password' })).toBeVisible();
      expect(admin.requests.find((r) => r.line === 'POST /admin/staff')!.body).toMatchObject({ role: 'doctor', doctorId: expect.stringMatching(/d2$/) });
    });

    test(`background work: calm when fine, urgent in words when the worker is down (${width})`, async ({ page }) => {
      const { admin, go } = await open(page, '/admin');
      admin.system = structuredClone(SYSTEM_DOWN);
      await go();
      const panel = page.getByRole('region', { name: 'Background work' });
      const alert = panel.getByRole('alert');
      await expect(alert).toContainText('Worker stopped');
      await expect(alert).toContainText('Timers, notifications and document reading are stopped. Start the worker.');
      await expect(alert).toContainText('Last seen 9:12 am');
      await expect(panel.getByTestId('stat-overdue')).toContainText('14, oldest waiting 52 min');
      await expect(panel.getByTestId('stat-dead')).toHaveText('2');
      await expect(panel.getByTestId('stat-notifications')).toContainText('11 queued, 3 failed');
      await panel.getByRole('link', { name: 'Notifications sent' }).click();
      await expect(page).toHaveURL(/\/admin\/notifications$/);
      await page.goto('/admin');
      await noSideScroll(page);
      await shot(page, `w6-admin-system-down-${width}`);
    });

    test(`background work: the panel says when its status cannot be read (${width})`, async ({ page }) => {
      const { admin, go } = await open(page, '/admin');
      admin.failSystem = true;
      await go();
      await expect(page.getByRole('region', { name: 'Background work' }).getByText('Background work status could not be loaded')).toBeVisible();
      await expect(page.getByRole('region', { name: 'Background work' }).getByRole('button', { name: 'Try again' })).toBeVisible();
    });
  });
}
