/* eslint-disable @typescript-eslint/no-non-null-assertion -- specs assert on values the mock just created */
import { expect, test } from '@playwright/test';
import { mockApi } from './mocks';
import { installFakeEventSource, mockQueue, type DisplayColumnState } from './mocks-queue';
import { shot } from './w3-helpers';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const DOCTORS: Array<[string, string, string]> = [
  ['Dr. Arvind Kulkarni, Paediatrics', 'Room 4', 'A'],
  ['Dr. Farah Siddiqui, ENT', 'Room 7', 'W'],
  ['Dr. Suresh Gowda, Orthopaedics', 'Room 9', 'A'],
  ['Dr. Pooja Bhat, Dermatology', 'Room 3', 'A'],
  ['Dr. Kavitha Reddy, General Medicine', 'Room 14', 'W'],
  ['Dr. Rahul Menon, Cardiology', 'Room 21', 'A'],
  ['Dr. Anitha Rao, Gynaecology', 'Room 18', 'A'],
  ['Dr. Imran Sheikh, Ophthalmology', 'Room 22', 'W'],
  ['Dr. Lakshmi Iyer, Neurology', 'Room 25', 'A'],
  ['Dr. Prakash Hegde, Urology', 'Room 27', 'A'],
  ['Dr. Sunil Joshi, Psychiatry', 'Room 30', 'W'],
];

/** 11 more sessions besides the mock's own: 12 columns in all. */
function manyColumns(): DisplayColumnState[] {
  return DOCTORS.map(([doctorLabel, room, g], i) => ({
    sessionId: uuid(0x5e70 + i),
    doctorLabel,
    room,
    status: i === 5 ? 'paused' : 'open',
    nowCalling: i === 5 ? null : `${g}-0${10 + i}`,
    next: [`A-0${20 + i}`, `W-00${i % 9}`, `A-0${30 + i}`],
    queueVersion: 3 + i,
  }));
}

test.describe('waiting-room display with many sessions at 1920', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('12 sessions page through groups of 6, tokens stay at 120 px or more', async ({ page }) => {
    await installFakeEventSource(page);
    await mockApi(page);
    const mock = await mockQueue(page);
    mock.world.columns = manyColumns();
    await page.goto('/display?pageSeconds=2');

    const cols = page.getByTestId('display-column');
    await expect(cols).toHaveCount(6);
    await expect(page.getByTestId('display-page')).toHaveText('Page 1 of 2');
    await expect(cols.nth(1).getByTestId('now-calling')).toHaveText('A-010');
    // Wide cards: 3 per row, two rows, nothing clipped.
    const first = await cols.nth(0).boundingBox();
    const fourth = await cols.nth(3).boundingBox();
    const third = await cols.nth(2).boundingBox();
    expect(third!.y).toBeCloseTo(first!.y, 0);
    expect(fourth!.y).toBeGreaterThan(first!.y + first!.height - 2);
    for (const i of [0, 1, 2, 3, 4, 5]) {
      const box = await cols.nth(i).boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(1920);
      expect(box!.y + box!.height).toBeLessThanOrEqual(1080);
    }
    const fontPx = await cols.nth(1).getByTestId('now-calling').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fontPx).toBeGreaterThanOrEqual(120);
    // The token is not wider than its card (no overflow).
    const overflow = await cols.first().evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, 'w3-display-many-1920');

    // The next page follows on its own, then the first comes round again.
    await expect(page.getByTestId('display-page')).toHaveText('Page 2 of 2', { timeout: 10_000 });
    await expect(cols).toHaveCount(6);
    await expect(page.getByTestId('display-page')).toHaveText('Page 1 of 2', { timeout: 10_000 });
  });

  test('up to 6 sessions stay on one page with no page label', async ({ page }) => {
    await installFakeEventSource(page);
    await mockApi(page);
    const mock = await mockQueue(page);
    mock.world.columns = manyColumns().slice(0, 5);
    await page.goto('/display');
    await expect(page.getByTestId('display-column')).toHaveCount(6);
    await expect(page.getByTestId('display-page')).toHaveCount(0);
    const fontPx = await page.getByTestId('display-column').nth(1).getByTestId('now-calling').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fontPx).toBeGreaterThanOrEqual(120);
  });
});
