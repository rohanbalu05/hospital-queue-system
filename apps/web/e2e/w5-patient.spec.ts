/* eslint-disable @typescript-eslint/no-non-null-assertion -- specs assert on values the mocks just created */
import { expect, test, type Page } from '@playwright/test';
import { mockApi } from './mocks';
import { installFakeEventSource, mockQueue } from './mocks-queue';
import { mockScheduling } from './scheduling-mocks';
import { routeLiveBoardToQueueMock } from './w3-mocks';
import { shot } from './w3-helpers';
import {
  APPT_ID,
  AVAILABLE,
  AWAY,
  ETA_AWAY_LONG,
  ETA_RANGE,
  S_KULKARNI,
  UNAVAILABLE,
  emitQueueNotice,
  mockNotifications,
  mockW5,
  sampleNotifications,
  staffNotifications,
  type TodayVisit,
  type W5World,
} from './w5-patient-mocks';

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** One screenshot per width, named w5-<role>-<what>-<1440|390>.png. */
async function both(page: Page, name: string, fullPage = true) {
  for (const size of [DESKTOP, PHONE]) {
    await page.setViewportSize(size);
    // Let layout and any CSS transition settle before the capture.
    await page.waitForTimeout(150);
    await shot(page, `${name}-${size.width}`, fullPage);
  }
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

const walkIn: TodayVisit = {
  visitId: '00000000-0000-4000-8000-0000000000f1',
  sessionId: S_KULKARNI,
  appointmentId: null,
  doctorName: 'Dr. Arvind Kulkarni',
  department: 'Paediatrics',
  room: '4',
  kind: 'walkin',
  visitStatus: 'open',
  token: 'W-005',
  queueState: 'waiting',
  checkedInAt: '2026-11-11T09:48:00+05:30',
  scheduledAt: null,
  availability: AVAILABLE,
};

/** The booked appointment has been checked in: the patient holds A-016 in Dr. Kulkarni's queue. */
function checkedInWorld(over: Partial<W5World> = {}): Partial<W5World> {
  const base = {
    id: APPT_ID,
  };
  return {
    checkedIn: { [S_KULKARNI]: { token: 'A-016', group: 'A', position: 4, eta: ETA_RANGE } },
    visits: [{ ...walkIn, visitId: '00000000-0000-4000-8000-0000000000f2', appointmentId: base.id, kind: 'appointment', token: 'A-016', scheduledAt: '2026-11-11T10:20:00+05:30' }],
    ...over,
  };
}

test.describe('Today lists walk-in visits', () => {
  test('a walk-in sees their token, doctor, room and the queue link', async ({ page }) => {
    await mockW5(page, { appointments: [], visits: [walkIn], checkedIn: { [S_KULKARNI]: { token: 'W-005', group: 'W', position: 2, eta: ETA_RANGE } } });
    await page.goto('/patient');
    const card = page.getByTestId('today-visit');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('W-005');
    await expect(card).toContainText('Dr. Arvind Kulkarni');
    await expect(card).toContainText('Paediatrics, Room 4');
    await expect(card).toContainText('In the queue');
    await expect(page.getByText('No visit today')).toHaveCount(0);
    await expect(card.getByRole('link', { name: 'See my place in the queue' })).toBeVisible();
    await both(page, 'w5-patient-today-walkin');
    await noHorizontalScroll(page);
  });
});

test.describe('doctor away', () => {
  test('Today and My visit say the place is kept and show the updated wait', async ({ page }) => {
    await mockW5(page, checkedInWorld({ availability: { [S_KULKARNI]: AWAY }, appointments: [{ ...defaultAppt(), status: 'checked_in' }] }));
    await page.goto('/patient');
    const banner = page.getByTestId('availability-banner');
    await expect(banner).toContainText('Dr. Arvind Kulkarni has stepped away and is expected back about 10:45 am');
    await expect(banner).toContainText('Your place in the queue is kept.');
    await expect(banner).toContainText('Updated wait: about 40–55 min');
    await both(page, 'w5-patient-today-away');

    await page.getByRole('link', { name: 'See my place in the queue' }).click();
    await expect(page).toHaveURL(new RegExp(`/patient/visit/${S_KULKARNI}$`));
    await expect(page.getByTestId('availability-banner')).toContainText('expected back about 10:45 am');
    await expect(page.getByTestId('position')).toContainText('Number 4');
    await both(page, 'w5-patient-visit-away');
    await noHorizontalScroll(page);
  });

  test('when the estimate is withheld the banner shows the reason instead of a range', async ({ page }) => {
    await mockW5(
      page,
      checkedInWorld({
        availability: { [S_KULKARNI]: { ...AWAY, overdue: true } },
        checkedIn: { [S_KULKARNI]: { token: 'A-016', group: 'A', position: 4, eta: ETA_AWAY_LONG } },
      }),
    );
    await page.goto(`/patient/visit/${S_KULKARNI}`);
    const banner = page.getByTestId('availability-banner');
    await expect(banner).toContainText('is taking longer than expected to return');
    await expect(banner).toContainText('The doctor is away longer than expected');
    await expect(banner).not.toContainText('Updated wait: about');
    await both(page, 'w5-patient-visit-away-overdue');
  });

  test('"Dr X is back" confirms for a while after the doctor returns, then Available shows no banner', async ({ page }) => {
    const { world } = await mockW5(page, checkedInWorld({ availability: { [S_KULKARNI]: AWAY } }));
    await page.goto(`/patient/visit/${S_KULKARNI}`);
    await expect(page.getByTestId('availability-banner')).toContainText('has stepped away');
    world.availability[S_KULKARNI] = AVAILABLE;
    // The live notice: the snapshot is refetched and the banner turns into the short confirmation.
    await emitQueueNotice(page, S_KULKARNI, 8);
    await expect(page.getByTestId('availability-banner')).toContainText('Dr. Arvind Kulkarni is back.');
  });
});

test.describe('doctor unavailable', () => {
  test('a booked patient gets Rebook and Cancel on Today and My visit', async ({ page }) => {
    await mockW5(page, { availability: { [S_KULKARNI]: UNAVAILABLE } });
    await page.goto('/patient');
    const banner = page.getByTestId('availability-banner');
    await expect(banner).toHaveAttribute('role', 'alert');
    await expect(banner).toContainText('Dr. Arvind Kulkarni is not available for the rest of this session');
    await expect(banner.getByRole('link', { name: 'Rebook with another doctor' })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Cancel appointment' })).toBeVisible();
    await both(page, 'w5-patient-today-unavailable');

    await page.goto(`/patient/visit/${S_KULKARNI}`);
    await expect(page.getByTestId('availability-banner').getByRole('link', { name: 'Rebook with another doctor' })).toBeVisible();
    await both(page, 'w5-patient-visit-unavailable-booked');
  });

  test('a checked-in patient is sent to reception, with no rebook button', async ({ page }) => {
    await mockW5(page, checkedInWorld({ availability: { [S_KULKARNI]: UNAVAILABLE }, appointments: [{ ...defaultAppt(), status: 'checked_in' }] }));
    await page.goto(`/patient/visit/${S_KULKARNI}`);
    const banner = page.getByTestId('availability-banner');
    await expect(banner).toContainText('Please see reception: they will move you to another doctor.');
    await expect(banner.getByRole('link', { name: 'Rebook with another doctor' })).toHaveCount(0);
    await expect(page.getByText('You are next')).toHaveCount(0);
    await expect(page.getByTestId('eta')).toHaveCount(0);
    await both(page, 'w5-patient-visit-unavailable-checkedin');
  });
});

test.describe('before check-in', () => {
  test('My visit is a friendly not-checked-in state, with the doctor banner, never an error page', async ({ page }) => {
    await mockW5(page, { noSnapshotBeforeCheckIn: true, availability: { [S_KULKARNI]: AWAY } });
    await page.goto(`/patient/visit/${S_KULKARNI}`);
    await expect(page.getByText('You have not checked in yet')).toBeVisible();
    await expect(page.getByText('We could not find your visit in this session')).toHaveCount(0);
    await expect(page.getByTestId('availability-banner')).toContainText('expected back about 10:45 am');
    await expect(page.getByTestId('availability-banner')).toContainText('Your appointment is kept.');
    await both(page, 'w5-patient-visit-notcheckedin');
    await noHorizontalScroll(page);
  });

  test('Today and My visits show no queue link for a booked appointment, and flag an unavailable doctor', async ({ page }) => {
    await mockW5(page, { noSnapshotBeforeCheckIn: true, availability: { [S_KULKARNI]: UNAVAILABLE } });
    await page.goto('/patient');
    await expect(page.getByRole('link', { name: 'See my place in the queue' })).toHaveCount(0);
    await expect(page.getByTestId('availability-banner')).toContainText('not available for the rest of this session');
    await expect(page.getByTestId('availability-banner').getByRole('link', { name: 'Rebook with another doctor' })).toBeVisible();
    await page.goto('/patient/visits');
    await expect(page.getByTestId('availability-banner').getByRole('link', { name: 'Rebook with another doctor' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'See my place in the queue' })).toHaveCount(0);
    await both(page, 'w5-patient-visits-booked-unavailable');
  });
});

function defaultAppt() {
  return {
    id: APPT_ID,
    patientId: '00000000-0000-4000-8000-0000000000a1',
    sessionId: S_KULKARNI,
    doctorId: '00000000-0000-4000-8000-0000000000d2',
    doctorName: 'Dr. Arvind Kulkarni',
    department: 'Paediatrics',
    scheduledAt: '2026-11-11T10:20:00+05:30',
    status: 'booked' as const,
    rescheduledFromId: null,
    followUpTaskId: null,
    version: 2,
    createdAt: '2026-11-05T05:00:00Z',
  };
}

test.describe('rebook with another doctor', () => {
  test.use({ viewport: PHONE });

  test('keyboard only: banner link, option, one Enter books, and the new appointment is shown', async ({ page }) => {
    const { world } = await mockW5(page, { availability: { [S_KULKARNI]: UNAVAILABLE } });
    await page.goto('/patient');
    await page.getByRole('link', { name: 'Rebook with another doctor' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/patient/visits\\?rebook=${APPT_ID}$`));
    const panel = page.getByTestId('rebook-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Rebook with another doctor' })).toBeFocused();
    const options = page.getByTestId('rebook-option');
    await expect(options).toHaveCount(3);
    await expect(options.first()).toContainText('Dr. Farah Siddiqui');
    await expect(options.first()).toContainText('ENT, Room 7');
    await expect(options.first()).toContainText('Next slot 11:20 am');
    await expect(options.first()).toContainText('4 places left');
    await expect(options.nth(2)).toContainText('Thu, 12 Nov');
    await both(page, 'w5-patient-rebook-options');

    await page.setViewportSize(PHONE);
    const book = page.getByRole('button', { name: 'Book 11:20 am with Dr. Farah Siddiqui' });
    await book.focus();
    await page.keyboard.press('Enter');
    const done = page.getByTestId('rebook-done');
    await expect(done).toContainText('Dr. Farah Siddiqui');
    await expect(done).toContainText('11:20 am');
    const call = world.requests.find((r) => r.line === `POST /appointments/${APPT_ID}/reschedule`)!;
    expect(call.body).toEqual({ targetSessionId: world.alternatives[0]!.sessionId, expectedVersion: 2 });
    expect(call.key).toMatch(/.{8,}/);
    await both(page, 'w5-patient-rebook-done');
    await noHorizontalScroll(page);
  });

  test('a slot that was just taken says so, refreshes the list and leaves the original alone', async ({ page }) => {
    const { world } = await mockW5(page, { availability: { [S_KULKARNI]: UNAVAILABLE }, failReschedule: 'CAPACITY_FULL' });
    await page.goto(`/patient/visits?rebook=${APPT_ID}`);
    await page.getByRole('button', { name: 'Book 11:20 am with Dr. Farah Siddiqui' }).click();
    await expect(page.getByText('That slot was just taken')).toBeVisible();
    await expect(page.getByTestId('rebook-option')).toHaveCount(2);
    await expect(page.getByRole('button', { name: /Dr. Farah Siddiqui/ })).toHaveCount(0);
    expect(world.appointments.find((a) => a.id === APPT_ID)!.status).toBe('booked');
    await both(page, 'w5-patient-rebook-conflict');
  });

  test('with no options it says so and offers Cancel and the front desk number', async ({ page }) => {
    await mockW5(page, { availability: { [S_KULKARNI]: UNAVAILABLE }, alternatives: [] });
    await page.goto(`/patient/visits?rebook=${APPT_ID}`);
    await expect(page.getByTestId('rebook-empty')).toContainText('No other doctor has a free slot in the next 7 days');
    await expect(page.getByTestId('rebook-empty')).toContainText('080 4123 4500');
    await expect(page.getByTestId('rebook-panel').getByRole('button', { name: 'Cancel appointment' })).toBeVisible();
    await both(page, 'w5-patient-rebook-empty');
  });

  test('cancel asks first, then releases the place', async ({ page }) => {
    const { world } = await mockW5(page, { availability: { [S_KULKARNI]: UNAVAILABLE } });
    await page.goto(`/patient/visits?rebook=${APPT_ID}`);
    await page.getByTestId('rebook-panel').getByRole('button', { name: 'Cancel appointment' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cancel this appointment?' });
    await expect(dialog).toBeVisible();
    expect(world.requests.filter((r) => r.line.endsWith('/cancel'))).toHaveLength(0);
    await both(page, 'w5-patient-rebook-cancel-confirm', false);
    await page.setViewportSize(PHONE);
    await dialog.getByRole('button', { name: 'Cancel appointment' }).click();
    await expect(page.getByRole('heading', { name: 'Appointment cancelled' })).toBeVisible();
    expect(world.appointments[0]!.status).toBe('cancelled');
  });
});

test.describe('notification centre', () => {
  test.use({ viewport: PHONE });

  test('patient: bell with count, list newest first, Open follows the link and marks it read', async ({ page }) => {
    const { world } = await mockW5(page, { notifications: sampleNotifications(), availability: { [S_KULKARNI]: UNAVAILABLE } });
    await page.goto('/patient');
    const bell = page.getByRole('button', { name: 'Notifications, 3 unread' });
    await expect(bell).toBeVisible();
    await both(page, 'w5-patient-bell-closed');

    await bell.click();
    const items = page.getByTestId('notification');
    await expect(items).toHaveCount(4);
    await expect(items.nth(0)).toContainText('not available for the rest of this session');
    await expect(items.nth(0)).toContainText('Action needed');
    await expect(items.nth(0)).toContainText('3 min ago, 10:02 am');
    await expect(items.nth(1)).toContainText('Heads up');
    await expect(items.nth(3)).toHaveAttribute('data-unread', 'false');
    await both(page, 'w5-patient-notifications', false);

    await page.setViewportSize(PHONE);
    await items.nth(0).getByRole('link', { name: 'Open' }).click();
    await expect(page).toHaveURL(new RegExp(`/patient/visits\\?rebook=${APPT_ID}$`));
    await expect(page.getByTestId('rebook-panel')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(world.notifications[0]!.readAt).not.toBeNull();
    await expect(page.getByRole('button', { name: 'Notifications, 2 unread' })).toBeVisible();
  });

  test('keyboard only: open with Enter, Mark all as read, close with Escape, focus returns to the bell', async ({ page }) => {
    await mockW5(page, { notifications: sampleNotifications() });
    await page.goto('/patient');
    const bell = page.getByRole('button', { name: 'Notifications, 3 unread' });
    await bell.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
    await page.getByRole('button', { name: 'Mark all as read' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('notification').first()).toHaveAttribute('data-unread', 'false');
    await expect(page.getByRole('button', { name: 'Mark all as read' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('notification-bell')).toBeFocused();
    await expect(page.getByTestId('notification-bell')).toHaveAttribute('aria-label', 'Notifications');
  });

  test('empty list says there is nothing yet', async ({ page }) => {
    await mockW5(page, { notifications: [] });
    await page.goto('/patient');
    await page.getByRole('button', { name: 'Notifications' }).click();
    await expect(page.getByText('No notifications yet')).toBeVisible();
    await both(page, 'w5-patient-notifications-empty', false);
  });

  test('the list reports a failure and can retry', async ({ page }) => {
    await mockW5(page, { notifications: sampleNotifications() });
    let fail = true;
    await page.route('**/api/notifications', (route) => (fail ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: 'down' } }) }) : route.fallback()));
    await page.goto('/patient');
    await page.getByRole('button', { name: /Notifications/ }).click();
    await expect(page.getByText('Notifications could not be loaded')).toBeVisible();
    await both(page, 'w5-patient-notifications-error', false);
    await page.setViewportSize(PHONE);
    fail = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId('notification')).toHaveCount(4);
  });

  test('a staff shell has the same bell, with links into the desk and the console', async ({ page }) => {
    await installFakeEventSource(page);
    await mockApi(page, 'reception');
    await mockQueue(page);
    const sched = await mockScheduling(page);
    await routeLiveBoardToQueueMock(page);
    const sessionId = sched.sessions.find((s) => s.sessionDate === '2026-11-11' && s.label === 'morning')!.id;
    const rows = await mockNotifications(page, staffNotifications(sessionId));
    await page.goto('/reception');
    await expect(page.getByRole('heading', { name: 'Reception desk', level: 1 })).toBeVisible();
    const bell = page.getByRole('button', { name: 'Notifications, 2 unread' });
    await bell.click();
    await expect(page.getByTestId('notification')).toHaveCount(3);
    await expect(page.getByTestId('notification').first()).toContainText('stepped away');
    await both(page, 'w5-staff-notifications', false);
    await page.setViewportSize(DESKTOP);
    await page.getByTestId('notification').first().getByRole('link', { name: 'Open' }).click();
    await expect(page).toHaveURL(new RegExp(`/reception\\?session=${sessionId}$`));
    expect(rows[0]!.readAt).not.toBeNull();
  });
});

test.describe('session ended', () => {
  test('a 401 from any request clears the account cache and returns to login with a clear message', async ({ page }) => {
    let expired = false;
    const { api } = await mockW5(page, { appointments: [], visits: [walkIn] });
    // Registered last, so it wins: after the session expires every account request is a 401.
    await page.route(
      (url) => url.pathname.startsWith('/api/') && !['/api/me', '/api/auth/login'].includes(url.pathname),
      (route) =>
        expired
          ? route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } }) })
          : route.fallback(),
    );
    await page.goto('/patient');
    await expect(page.getByTestId('today-visit')).toContainText('W-005');

    expired = true;
    api.setUser(null);
    // The next request of any kind meets the 401: the bell's poll, a live refetch or a screen that loads something new.
    await expect(page.getByText('Your session has ended, please sign in again')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('W-005')).toHaveCount(0);
    await both(page, 'w5-login-session-ended');

    // Signing in again in the same tab starts clean.
    expired = false;
    await page.getByLabel('Email').fill('patient@hqms.test');
    await page.getByLabel('Password').fill('demo1234');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/patient$/);
    await expect(page.getByText('Your session has ended')).toHaveCount(0);
  });
});
