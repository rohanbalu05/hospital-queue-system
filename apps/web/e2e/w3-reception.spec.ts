/* eslint-disable @typescript-eslint/no-non-null-assertion -- specs assert on values the mocks just created */
import { expect, test, type Page } from '@playwright/test';
import { mockApi } from './mocks';
import { installFakeEventSource, mockQueue, type QueueMock } from './mocks-queue';
import { mockScheduling } from './scheduling-mocks';
import { routeLiveBoardToQueueMock } from './w3-mocks';
import { shot } from './w3-helpers';

async function setup(page: Page): Promise<QueueMock> {
  await installFakeEventSource(page);
  await mockApi(page, 'reception');
  const queue = await mockQueue(page);
  await mockScheduling(page);
  await routeLiveBoardToQueueMock(page);
  return queue;
}

async function ready(page: Page) {
  await expect(page.getByRole('heading', { name: 'Reception desk', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Waiting, appointment' })).toBeVisible();
}

test.describe('reception live board at 1440', () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

  test('the live queue lanes sit in the centre column under the capacity bar', async ({ page }) => {
    await setup(page);
    await page.goto('/reception');
    await ready(page);
    const board = page.getByRole('region', { name: 'Session board' });
    // Capacity bar once, then the live lanes, then the arrivals lanes.
    await expect(board.getByText('Walk-in', { exact: true }).first().locator('..')).toContainText('0/5');
    await expect(board.getByText('Booked', { exact: true }).first().locator('..')).toContainText('8/10');
    for (const lane of ['Called', 'In service', 'Waiting, appointment', 'Waiting, walk-in', 'Skipped or absent']) {
      await expect(board.getByRole('heading', { name: lane })).toBeVisible();
    }
    await expect(board.getByText('Harish Gowda').first()).toBeVisible();
    await expect(board.getByText(/Last updated/)).toBeVisible();
    // Centre column: between search (left) and actions (right).
    const mid = await board.boundingBox();
    const left = await page.getByRole('region', { name: 'Find arrivals' }).boundingBox();
    const right = await page.getByRole('region', { name: 'Actions' }).boundingBox();
    expect(left!.x + left!.width).toBeLessThanOrEqual(mid!.x + 1);
    expect(mid!.x + mid!.width).toBeLessThanOrEqual(right!.x + 1);
    await shot(page, 'w3-reception-live-1440');
  });

  test('mark absent: select a waiting patient on the board, then Mark absent', async ({ page }) => {
    const queue = await setup(page);
    await page.goto('/reception');
    await ready(page);
    const panel = page.getByTestId('entry-panel');
    await expect(panel.getByRole('button', { name: 'Mark absent' })).toBeDisabled();
    await expect(panel.getByRole('button', { name: 'Re-enter skipped' })).toBeDisabled();

    await page.getByRole('button', { name: /Rohan Deshpande/ }).click();
    await expect(panel).toContainText('Rohan Deshpande');
    await expect(panel.getByRole('button', { name: 'Mark absent' })).toBeEnabled();
    await panel.getByRole('button', { name: 'Mark absent' }).click();
    await expect(page.getByText('Marked absent').first()).toBeVisible();
    expect(queue.requests.some((r) => /\/queue-entries\/.+\/absent$/.test(r.line))).toBe(true);
    // The patient moves to the skipped and absent lane.
    const skipped = page.getByRole('region', { name: 'Skipped or absent' });
    await expect(skipped).toContainText('Rohan Deshpande');
    await expect(skipped).toContainText('Absent');
  });

  test('re-enter skipped by keyboard: Tab from the board to the action, Enter', async ({ page }) => {
    const queue = await setup(page);
    await page.goto('/reception');
    await ready(page);
    const row = page.getByRole('button', { name: /Geetha Murthy/ });
    await row.focus();
    await page.keyboard.press('Enter');
    const reenter = page.getByRole('button', { name: 'Re-enter skipped' });
    await expect(reenter).toBeEnabled();
    // Reachable by Tab from the board without the mouse.
    for (let i = 0; i < 60 && !(await reenter.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
    await expect(reenter).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Re-entered').first()).toBeVisible();
    expect(queue.requests.find((r) => /\/re-enter$/.test(r.line))!.body).toEqual({ expectedVersion: 1 });
  });

  test('re-enter after the grace period asks for review, then retries with admitLate', async ({ page }) => {
    const queue = await setup(page);
    let first = true;
    await page.route(/\/api\/queue-entries\/[^/]+\/re-enter$/, (route) => {
      const sent = route.request().postDataJSON() as { admitLate?: boolean };
      if (first && !sent.admitLate) {
        first = false;
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'LATE_ARRIVAL_REQUIRES_REVIEW', message: 'Past the grace period.', details: { minutesLate: 52, graceMinutes: 15, scheduledAt: '2026-11-11T09:05:00+05:30' } },
          }),
        });
      }
      return route.fallback();
    });
    await page.goto('/reception');
    await ready(page);
    await page.getByRole('button', { name: /Geetha Murthy/ }).click();
    await page.getByRole('button', { name: 'Re-enter skipped' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Returned 52 min after the appointment' })).toBeVisible();
    await expect(dialog).toContainText('after the 15 min grace');
    await expect(dialog.getByRole('button', { name: 'Not now' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Admit as late arrival' }).click();
    await expect(page.getByText('Re-entered').first()).toBeVisible();
    const calls = queue.requests.filter((r) => /\/re-enter$/.test(r.line));
    expect(calls.at(-1)!.body).toMatchObject({ admitLate: true });
  });
});
