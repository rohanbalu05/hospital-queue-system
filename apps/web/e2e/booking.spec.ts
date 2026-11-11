/* eslint-disable @typescript-eslint/no-non-null-assertion -- specs assert on values they just created */
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockApi, mockScheduling, type SchedulingMock } from './mocks';

const SHOTS = path.resolve(import.meta.dirname, '../../../docs/evidence/screenshots');
const shot = (page: Page, name: string, fullPage = true) => page.screenshot({ path: path.join(SHOTS, `w1-${name}.png`), fullPage });
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

async function setup(page: Page): Promise<SchedulingMock> {
  await mockApi(page, 'patient');
  return mockScheduling(page);
}

/** Press Tab until `target` has focus (keyboard-only navigation). */
async function tabTo(page: Page, target: Locator, max = 25) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

/** In a radio group: Tab in, then ArrowDown until the named option is chosen. */
async function chooseByArrows(page: Page, group: string, option: RegExp | string) {
  const radios = page.getByRole('radiogroup', { name: group }).getByRole('radio');
  await tabTo(page, radios.first());
  const target = page.getByRole('radiogroup', { name: group }).getByRole('radio', { name: option });
  for (let i = 0; i < 10; i++) {
    if ((await target.getAttribute('aria-checked')) === 'true') return;
    const focused = await target.evaluate((el) => el === document.activeElement);
    await page.keyboard.press(focused ? 'Space' : 'ArrowDown');
  }
  await expect(target).toBeChecked();
}

test.describe('patient booking at 390', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

  test('steps and screenshots', async ({ page }) => {
    await setup(page);
    await page.goto('/patient/book');
    await expect(page.getByRole('heading', { name: 'Choose a department' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'General Medicine' })).toBeVisible();
    await shot(page, 'book-department-390');
    await noOverflow(page);

    await page.getByRole('radio', { name: 'General Medicine' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Choose a doctor' })).toBeVisible();
    await expect(page.getByRole('radio', { name: /Dr\. Meenakshi Rao/ })).toBeVisible();
    await shot(page, 'book-doctor-390');

    await page.getByRole('radio', { name: /Dr\. Meenakshi Rao/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Choose a day' })).toBeVisible();
    await expect(page.getByRole('radio', { name: /Thu, 12 Nov/ })).toBeVisible();
    await expect(page.getByRole('radio', { name: /Sat, 14 Nov/ })).toBeDisabled();
    await shot(page, 'book-date-390');
    await noOverflow(page);

    await page.getByRole('radio', { name: /Thu, 12 Nov/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Choose a session' })).toBeVisible();
    await expect(page.getByRole('radio', { name: /Morning.*Full, 0 of 10 places left/ })).toBeDisabled();
    await expect(page.getByRole('radio', { name: /Afternoon.*of 10 places left/ })).toBeEnabled();
    await shot(page, 'book-session-390');

    await page.getByRole('radio', { name: /Afternoon/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Check and book' })).toBeVisible();
    await expect(page.getByText('Room')).toBeVisible();
    await expect(page.getByText('2:00 pm to 5:00 pm')).toBeVisible();
    await expect(page.getByText('2:00 pm', { exact: true })).toBeVisible();
    await shot(page, 'book-confirm-390');
    await noOverflow(page);

    await page.getByRole('button', { name: 'Book appointment' }).click();
    await expect(page).toHaveURL(/\/patient\/visits$/);
    await expect(page.getByText('Booked', { exact: true }).first()).toBeVisible();
    await shot(page, 'visits-after-booking-390');
  });

  test('capacity full on confirm: clear message and a way out', async ({ page }) => {
    const api = await setup(page);
    await page.goto('/patient/book');
    await page.getByRole('radio', { name: 'General Medicine' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('radio', { name: /Dr\. Meenakshi Rao/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('radio', { name: /Thu, 12 Nov/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('radio', { name: /Afternoon/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();

    api.failNext.book = 'capacity';
    await page.getByRole('button', { name: 'Book appointment' }).click();
    await expect(page.getByRole('alert')).toContainText('This session just filled up');
    await shot(page, 'book-capacity-full-390');
    await noOverflow(page);

    await page.getByRole('button', { name: 'Choose another session' }).click();
    await expect(page.getByRole('heading', { name: 'Choose a session' })).toBeVisible();
    // Nothing was booked.
    expect(api.appointments.filter((a) => a.patientId === '00000000-0000-4000-8000-0000000000a1' && a.status === 'booked')).toHaveLength(2);
  });

  test('a retry after a network error reuses the Idempotency-Key and books once', async ({ page }) => {
    const api = await setup(page);
    await page.goto('/patient/book');
    await page.getByRole('radio', { name: 'General Medicine' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('radio', { name: /Dr\. Meenakshi Rao/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('radio', { name: /Thu, 12 Nov/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('radio', { name: /Afternoon/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();

    api.failNext.book = 'network';
    await page.getByRole('button', { name: 'Book appointment' }).click();
    await expect(page.getByRole('alert')).toContainText('You will not be booked twice');
    await page.getByRole('button', { name: 'Book appointment' }).click();
    await expect(page).toHaveURL(/\/patient\/visits$/);

    const posts = api.requests.filter((r) => r.line === 'POST /appointments');
    expect(posts).toHaveLength(2);
    expect(posts[0]!.key).toBeTruthy();
    expect(posts[1]!.key).toBe(posts[0]!.key);
  });

  test('loading and error states on the first step', async ({ page }) => {
    await mockApi(page, 'patient');
    await page.route(
      (url) => url.pathname === '/api/doctors',
      async (route) => {
        await new Promise((r) => setTimeout(r, 1200));
        await route.fulfill({ status: 503, body: '' });
      },
    );
    await page.goto('/patient/book');
    await expect(page.getByLabel('Loading')).toBeVisible();
    await shot(page, 'book-loading-390', false);
    await expect(page.getByRole('alert')).toContainText('Departments could not be loaded', { timeout: 15_000 });
    await shot(page, 'book-error-390', false);
  });
});

test.describe('patient booking at 1440', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test('confirm screen', async ({ page }) => {
    await setup(page);
    await page.goto('/patient/book');
    await page.getByRole('radio', { name: 'Orthopaedics' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('radio', { name: /Dr\. Suresh Gowda/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('radio', { name: /Thu, 12 Nov/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('radio', { name: /Morning/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Check and book' })).toBeVisible();
    await shot(page, 'book-confirm-1440');
  });
});

test.describe('keyboard only (NFR-08-b, booking)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('book an appointment with Tab, arrows, Space and Enter only', async ({ page }) => {
    const api = await setup(page);
    await page.goto('/patient/book');
    await expect(page.getByRole('heading', { name: 'Choose a department' })).toBeVisible();

    // Department: arrows choose, Enter continues.
    await chooseByArrows(page, 'Department', 'General Medicine');
    await expect(page.getByRole('radio', { name: 'General Medicine' })).toBeFocused();
    // A visible 2px ink focus ring is on the focused radio.
    await expect.poll(() => page.getByRole('radio', { name: 'General Medicine' }).evaluate((el) => getComputedStyle(el).boxShadow)).toContain('rgb(22, 35, 43)');
    await page.keyboard.press('Enter');

    // Doctor: focus moved to the step heading; Tab enters the group.
    await expect(page.getByRole('heading', { name: 'Choose a doctor' })).toBeFocused();
    await chooseByArrows(page, 'Doctor', /Dr\. Meenakshi Rao/);
    await page.keyboard.press('Enter');

    // Day: Space chooses the focused option, then Tab to Continue and Enter.
    await expect(page.getByRole('heading', { name: 'Choose a day' })).toBeFocused();
    await chooseByArrows(page, 'Day', /Thu, 12 Nov/);
    await tabTo(page, page.getByRole('button', { name: 'Continue' }));
    await page.keyboard.press('Enter');

    // Session: the full morning session is skipped by the arrow keys.
    await expect(page.getByRole('heading', { name: 'Choose a session' })).toBeFocused();
    await tabTo(page, page.getByRole('radiogroup', { name: 'Session' }).getByRole('radio', { name: /Afternoon/ }));
    await page.keyboard.press('Space');
    await expect(page.getByRole('radio', { name: /Afternoon/ })).toBeChecked();
    await page.keyboard.press('Enter');

    // Confirm: Tab to the button and press Enter.
    await expect(page.getByRole('heading', { name: 'Check and book' })).toBeFocused();
    const book = page.getByRole('button', { name: 'Book appointment' });
    await tabTo(page, book);
    await expect.poll(() => book.evaluate((el) => getComputedStyle(el).boxShadow)).toContain('rgb(22, 35, 43)');
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/patient\/visits$/);
    expect(api.requests.filter((r) => r.line === 'POST /appointments')).toHaveLength(1);
  });
});

test.describe('my visits', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

  test('upcoming, past collapsed, cancel and reschedule', async ({ page }) => {
    const api = await setup(page);
    await page.goto('/patient/visits');
    await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible();
    await expect(page.getByText('Thu, 12 Nov, 2:40 pm')).toBeVisible();
    await expect(page.getByText('Completed')).toBeHidden(); // past is collapsed
    await shot(page, 'visits-390');
    await noOverflow(page);

    await page.getByRole('button', { name: /Past and cancelled/ }).click();
    await expect(page.getByText('Completed')).toBeVisible();
    await expect(page.getByText('Cancelled').first()).toBeVisible();
    await shot(page, 'visits-past-open-390');

    // Reschedule
    await page.getByRole('button', { name: 'Reschedule' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Choose another session' })).toBeVisible();
    await expect(dialog.getByRole('radio').first()).toBeVisible();
    await shot(page, 'visits-reschedule-390', false);

    // Target is full at the moment of confirming: the original stays.
    api.failNext.reschedule = 'capacity';
    await dialog.getByRole('radio').first().click();
    await dialog.getByRole('button', { name: 'Move appointment' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Your original appointment is unchanged');
    await shot(page, 'visits-reschedule-full-390', false);
    await dialog.getByRole('button', { name: 'Keep current time' }).click();
    await expect(page.getByText('Thu, 12 Nov, 2:40 pm')).toBeVisible();

    // Cancel
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
    const confirm = page.getByRole('dialog');
    await expect(confirm).toContainText('Your place is released');
    await shot(page, 'visits-cancel-390', false);
    await confirm.getByRole('button', { name: 'Cancel appointment' }).click();
    await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();
    expect(api.requests.some((r) => r.line.endsWith('/cancel'))).toBe(true);
  });

  test('empty state and error state', async ({ page }) => {
    const api = await setup(page);
    api.appointments.length = 0;
    await page.goto('/patient/visits');
    await expect(page.getByText('No upcoming appointments')).toBeVisible();
    await shot(page, 'visits-empty-390');

    await page.route(
      (url) => url.pathname === '/api/appointments',
      (route) => route.fulfill({ status: 503, body: '' }),
    );
    await page.goto('/patient/visits');
    await expect(page.getByRole('alert')).toContainText('Your appointments could not be loaded', { timeout: 15_000 });
    await shot(page, 'visits-error-390');
  });
});
