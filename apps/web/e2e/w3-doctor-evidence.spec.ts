/* eslint-disable @typescript-eslint/no-non-null-assertion -- specs assert on values the mock just created */
import { expect, test } from '@playwright/test';
import { mockApi } from './mocks';
import { installFakeEventSource, mockQueue } from './mocks-queue';
import { shot } from './w3-helpers';

/**
 * Real-screen evidence for the two non-default call reasons: an authorized clinical priority (P tag beside the
 * original token) and an aging override. Both use the doctor console with the queue mock, not a fixture page.
 */
test.describe('doctor console reasons at 1280', () => {
  test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });

  test('clinical priority: the P tag sits beside the original token and the reason says so', async ({ page }) => {
    await installFakeEventSource(page);
    await mockApi(page, 'doctor');
    const mock = await mockQueue(page);
    const first = mock.world.waiting[0]!;
    first.priorityClass = 1;
    first.priorityReason = 'Breathlessness at triage';
    await page.goto('/doctor');
    await expect(page.getByText(/Last updated/)).toBeVisible();

    await expect(page.getByText('A-014').first()).toBeVisible();
    await expect(page.locator('[data-group="P"]').first()).toBeVisible();
    await shot(page, 'w3-doctor-priority-waiting-1280');

    await page.keyboard.press('n');
    await page.keyboard.press('Enter');
    const decision = page.getByTestId('decision');
    await expect(decision).toContainText('Clinical priority');
    await expect(decision).toContainText('A-014');
    await expect(page.getByTestId('now-active')).toContainText('A-014');
    await shot(page, 'w3-doctor-priority-1280');
  });

  test('aging: the reason names how long the patient waited', async ({ page }) => {
    await installFakeEventSource(page);
    await mockApi(page, 'doctor');
    const mock = await mockQueue(page);
    const first = mock.world.waiting[0]!;
    first.waitingMinutes = 47;
    first.checkedInAt = '2026-11-11T09:18:00+05:30';
    await page.goto('/doctor');
    await expect(page.getByText(/Last updated/)).toBeVisible();

    await page.keyboard.press('n');
    await page.keyboard.press('Enter');
    const decision = page.getByTestId('decision');
    await expect(decision).toContainText('Aging: waited 47 min');
    await expect(decision).toContainText('Aging');
    await expect(page.getByTestId('now-active')).toContainText('A-014');
    await shot(page, 'w3-doctor-aging-1280');
  });
});
