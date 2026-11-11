import { expect, test, type Page } from '@playwright/test';
import { mockApi } from './mocks';
import { installFakeEventSource, mockQueue, type QueueMock, type QueueMockOptions } from './mocks-queue';
import { mockScheduling } from './scheduling-mocks';
import { routeLiveBoardToQueueMock } from './w3-mocks';
import { shot } from './w3-helpers';

/** Screens are fed by mocks (fixed clock, stateful /api); the pressure text below is a fixture, not a measurement. */
const HIGH = {
  level: 'high' as const,
  reasons: ['9 patients are waiting and the projected finish is 25 min after the session ends.', 'W-005 has waited 41 min, close to the 45 min aging trigger.'],
};
const OVERLOADED = {
  level: 'overloaded' as const,
  reasons: [
    '12 patients are waiting and the projected finish is 1 h 10 min after the session ends.',
    'A-015 has waited 52 min and the aging rule is already calling by wait time.',
    '2 clinical priority patients are ahead of the rotation.',
  ],
};

async function setupDoctor(page: Page, options: QueueMockOptions): Promise<QueueMock> {
  await installFakeEventSource(page);
  await mockApi(page, 'doctor');
  return mockQueue(page, options);
}

async function doctorReady(page: Page) {
  await expect(page.getByRole('heading', { name: 'Doctor console', level: 1 })).toBeVisible();
  await expect(page.getByText('Waiting, in call order')).toBeVisible();
  await expect(page.getByText(/Last updated/)).toBeVisible();
}

test.describe('workload pressure on the doctor console at 1280', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('normal workload shows nothing', async ({ page }) => {
    await setupDoctor(page, {});
    await page.goto('/doctor');
    await doctorReady(page);
    await expect(page.getByTestId('pressure-note')).toHaveCount(0);
    await expect(page.getByText(/Workload:/)).toHaveCount(0);
  });

  test('high: bold ink words, the reasons, an ink edge and no red', async ({ page }) => {
    await setupDoctor(page, { pressure: HIGH });
    await page.goto('/doctor');
    await doctorReady(page);
    const note = page.getByTestId('pressure-note');
    await expect(note).toContainText('Workload: High');
    await expect(note.getByRole('listitem')).toHaveCount(2);
    const style = await note.evaluate((el) => {
      const cs = getComputedStyle(el);
      const word = getComputedStyle(el.querySelector('p') as HTMLElement);
      return { edge: cs.borderLeftColor, edgeWidth: cs.borderLeftWidth, wordColor: word.color, weight: word.fontWeight };
    });
    expect(style.edge).toBe('rgb(22, 35, 43)');
    expect(style.edgeWidth).toBe('3px');
    expect(style.wordColor).toBe('rgb(22, 35, 43)');
    expect(Number(style.weight)).toBeGreaterThanOrEqual(700);
    await shot(page, 'w4-doctor-pressure-high-1280');
  });

  test('overloaded: the level and every reason are on screen', async ({ page }) => {
    await setupDoctor(page, { pressure: OVERLOADED });
    await page.goto('/doctor');
    await doctorReady(page);
    const note = page.getByTestId('pressure-note');
    await expect(note).toContainText('Workload: Overloaded');
    await expect(note.getByRole('listitem')).toHaveCount(3);
    await shot(page, 'w4-doctor-pressure-overloaded-1280');
  });

  test('a paused session uses an ink edge, not red', async ({ page }) => {
    await setupDoctor(page, { status: 'paused' });
    await page.goto('/doctor');
    await expect(page.getByTestId('session-status')).toContainText('Session paused');
    const edge = await page.getByTestId('session-status').evaluate((el) => getComputedStyle(el).borderLeftColor);
    expect(edge).toBe('rgb(22, 35, 43)');
  });
});

test.describe('workload pressure on the reception board at 1440', () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

  test('the board header carries the note, and the capacity bar waits for the snapshot', async ({ page }) => {
    await installFakeEventSource(page);
    await mockApi(page, 'reception');
    await mockQueue(page, { pressure: HIGH, queueDelayMs: 800 });
    await mockScheduling(page);
    await routeLiveBoardToQueueMock(page);
    await page.goto('/reception');
    await expect(page.getByRole('heading', { name: 'Reception desk', level: 1 })).toBeVisible();
    const board = page.getByRole('region', { name: 'Session board' });
    await expect(board.getByTestId('capacity-skeleton')).toBeVisible();
    await expect(board.getByTestId('pressure-note')).toContainText('Workload: High');
    await expect(board.getByTestId('capacity-skeleton')).toHaveCount(0);
    await expect(board.getByText('Booked', { exact: true }).first()).toBeVisible();
    await shot(page, 'w4-reception-pressure-1440');
  });
});
