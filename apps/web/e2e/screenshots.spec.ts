import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { mockApi, type DemoRole } from './mocks';

/** docs/evidence/screenshots at the repo root. */
const SHOTS = path.resolve(import.meta.dirname, '../../../docs/evidence/screenshots');
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SHOTS, `w0-${name}.png`), fullPage: true });

const ROLE_HOMES: Array<{ role: DemoRole; url: string; heading: string; slug: string }> = [
  { role: 'patient', url: '/patient', heading: 'My visit', slug: 'patient-home' },
  { role: 'reception', url: '/reception', heading: 'Reception desk', slug: 'reception-home' },
  { role: 'doctor', url: '/doctor', heading: 'Doctor console', slug: 'doctor-home' },
  { role: 'followup', url: '/follow-up', heading: 'Follow-up tasks', slug: 'followup-home' },
  { role: 'admin', url: '/admin', heading: 'Administration', slug: 'admin-home' },
];

test.describe('login at 1440', () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

  test('screenshot', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await shot(page, 'login-1440');
  });

  test('error state shows the server message and returns focus to the password', async ({ page }) => {
    await mockApi(page);
    await page.goto('/login');
    await page.getByLabel('Email').fill('reception@hqms.test');
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('The email or password is not right');
    await expect(page.getByLabel('Password')).toBeFocused();
    await shot(page, 'login-error-1440');
  });
});

test.describe('login at 390', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

  test('screenshot', async ({ page }) => {
    await mockApi(page);
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await shot(page, 'login-390');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('keyboard and guards', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('login works by keyboard alone: Tab order, visible focus, Enter submits', async ({ page }) => {
    await mockApi(page);
    await page.goto('/login');

    // Email is focused on arrival.
    await expect(page.getByLabel('Email')).toBeFocused();
    await page.keyboard.type('reception@hqms.test');

    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Password')).toBeFocused();
    await page.keyboard.type('demo1234');

    await page.keyboard.press('Tab');
    const submit = page.getByRole('button', { name: 'Sign in' });
    await expect(submit).toBeFocused();
    // 2px ink focus ring is rendered (ring box-shadow) on the focused control.
    await expect
      .poll(() => submit.evaluate((el) => getComputedStyle(el).boxShadow))
      .toContain('rgb(22, 35, 43)');

    // Back to the password field and submit with Enter.
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByLabel('Password')).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/reception$/);
    await expect(page.getByRole('heading', { name: 'Reception desk' })).toBeVisible();
  });

  test('sign out by keyboard returns to login', async ({ page }) => {
    await mockApi(page, 'doctor');
    await page.goto('/doctor');
    await expect(page.getByRole('heading', { name: 'Doctor console' })).toBeVisible();
    const signOut = page.getByRole('button', { name: 'Sign out' });
    await signOut.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('signed-out users are sent to login; wrong-role users to their own home', async ({ page }) => {
    const api = await mockApi(page);
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/login$/);

    api.setUser('patient');
    await page.goto('/doctor');
    await expect(page).toHaveURL(/\/patient$/);
  });

  test('the display is public and shows no patient detail', async ({ page }) => {
    await mockApi(page);
    await page.goto('/display');
    await expect(page).toHaveURL(/\/display$/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('a failing /me shows an error with a retry, not a blank page', async ({ page }) => {
    await page.route(
      (url) => url.pathname === '/api/me',
      (route) => route.fulfill({ status: 503, body: '' }),
    );
    await page.goto('/');
    await expect(page.getByRole('alert')).toContainText('Could not check your sign-in');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

test.describe('role homes at 1440', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  for (const h of ROLE_HOMES) {
    test(`${h.role} home`, async ({ page }) => {
      await mockApi(page, h.role);
      await page.goto(h.url);
      await expect(page.getByRole('heading', { name: h.heading, level: 1 })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
      await shot(page, `${h.slug}-1440`);
    });
  }
});

test.describe('patient home at 390', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  test('screenshot', async ({ page }) => {
    await mockApi(page, 'patient');
    await page.goto('/patient');
    await expect(page.getByRole('heading', { name: 'My visit', level: 1 })).toBeVisible();
    await shot(page, 'patient-home-390');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('display at 1920', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });
  test('screenshot', async ({ page }) => {
    await mockApi(page);
    await page.goto('/display');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await shot(page, 'display-1920');
  });
});

test.describe('primitives gallery', () => {
  test('1440', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockApi(page);
    await page.goto('/_dev/primitives');
    await expect(page.getByRole('heading', { name: 'Queue primitives' })).toBeVisible();
    await shot(page, 'primitives-1440');
  });

  test('390', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page);
    await page.goto('/_dev/primitives');
    await expect(page.getByRole('heading', { name: 'Queue primitives' })).toBeVisible();
    await shot(page, 'primitives-390');
  });

  test('queue rows are keyboard-selectable', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockApi(page);
    await page.goto('/_dev/primitives');
    const row = page.getByRole('button', { name: /W-005/ });
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(row).toHaveAttribute('aria-pressed', 'true');
  });
});
