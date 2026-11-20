/* eslint-disable @typescript-eslint/no-non-null-assertion -- specs assert on values the mocks just created */
import { expect, test, type Page } from '@playwright/test';
import { mockApi } from './mocks';
import { installFakeEventSource, mockQueue, type QueueMock, type QueueMockOptions } from './mocks-queue';
import { shot } from './w3-helpers';
import { mockSystemFine } from './w6-admin-mocks';
import { NOTIFICATION_ROWS, TARGET_FULL_WALKIN, mockNotificationLog, setupReceptionAvailability } from './w5-staff-mocks';

/**
 * W5 staff screens: doctor Step away / I'm back / Unavailable, reception banner and affected-patients move,
 * waiting-room banners, admin "Notifications sent". Screenshots at 1440 and 390 (display also at 1920).
 * The clock is fixed at 10:05 am IST on Wed 11 Nov 2026 by the queue mock.
 */

const AWAY_UNTIL = '2026-11-11T05:15:00.000Z'; // 10:45 am IST
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;

async function setupDoctor(page: Page, options: QueueMockOptions = {}): Promise<QueueMock> {
  await installFakeEventSource(page);
  await mockApi(page, 'doctor');
  return mockQueue(page, options);
}

async function doctorReady(page: Page) {
  await expect(page.getByRole('heading', { name: 'Doctor console', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Call next/ })).toBeVisible();
  await expect(page.getByText(/Last updated/)).toBeVisible();
}

for (const vp of VIEWPORTS) {
  test.describe(`doctor availability at ${vp.width}`, () => {
    test.use({ viewport: vp, deviceScaleFactor: 1 });

    test('step away: reason, return time, computed "Back about", then the away strip with I\'m back', async ({ page }) => {
      const mock = await setupDoctor(page);
      await page.goto('/doctor');
      await doctorReady(page);

      await page.getByRole('button', { name: 'Step away' }).click();
      const dialog = page.getByRole('dialog', { name: 'Step away' });
      await expect(dialog.getByRole('radio', { name: 'Ward round / emergency' })).toBeChecked();
      await dialog.getByRole('button', { name: '30 min' }).click();
      await expect(dialog.getByTestId('back-about')).toHaveText('Back about 10:35 am');
      await shot(page, `w5-doctor-step-away-dialog-${vp.width}`, false);

      await dialog.getByRole('button', { name: 'Step away' }).click();
      const strip = page.getByTestId('availability-strip');
      await expect(strip).toContainText('You are away · since 10:05 am · expected back about 10:35 am');
      await expect(strip).toContainText('Reason: Ward round / emergency');
      expect(mock.requests.find((r) => r.line.endsWith('/pause'))?.body).toEqual({ until: '2026-11-11T05:05:00.000Z', reason: 'Ward round / emergency' });
      // The queue stays visible and in order; Call next says why it is off.
      await expect(page.getByRole('region', { name: 'Waiting, in call order' })).toContainText('Harish Gowda');
      await expect(page.getByRole('button', { name: /^Call next/ })).toHaveAttribute('aria-disabled', 'true');
      await expect(page.getByText("You are away, so no one can be called. Press I'm back to call the next patient.")).toBeVisible();
      await shot(page, `w5-doctor-away-${vp.width}`);

      // Change return time re-opens the dialog in update mode.
      await strip.getByRole('button', { name: 'Change return time' }).click();
      const change = page.getByRole('dialog', { name: 'Change return time' });
      await change.getByRole('button', { name: '60 min' }).click();
      await change.getByRole('button', { name: 'Update return time' }).click();
      await expect(strip).toContainText('expected back about 11:05 am');

      await strip.getByRole('button', { name: "I'm back" }).click();
      await expect(strip).toBeHidden();
      await expect(page.getByRole('button', { name: /^Call next/ })).toHaveAttribute('aria-disabled', 'false');
    });

    test('overdue return says longer than expected', async ({ page }) => {
      await setupDoctor(page, { status: 'paused', pausedAt: '2026-11-11T04:00:00.000Z', pauseUntil: '2026-11-11T04:30:00.000Z' });
      await page.goto('/doctor');
      await expect(page.getByTestId('availability-strip')).toContainText('You are away · since 9:30 am · longer than expected');
      await shot(page, `w5-doctor-away-overdue-${vp.width}`);
    });

    test('step away is refused while a patient is called and has not started: plain message, nothing changed', async ({ page }) => {
      const mock = await setupDoctor(page);
      await page.goto('/doctor');
      await doctorReady(page);
      await page.keyboard.press('n');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('now-state')).toContainText('Called');

      await page.getByRole('button', { name: 'Step away' }).click();
      const dialog = page.getByRole('dialog', { name: 'Step away' });
      await dialog.getByRole('button', { name: 'Step away' }).click();
      await expect(dialog.getByRole('alert')).toContainText('A patient has been called and has not started yet. Start that visit or skip the patient first, then step away.');
      expect(mock.world.status).toBe('open');
      await shot(page, `w5-doctor-step-away-blocked-${vp.width}`, false);
    });

    test('a return after the session end is refused with a plain message', async ({ page }) => {
      await setupDoctor(page);
      await page.goto('/doctor');
      await doctorReady(page);
      await page.getByRole('button', { name: 'Step away' }).click();
      const dialog = page.getByRole('dialog', { name: 'Step away' });
      await dialog.getByRole('button', { name: 'Custom time' }).click();
      await dialog.getByLabel('Back at (India time)').fill('13:30');
      await expect(dialog).toContainText('The session ends at 1:00 pm');
      await shot(page, `w5-doctor-step-away-after-end-${vp.width}`, false);
    });

    test('unavailable for the rest of the session: consequences, a reason, and a button that says what it does', async ({ page }) => {
      await setupDoctor(page);
      await page.goto('/doctor');
      await doctorReady(page);
      await page.getByRole('button', { name: 'Unavailable for rest of session' }).click();
      const dialog = page.getByRole('dialog', { name: 'Unavailable for the rest of this session' });
      await expect(dialog).toContainText('Patients waiting and booked for this session will be told and offered other doctors. This cannot be undone.');
      await dialog.getByLabel('Reason').fill('Called to emergency theatre');
      await shot(page, `w5-doctor-unavailable-dialog-${vp.width}`, false);
      await dialog.getByRole('button', { name: 'Mark unavailable and notify patients' }).click();
      const strip = page.getByTestId('availability-strip');
      await expect(strip).toContainText('You are unavailable for the rest of this session');
      await expect(strip).toContainText('Reason: Called to emergency theatre');
      await expect(page.getByRole('button', { name: 'Unavailable for rest of session' })).toBeDisabled();
      await shot(page, `w5-doctor-unavailable-${vp.width}`);
    });
  });
}

test.describe('doctor availability by keyboard alone (NFR-08)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('open Step away, choose a reason and a preset, submit, then I\'m back and N still focuses Call next', async ({ page }) => {
    const mock = await setupDoctor(page);
    await page.goto('/doctor');
    await doctorReady(page);

    await page.getByRole('button', { name: 'Step away' }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Step away' });
    await expect(dialog).toBeVisible();
    // Focus is inside the dialog. Arrow keys move between the reasons and Space selects one.
    await dialog.getByRole('radio', { name: 'Ward round / emergency' }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(dialog.getByRole('radio', { name: 'Break' })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(dialog.getByRole('radio', { name: 'Break' })).toBeChecked();
    await dialog.getByRole('button', { name: '10 min' }).focus();
    await page.keyboard.press('Enter');
    await expect(dialog.getByTestId('back-about')).toHaveText('Back about 10:15 am');
    await dialog.getByRole('button', { name: 'Step away', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('availability-strip')).toContainText('expected back about 10:15 am');
    await expect(dialog).toBeHidden();
    expect(mock.requests.find((r) => r.line.endsWith('/pause'))?.body).toEqual({ until: '2026-11-11T04:45:00.000Z', reason: 'Break' });

    // N still jumps to Call next while away, and Call next says why it cannot be used.
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await page.keyboard.press('n');
    await expect(page.getByRole('button', { name: /^Call next/ })).toBeFocused();
    await page.getByRole('button', { name: "I'm back" }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('availability-strip')).toBeHidden();
  });
});

for (const vp of VIEWPORTS) {
  test.describe(`reception availability and affected patients at ${vp.width}`, () => {
    test.use({ viewport: vp, deviceScaleFactor: 1 });

    test('away banner on the board, then the affected-patients move with per-patient results', async ({ page }) => {
      const { queue, affected } = await setupReceptionAvailability(page, { status: 'paused', pauseUntil: AWAY_UNTIL });
      await page.goto('/reception');
      await expect(page.getByRole('heading', { name: 'Reception desk', level: 1 })).toBeVisible();
      const strip = page.getByTestId('availability-strip');
      await expect(strip).toContainText('Dr. Meenakshi Rao is away · since 10:30 am · expected back about 10:45 am');
      await expect(strip.getByRole('button', { name: "I'm back" })).toBeVisible();
      await expect(strip.getByRole('button', { name: 'Affected patients (10)' })).toBeVisible();
      await shot(page, `w5-reception-away-${vp.width}`);

      await strip.getByRole('button', { name: /^Affected patients/ }).click();
      const dialog = page.getByRole('dialog', { name: /Affected patients/ });
      await expect(dialog.getByRole('region', { name: 'In the queue' })).toContainText('Harish Gowda');
      await expect(dialog.getByRole('region', { name: 'Booked, not arrived' })).toContainText('+919900112233');
      await expect(dialog.getByRole('region', { name: 'Booked, not arrived' })).toContainText('Has app: no');
      await dialog.getByRole('checkbox', { name: 'Select all' }).check();
      await expect(dialog.getByTestId('affected-count')).toHaveText('10 of 10 selected');
      await dialog.getByRole('radio', { name: /Dr\. Farah Siddiqui/ }).check();
      await shot(page, `w5-reception-affected-${vp.width}`, false);

      await dialog.getByRole('button', { name: 'Move 10 patients to Dr. Farah Siddiqui' }).click();
      const results = dialog.getByTestId('move-results');
      await expect(results).toContainText('moved to Dr. Farah Siddiqui');
      await expect(results.locator('[data-outcome="skipped"]').first()).toContainText('No place left in Dr. Farah Siddiqui');
      await expect(results.locator('[data-outcome="moved"]').first()).toContainText(/New (token|time)/);
      expect(affected.moves).toHaveLength(1);
      expect(affected.moves[0]!.body.targetSessionId).toBe(TARGET_FULL_WALKIN);
      expect(affected.moves[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
      await shot(page, `w5-reception-affected-results-${vp.width}`, false);
      expect(queue.world.status).toBe('paused');
    });

    test('reception steps the doctor away and brings them back', async ({ page }) => {
      const { queue } = await setupReceptionAvailability(page);
      await page.goto('/reception');
      await expect(page.getByRole('heading', { name: 'Reception desk', level: 1 })).toBeVisible();
      const panel = page.getByTestId('availability-panel');
      await shot(page, `w5-reception-available-${vp.width}`);
      await panel.getByRole('button', { name: 'Step away' }).click();
      const dialog = page.getByRole('dialog', { name: 'Step away' });
      await expect(dialog).toContainText('No one is called for Dr. Meenakshi Rao while they are away.');
      await dialog.getByRole('button', { name: 'Step away', exact: true }).click();
      await expect(page.getByTestId('availability-strip')).toContainText('Dr. Meenakshi Rao is away · since 10:05 am');
      expect(queue.world.status).toBe('paused');
      await page.getByTestId('availability-strip').getByRole('button', { name: "I'm back" }).click();
      await expect(page.getByTestId('availability-strip')).toBeHidden();
      expect(queue.world.status).toBe('open');
    });

    test('unavailable banner is urgent and still offers the affected patients', async ({ page }) => {
      await setupReceptionAvailability(page, { status: 'unavailable' });
      await page.goto('/reception');
      const strip = page.getByTestId('availability-strip');
      await expect(strip).toContainText('Dr. Meenakshi Rao is unavailable for the rest of this session · since 10:30 am');
      await expect(strip).toContainText('Reason: Called to emergency theatre');
      await expect(strip.getByRole('button', { name: /^Affected patients/ })).toBeVisible();
      await expect(strip.getByRole('button', { name: "I'm back" })).toHaveCount(0);
      await shot(page, `w5-reception-unavailable-${vp.width}`);
    });

    test('affected patients: a failed load says what happened and offers a retry', async ({ page }) => {
      const { affected } = await setupReceptionAvailability(page, { status: 'paused', pauseUntil: AWAY_UNTIL });
      affected.fail = true;
      await page.goto('/reception');
      const strip = page.getByTestId('availability-strip');
      await expect(strip).toBeVisible();
      await strip.getByRole('button', { name: /^Affected patients/ }).click();
      const dialog = page.getByRole('dialog', { name: /Affected patients/ });
      // The app retries a failing read twice before it gives up.
      await expect(dialog.getByRole('alert')).toContainText('The affected patients could not be loaded', { timeout: 15_000 });
      await shot(page, `w5-reception-affected-error-${vp.width}`, false);
      affected.fail = false;
      await dialog.getByRole('button', { name: 'Try again' }).click();
      await expect(dialog.getByRole('region', { name: 'In the queue' })).toBeVisible();
    });
  });
}

const DISPLAY_VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;

for (const vp of DISPLAY_VIEWPORTS) {
  test.describe(`waiting-room availability banner at ${vp.width}`, () => {
    test.use({ viewport: vp, deviceScaleFactor: 1 });

    async function openDisplay(page: Page, options: QueueMockOptions) {
      await installFakeEventSource(page);
      await mockApi(page, null);
      const mock = await mockQueue(page, options);
      await page.goto('/display');
      await expect(page.getByTestId('display-column').first()).toBeVisible();
      return mock;
    }

    test('away with an expected time', async ({ page }) => {
      await openDisplay(page, { status: 'paused', pauseUntil: AWAY_UNTIL });
      const mine = page.getByTestId('display-column').first();
      await expect(mine.getByTestId('display-banner')).toHaveText('Dr. Meenakshi Rao is temporarily away, expected back about 10:45 am');
      // Tokens only: no patient names, no free-text reason.
      await expect(page.locator('body')).not.toContainText('Harish');
      await expect(page.locator('body')).not.toContainText('Ward round');
      await shot(page, `w5-display-away-${vp.width}`);
    });

    test('away and overdue, away with no time, and unavailable for the rest of the session', async ({ page }) => {
      const mock = await openDisplay(page, { status: 'paused', pauseUntil: '2026-11-11T04:30:00.000Z' });
      const mine = page.getByTestId('display-column').first();
      await expect(mine.getByTestId('display-banner')).toHaveText('Dr. Meenakshi Rao is away and will be back shortly');
      await shot(page, `w5-display-away-overdue-${vp.width}`);

      mock.world.pauseUntil = null;
      await mock.publish();
      await expect(mine.getByTestId('display-banner')).toHaveText('Dr. Meenakshi Rao is temporarily away');

      mock.world.status = 'unavailable';
      await mock.publish();
      await expect(mine.getByTestId('display-banner')).toHaveText('Dr. Meenakshi Rao is not available for the rest of this session. Please see reception.');
      await expect(mine.getByTestId('display-banner')).toHaveAttribute('data-state', 'unavailable');
      await shot(page, `w5-display-unavailable-${vp.width}`);
    });
  });
}

for (const vp of VIEWPORTS) {
  test.describe(`admin notifications sent at ${vp.width}`, () => {
    test.use({ viewport: vp, deviceScaleFactor: 1 });

    test('lists every delivery with channel, recipient, masked address, message and status; filters; refresh', async ({ page }) => {
      await mockApi(page, 'admin');
      await mockSystemFine(page); // the admin shell shows Background work on every page
      const log = await mockNotificationLog(page);
      await page.goto('/admin');
      await page.getByRole('link', { name: 'Notifications sent' }).click();
      await expect(page.getByRole('heading', { name: 'Notifications sent', level: 2 })).toBeVisible();
      const rows = page.getByTestId('notification-row').filter({ visible: true });
      await expect(rows).toHaveCount(NOTIFICATION_ROWS.length);
      await expect(rows.first()).toContainText('Harish Gowda');
      const failed = rows.filter({ hasText: 'Imran Pasha' });
      await expect(failed).toContainText('Failed');
      await expect(failed).toContainText('3 attempts, last error: Provider timed out');
      await expect(failed).toContainText('+91 ******8765');
      await expect(rows.filter({ hasText: 'Kavya Nambiar' })).toContainText('Queued');
      await expect(rows.filter({ hasText: 'Deepa Nair' })).toContainText('Reception');
      await shot(page, `w5-admin-notifications-${vp.width}`);

      await page.getByLabel('Status').click();
      await page.getByRole('option', { name: 'Failed' }).click();
      await expect(rows).toHaveCount(1);
      await page.getByLabel('Channel').click();
      await page.getByRole('option', { name: 'Email' }).click();
      await expect(page.getByText('No notifications match')).toBeVisible();
      await shot(page, `w5-admin-notifications-empty-${vp.width}`);
      expect(log.requests.some((s) => s.includes('status=failed'))).toBe(true);
      expect(log.requests.some((s) => s.includes('channel=email'))).toBe(true);

      const before = log.requests.length;
      await page.getByRole('button', { name: 'Refresh' }).click();
      await expect.poll(() => log.requests.length).toBeGreaterThan(before);
    });

    test('error state explains what happened and offers a retry', async ({ page }) => {
      await mockApi(page, 'admin');
      await mockSystemFine(page); // the admin shell shows Background work on every page
      await mockNotificationLog(page, [], { fail: true });
      await page.goto('/admin/notifications');
      await expect(page.getByRole('alert')).toContainText('The notification log could not be loaded');
      await shot(page, `w5-admin-notifications-error-${vp.width}`);
    });

    test('empty state says what appears here', async ({ page }) => {
      await mockApi(page, 'admin');
      await mockSystemFine(page); // the admin shell shows Background work on every page
      await mockNotificationLog(page, []);
      await page.goto('/admin/notifications');
      await expect(page.getByText('No notifications sent yet')).toBeVisible();
    });
  });
}

// PR-04: offline for more than about 10 s must say so, and coming back must refetch and clear the banner.
for (const vp of VIEWPORTS) {
  test.describe(`offline banner on staff screens at ${vp.width}`, () => {
    test.use({ viewport: vp, deviceScaleFactor: 1 });

    test('doctor console: Reconnecting… after 10 s offline, then a fresh snapshot on reconnect', async ({ page, context }) => {
      const mock = await setupDoctor(page);
      await page.goto('/doctor');
      await doctorReady(page);
      await context.setOffline(true);
      await expect(page.getByText('Reconnecting…')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(/Showing the queue as of/)).toBeVisible();
      await shot(page, `w5-doctor-offline-${vp.width}`);

      // While offline someone else called A-014; the snapshot refetches on reconnect.
      mock.world.active = { ...mock.world.waiting.shift()!, state: 'called', calledAt: '2026-11-11T04:34:00.000Z' };
      mock.world.version += 1;
      await context.setOffline(false);
      await expect(page.getByText('Reconnecting…')).toBeHidden();
      await expect(page.getByTestId('now-active')).toContainText('A-014');
    });

    test('reception board: Reconnecting… after 10 s offline and cleared on reconnect', async ({ page, context }) => {
      await setupReceptionAvailability(page);
      await page.goto('/reception');
      await expect(page.getByRole('heading', { name: 'Waiting, appointment' })).toBeVisible();
      await context.setOffline(true);
      await expect(page.getByText('Reconnecting…')).toBeVisible({ timeout: 15_000 });
      await shot(page, `w5-reception-offline-${vp.width}`);
      await context.setOffline(false);
      await expect(page.getByText('Reconnecting…')).toBeHidden();
    });
  });
}

for (const vp of [DISPLAY_VIEWPORTS[0], DISPLAY_VIEWPORTS[1]]) {
  test.describe(`offline banner on the display at ${vp.width}`, () => {
    test.use({ viewport: vp, deviceScaleFactor: 1 });

    test('shows Reconnecting… with the last-known time, then the called token after reconnect', async ({ page, context }) => {
      await installFakeEventSource(page);
      await mockApi(page, null);
      const mock = await mockQueue(page);
      await page.goto('/display');
      const mine = page.getByTestId('display-column').first();
      await expect(mine.getByTestId('now-calling-idle')).toBeVisible();
      await context.setOffline(true);
      await expect(page.getByText('Reconnecting…')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('last-updated')).toContainText('Showing the queue as of');
      await shot(page, `w5-display-offline-${vp.width}`);

      mock.world.active = { ...mock.world.waiting.shift()!, state: 'called' };
      mock.world.version += 1;
      await context.setOffline(false);
      await expect(mine.getByTestId('now-calling')).toHaveText('A-014');
      await expect(page.getByText('Reconnecting…')).toBeHidden();
    });
  });
}
