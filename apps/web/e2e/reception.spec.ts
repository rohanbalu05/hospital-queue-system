/* eslint-disable @typescript-eslint/no-non-null-assertion -- specs assert on values they just created */
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { installFakeEventSource, mockQueue } from './mocks-queue';
import { routeLiveBoardToQueueMock } from './w3-mocks';
import { mockApi, mockScheduling, type SchedulingMock, type SchedulingOptions } from './mocks';

const SHOTS = path.resolve(import.meta.dirname, '../../../docs/evidence/screenshots');
const shot = (page: Page, name: string, fullPage = true) => page.screenshot({ path: path.join(SHOTS, `w1-${name}.png`), fullPage, animations: 'disabled' });

async function setup(page: Page, options: SchedulingOptions = {}): Promise<SchedulingMock> {
  // The desk also mounts the live queue board: answer its snapshot and stream from the queue mock.
  await installFakeEventSource(page);
  await mockApi(page, 'reception');
  await mockQueue(page);
  const sched = await mockScheduling(page, options);
  await routeLiveBoardToQueueMock(page);
  return sched;
}

async function ready(page: Page) {
  await expect(page.getByRole('heading', { name: 'Reception desk', level: 1 })).toBeVisible();
  await expect(page.getByRole('listbox', { name: 'Arrivals' })).toBeVisible();
}

test.describe('reception desk at 1440', () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

  test('three columns with the session board', async ({ page }) => {
    await setup(page);
    await page.goto('/reception');
    await ready(page);
    // Search left, board centre, actions right.
    const left = await page.getByRole('region', { name: 'Find arrivals' }).boundingBox();
    const mid = await page.getByRole('region', { name: 'Session board' }).boundingBox();
    const right = await page.getByRole('region', { name: 'Actions' }).boundingBox();
    expect(left!.x).toBeLessThan(mid!.x);
    expect(mid!.x).toBeLessThan(right!.x);

    // Capacity bar: booked x/10 and walk-in y/5 in text.
    const board = page.getByRole('region', { name: 'Session board' });
    await expect(board).toContainText('Dr. Meenakshi Rao');
    await expect(board.getByText('Booked', { exact: true }).first().locator('..')).toContainText('8/10');
    await expect(board.getByText('Walk-in', { exact: true }).first().locator('..')).toContainText('0/5');
    // Lanes by status.
    await expect(board.getByRole('heading', { name: 'Expected' })).toBeVisible();
    await expect(board.getByRole('heading', { name: 'Checked in' })).toBeVisible();
    await expect(board.getByRole('heading', { name: 'Missed or cancelled' })).toBeVisible();
    await shot(page, 'reception-desk-1440');
  });

  test('doctor and session pickers are limited to assigned doctors', async ({ page }) => {
    await setup(page);
    await page.goto('/reception');
    await ready(page);
    await page.getByRole('combobox', { name: 'Doctor' }).click();
    await expect(page.getByRole('option')).toHaveCount(1);
    await expect(page.getByRole('option', { name: /Dr\. Meenakshi Rao/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tab', { name: /Morning/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Afternoon/ })).toBeVisible();
  });

  test('late arrival: dialog, then admit as late arrival (W token, walk-in order)', async ({ page }) => {
    const api = await setup(page);
    await page.goto('/reception');
    await ready(page);

    // Gopal Krishnan (9:35 am) is the first expected arrival and is 30 min late.
    await expect(page.getByRole('option', { name: /Gopal Krishnan/ })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: 'Check in', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Arrived 30 min late' })).toBeVisible();
    await expect(dialog).toContainText('after the 15 min grace');
    await expect(dialog).toContainText('Admitting uses a walk-in place and walk-in order.');
    await expect(dialog.getByRole('button', { name: 'Not now' })).toBeFocused();
    await shot(page, 'reception-late-dialog-1440', false);

    await dialog.getByRole('button', { name: 'Admit as late arrival' }).click();
    const outcome = page.getByTestId('arrival-outcome');
    await expect(outcome).toContainText('Checked in');
    await expect(outcome).toContainText('W-001');
    await expect(outcome).toContainText('Late arrival, walk-in order');
    await expect(page.getByRole('region', { name: 'Session board' }).getByText('Walk-in', { exact: true }).first().locator('..')).toContainText('1/5');
    await shot(page, 'reception-late-admitted-1440');

    // The retry used a new Idempotency-Key and admitLate: true.
    const posts = api.requests.filter((r) => r.line.endsWith('/check-in'));
    expect(posts).toHaveLength(2);
    expect(posts[0]!.key).not.toBe(posts[1]!.key);
    expect(posts[1]!.body).toEqual({ admitLate: true });
  });

  test('"Not now" leaves the arrival untouched', async ({ page }) => {
    const api = await setup(page);
    await page.goto('/reception');
    await ready(page);
    await page.getByRole('button', { name: 'Check in', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Not now' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByRole('combobox', { name: 'Find an arrival' })).toBeFocused();
    expect(api.requests.filter((r) => r.line.endsWith('/check-in'))).toHaveLength(1);
  });

  test('on-time check-in shows the token big with its group tag', async ({ page }) => {
    await setup(page);
    await page.goto('/reception');
    await ready(page);
    await page.getByRole('option', { name: /Sneha Kulkarni/ }).click();
    await page.getByRole('button', { name: 'Check in', exact: true }).click();
    const outcome = page.getByTestId('arrival-outcome');
    await expect(outcome).toContainText('A-003');
    await expect(outcome).toContainText('Appointment');
    const size = await outcome.locator('[data-token]').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(64);
    await shot(page, 'reception-checked-in-1440');
  });

  test('walk-in: search a patient and admit', async ({ page }) => {
    await setup(page);
    await page.goto('/reception');
    await ready(page);
    await page.getByRole('combobox', { name: 'Find an arrival' }).fill('nandini');
    await expect(page.getByRole('option', { name: /Nandini Reddy/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /Nandini Reddy/ })).toContainText('No appointment');
    await shot(page, 'reception-search-1440');
    await page.getByRole('button', { name: 'Admit walk-in: Nandini Reddy' }).click();
    await expect(page.getByTestId('arrival-outcome')).toContainText('W-001');
    await expect(page.getByTestId('arrival-outcome')).toContainText('Admitted');
  });

  test('walk-in: register a new patient then admit', async ({ page }) => {
    const api = await setup(page);
    await page.goto('/reception');
    await ready(page);
    await page.getByRole('button', { name: 'Register new patient' }).click();
    await page.getByLabel('Full name').fill('Pradeep Bhat');
    await page.getByLabel('Phone (optional)').fill('+91 98860 12345');
    await shot(page, 'reception-register-1440');
    await page.getByRole('button', { name: 'Register and admit walk-in' }).click();
    await expect(page.getByTestId('arrival-outcome')).toContainText('Pradeep Bhat');
    await expect(page.getByTestId('arrival-outcome')).toContainText('W-001');
    expect(api.requests.map((r) => r.line)).toEqual(expect.arrayContaining(['POST /patients', expect.stringMatching(/POST \/sessions\/.+\/walk-ins/)]));
  });

  test('registration validates before sending', async ({ page }) => {
    const api = await setup(page);
    await page.goto('/reception');
    await ready(page);
    await page.getByRole('button', { name: 'Register new patient' }).click();
    await page.getByLabel('Full name').fill('P');
    await page.getByRole('button', { name: 'Register and admit walk-in' }).click();
    await expect(page.getByText('Enter the full name, at least 2 letters.')).toBeVisible();
    expect(api.requests.filter((r) => r.line === 'POST /patients')).toHaveLength(0);
  });

  test('capacity full: walk-in places taken', async ({ page }) => {
    await setup(page, { walkinFull: true });
    await page.goto('/reception');
    await ready(page);
    await page.getByRole('combobox', { name: 'Find an arrival' }).fill('nandini');
    await expect(page.getByRole('option', { name: /Nandini Reddy/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Admit walk-in: Nandini Reddy' })).toBeDisabled();
    await expect(page.getByText('Walk-in places are full for this session.')).toBeVisible();
    await shot(page, 'reception-capacity-full-1440');
  });

  test('capacity full returned by the server shows an explicit error', async ({ page }) => {
    const api = await setup(page);
    await page.goto('/reception');
    await ready(page);
    await page.getByRole('combobox', { name: 'Find an arrival' }).fill('nandini');
    api.failNext['walk-in'] = 'capacity';
    await page.getByRole('button', { name: 'Admit walk-in: Nandini Reddy' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('No places left');
    await expect(alert).toContainText('Nobody was admitted.');
    await shot(page, 'reception-capacity-error-1440');
  });

  test('empty session, loading and error states', async ({ page }) => {
    const api = await setup(page, { emptyToday: true });
    api.delayAppointmentsMs = 1500;
    await page.goto('/reception');
    await expect(page.getByLabel('Loading').first()).toBeVisible();
    await shot(page, 'reception-loading-1440', false);
    await expect(page.getByText('No appointments in this session yet.')).toBeVisible();
    await shot(page, 'reception-empty-1440');

    await page.route(
      (url) => url.pathname === '/api/appointments',
      (route) => route.fulfill({ status: 503, body: '' }),
    );
    await page.goto('/reception');
    await expect(page.getByRole('alert').first()).toContainText('could not be loaded', { timeout: 15_000 });
    await shot(page, 'reception-error-1440');
  });
});

test.describe('reception desk keyboard only (NFR-08-b)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('"/" focuses search; type, arrow and Enter check in', async ({ page }) => {
    const api = await setup(page);
    await page.goto('/reception');
    await ready(page);

    await page.keyboard.press('/');
    const search = page.getByRole('combobox', { name: 'Find an arrival' });
    await expect(search).toBeFocused();
    // The "/" itself is not typed into the box.
    await expect(search).toHaveValue('');
    await expect.poll(() => search.evaluate((el) => getComputedStyle(el).outlineColor)).toBe('rgb(22, 35, 43)');

    await page.keyboard.type('z');
    await page.keyboard.type('q'); // "zq" is in no name: empty state
    await expect(page.getByText(/No patient matches/)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(search).toHaveValue('');

    await page.keyboard.type('ro'); // Rohan Deshpande, plus others containing "ro"
    const rohan = page.getByRole('option', { name: /Rohan Deshpande/ });
    await expect(rohan).toBeVisible();
    // Arrow keys move the selection through the matches until Rohan is selected.
    for (let i = 0; i < 6 && (await rohan.getAttribute('aria-selected')) !== 'true'; i++) await page.keyboard.press('ArrowDown');
    await expect(rohan).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('arrival-outcome')).toContainText('Rohan Deshpande');
    await expect(page.getByTestId('arrival-outcome')).toContainText('A-003');
    // Focus is back in the empty search box, ready for the next arrival.
    await expect(search).toBeFocused();
    await expect(search).toHaveValue('');
    expect(api.requests.filter((r) => r.line.endsWith('/check-in'))).toHaveLength(1);
  });

  test('late arrival dialog by keyboard: Not now is focused, Tab then Enter admits', async ({ page }) => {
    await setup(page);
    await page.goto('/reception');
    await ready(page);
    await page.keyboard.press('/');
    await page.keyboard.type('gopal');
    await expect(page.getByRole('option', { name: /Gopal Krishnan/ })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Not now' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Admit as late arrival' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('arrival-outcome')).toContainText('W-001');
  });
});

test.describe('reception desk at 390', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

  test('degrades to one column without horizontal scroll', async ({ page }) => {
    await setup(page);
    await page.goto('/reception');
    await ready(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await shot(page, 'reception-desk-390');

    await page.getByRole('option', { name: /Sneha Kulkarni/ }).click();
    await page.getByRole('button', { name: 'Check in', exact: true }).click();
    await expect(page.getByTestId('arrival-outcome')).toContainText('A-003');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await shot(page, 'reception-checked-in-390');
  });
});
