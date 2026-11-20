/* eslint-disable @typescript-eslint/no-non-null-assertion -- specs assert on values the mocks just created */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockApi } from './mocks';
import { SESSION_ID, installFakeEventSource, mockQueue } from './mocks-queue';
import { mockScheduling } from './scheduling-mocks';
import { shot } from './w3-helpers';
import { ALT_BHAT, setupDesk } from './w6-desk-mocks';

/**
 * Session 3 desk screens: reception patient desk (book, cancel, reschedule), duplicate warning, other doctors when walk-ins
 * are full, late markers, absent confirmation; doctor follow-up and skip confirmation; patient offline banner.
 * Mocked API, clock fixed at 10:05 am IST on Wed 11 Nov 2026. Screenshots at 1440 and 390.
 */

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;

/** Toasts are transient; keep them out of the evidence screenshots. */
async function hideToasts(page: Page): Promise<void> {
  await page.addStyleTag({ content: '[data-sonner-toaster]{display:none !important}' });
}

/** Press Tab until `target` has focus, so the spec only ever uses the keyboard. */
async function tabTo(page: Page, target: Locator, limit = 80): Promise<void> {
  for (let i = 0; i < limit; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Tab never reached the target');
}

async function findArrival(page: Page, text: string, optionName: RegExp) {
  await page.goto('/reception');
  await hideToasts(page);
  await expect(page.getByRole('heading', { name: 'Reception desk', level: 1 })).toBeVisible();
  const search = page.getByRole('combobox', { name: 'Find an arrival' });
  await search.fill(text);
  await expect(page.getByRole('option', { name: optionName })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open patient desk' })).toBeEnabled();
}

async function openDesk(page: Page, text: string, optionName: RegExp) {
  await findArrival(page, text, optionName);
  await page.getByRole('button', { name: 'Open patient desk' }).click();
  return page.getByRole('dialog', { name: new RegExp(text) });
}

for (const vp of VIEWPORTS) {
  test.describe(`reception patient desk at ${vp.width}`, () => {
    test.use({ viewport: vp, deviceScaleFactor: 1 });

    test('lists upcoming appointments; reschedule shows the slot it will get; cancel asks first', async ({ page }) => {
      const { sched } = await setupDesk(page, 'reception');
      const desk = await openDesk(page, 'Ananya', /Ananya Iyer/);
      await expect(desk.getByRole('heading', { name: 'Upcoming appointments' })).toBeVisible();
      const rows = desk.getByRole('listitem');
      await expect(rows).toHaveCount(2);
      await expect(rows.first()).toContainText('Dr. Meenakshi Rao');
      await shot(page, `w6-reception-patient-desk-${vp.width}`, false);

      // Reschedule: same department, with the slot shown before confirming.
      await desk.getByRole('button', { name: /^Reschedule appointment with Dr. Meenakshi Rao/ }).click();
      await expect(desk.getByRole('heading', { name: 'Reschedule appointment' })).toBeFocused();
      await desk.getByRole('radio', { name: /Today, Afternoon/ }).check();
      await expect(desk.getByTestId('slot-summary')).toContainText('Next free slot: 2:00 pm');
      await shot(page, `w6-reception-reschedule-${vp.width}`, false);
      await desk.getByRole('button', { name: 'Reschedule' }).click();
      await expect(desk.getByRole('heading', { name: 'Upcoming appointments' })).toBeVisible();
      expect(sched.requests.some((r) => r.line.endsWith('/reschedule') && r.key)).toBe(true);

      // Cancel: confirmation with an optional reason; nothing is sent before it.
      await desk.getByRole('button', { name: /^Cancel appointment with Dr. Suresh Gowda/ }).click();
      await expect(desk.getByRole('heading', { name: 'Cancel this appointment?' })).toBeVisible();
      await desk.getByLabel('Reason (optional)').fill('Patient asked to cancel by phone');
      expect(sched.requests.filter((r) => r.line.endsWith('/cancel'))).toHaveLength(0);
      await shot(page, `w6-reception-cancel-${vp.width}`, false);
      await desk.getByRole('button', { name: 'Cancel appointment' }).click();
      await expect(desk.getByRole('heading', { name: 'Upcoming appointments' })).toBeVisible();
      const sent = sched.requests.find((r) => r.line.endsWith('/cancel'))!;
      expect(sent.body).toMatchObject({ reason: 'Patient asked to cancel by phone' });
      expect(sent.key).toMatch(/^[0-9a-f-]{36}$/);
    });

    test('books for a patient: department, doctor, day, session, then confirm', async ({ page }) => {
      const { extras } = await setupDesk(page, 'reception');
      const desk = await openDesk(page, 'Sneha', /Sneha Kulkarni/);
      await desk.getByRole('button', { name: 'Book appointment' }).click();
      await desk.getByRole('combobox', { name: 'Department' }).click();
      await page.getByRole('option', { name: 'Dermatology' }).click();
      await desk.getByRole('combobox', { name: 'Doctor' }).click();
      await page.getByRole('option', { name: /Dr. Pooja Bhat/ }).click();
      await desk.getByRole('combobox', { name: 'Day' }).click();
      await page.getByRole('option', { name: /Tomorrow/ }).click();
      await desk.getByRole('radio', { name: /Morning/ }).check();
      await expect(desk.getByTestId('slot-summary')).toContainText('Next free slot');
      await expect(desk.getByTestId('slot-summary')).toContainText('places left');
      await shot(page, `w6-reception-book-${vp.width}`, false);
      await desk.getByRole('button', { name: 'Book appointment' }).click();
      await expect(desk.getByRole('heading', { name: 'Upcoming appointments' })).toBeVisible();
      const sent = extras.posts.find((p) => p.path === '/appointments')!;
      expect(sent.body.patientId).toMatch(/^0000/);
      expect(sent.key).toMatch(/^[0-9a-f-]{36}$/);
      await expect(desk.getByRole('listitem').filter({ hasText: 'Dr. Pooja Bhat' })).toBeVisible();
    });
  });
}

test.describe('reception booking by keyboard alone', () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

  test('search, open the patient desk, choose department, doctor, day and session, and book: no mouse', async ({
    page,
  }) => {
    const { extras } = await setupDesk(page, 'reception');
    await page.goto('/reception');
    await hideToasts(page);
    await expect(page.getByRole('heading', { name: 'Reception desk', level: 1 })).toBeVisible();
    await expect(page.getByRole('option', { name: /Sneha Kulkarni/ })).toBeVisible();

    await page.keyboard.press('/');
    await expect(page.getByRole('combobox', { name: 'Find an arrival' })).toBeFocused();
    await page.keyboard.type('Sneha');
    await expect(page.getByRole('button', { name: 'Open patient desk' })).toBeEnabled();
    await expect(page.getByRole('option', { name: /Sneha Kulkarni/ })).toHaveCount(1);

    await tabTo(page, page.getByRole('button', { name: 'Open patient desk' }));
    await page.keyboard.press('Enter');
    const desk = page.getByRole('dialog', { name: /Sneha Kulkarni/ });
    await expect(desk).toBeVisible();
    await tabTo(page, desk.getByRole('button', { name: 'Book appointment' }));
    await page.keyboard.press('Enter');
    await expect(desk.getByRole('heading', { name: 'Book an appointment' })).toBeFocused();

    await tabTo(page, desk.getByRole('combobox', { name: 'Department' }));
    await page.keyboard.press('Enter');
    await page.keyboard.type('Dermatology');
    await page.keyboard.press('Enter');
    await expect(desk.getByRole('combobox', { name: 'Department' })).toContainText('Dermatology');

    await tabTo(page, desk.getByRole('combobox', { name: 'Doctor' }));
    await page.keyboard.press('Enter');
    await page.keyboard.type('Dr. Pooja');
    await page.keyboard.press('Enter');
    await expect(desk.getByRole('combobox', { name: 'Doctor' })).toContainText('Dr. Pooja Bhat');

    await tabTo(page, desk.getByRole('combobox', { name: 'Day' }));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('option', { name: /^Today/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('option', { name: /^Tomorrow/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(desk.getByRole('combobox', { name: 'Day' })).toContainText('Tomorrow');

    // The session list is one radio group: Tab enters it, Space chooses, Enter moves to the confirm button.
    await tabTo(page, desk.getByRole('radio', { name: /Morning/ }));
    await page.keyboard.press('Space');
    await expect(desk.getByTestId('slot-summary')).toContainText('Next free slot');
    await page.keyboard.press('Enter');
    const book = desk.getByRole('button', { name: 'Book appointment' });
    await expect(book).toBeFocused();
    // Visible focus ring: a 2px outline.
    const outline = await book.evaluate((el) => getComputedStyle(el).outlineWidth);
    expect(parseFloat(outline)).toBeGreaterThanOrEqual(2);
    await shot(page, 'w6-reception-book-keyboard-1440', false);
    await page.keyboard.press('Enter');
    await expect(desk.getByRole('heading', { name: 'Upcoming appointments' })).toBeVisible();
    expect(extras.posts.filter((p) => p.path === '/appointments')).toHaveLength(1);
  });
});

for (const vp of VIEWPORTS) {
  test.describe(`reception duplicates, alternatives and markers at ${vp.width}`, () => {
    test.use({ viewport: vp, deviceScaleFactor: 1 });

    test('a duplicate registration offers the existing patients, or a new record on purpose', async ({ page }) => {
      const { extras } = await setupDesk(page, 'reception');
      await page.goto('/reception');
      await hideToasts(page);
      await expect(page.getByRole('heading', { name: 'Reception desk', level: 1 })).toBeVisible();
      await page.getByRole('button', { name: 'Register new patient' }).click();
      await page.getByLabel('Full name').fill('Harish Gowda');
      await page.getByLabel('Phone (optional)').fill('+91 98450 22341');
      await page.getByRole('button', { name: 'Register and admit walk-in' }).click();
      const panel = page.getByRole('alert', { name: 'This may be an existing patient' });
      await expect(panel).toBeVisible();
      await expect(panel).toContainText('BLR-000002');
      await expect(panel).toContainText('3 Aug 1962');
      await expect(panel.getByRole('button', { name: /^Use this patient/ })).toHaveCount(2);
      await panel.scrollIntoViewIfNeeded();
      await shot(page, `w6-reception-duplicates-${vp.width}`);

      await panel.getByRole('button', { name: 'Create new record anyway' }).click();
      await expect(page.getByTestId('arrival-outcome')).toContainText('Admitted');
      const registrations = extras.posts.filter((p) => p.path === '/patients');
      expect(registrations).toHaveLength(2);
      expect(registrations[1]!.body.confirmNew).toBe(true);
      expect(registrations[1]!.key).not.toBe(registrations[0]!.key);
    });

    test('walk-ins full: other doctors with free places, Admit to Dr. X, and no override', async ({ page }) => {
      const { extras } = await setupDesk(page, 'reception', { sched: { walkinFull: true } });
      await findArrival(page, 'Divya', /Divya Prakash/);
      const panel = page.getByTestId('alternatives');
      await expect(panel.getByRole('heading', { name: 'Other doctors in General Medicine today' })).toBeVisible();
      await expect(panel).toContainText('Dr. Anil Bhat');
      await expect(panel).toContainText('3 walk-in places left');
      await expect(panel).toContainText('Ask an admin to raise capacity');
      await expect(page.getByRole('button', { name: /override|admit anyway/i })).toHaveCount(0);
      await panel.scrollIntoViewIfNeeded();
      await shot(page, `w6-reception-alternatives-${vp.width}`);

      await panel.getByRole('button', { name: 'Admit to Dr. Anil Bhat' }).click();
      await expect(page.getByTestId('arrival-outcome')).toContainText('With Dr. Anil Bhat');
      const sent = extras.posts.find((p) => p.path.endsWith('/walk-ins'))!;
      expect(sent.path).toBe(`/sessions/${ALT_BHAT}/walk-ins`);
      expect(sent.key).toMatch(/^[0-9a-f-]{36}$/);
    });

    test('Expected shows who is late and who is past grace', async ({ page }) => {
      await setupDesk(page, 'reception');
      await page.goto('/reception');
      await hideToasts(page);
      const expected = page.getByRole('region', { name: 'Expected' });
      await expect(expected).toBeVisible();
      await expect(expected.getByText('Late 30 min, past grace')).toBeVisible();
      await expect(expected.getByText('Late 5 min')).toBeVisible();
      await expected.scrollIntoViewIfNeeded();
      await shot(page, `w6-reception-late-markers-${vp.width}`);
    });

    test('Mark absent asks for confirmation and an optional reason', async ({ page }) => {
      const { queue } = await setupDesk(page, 'reception');
      await page.goto('/reception');
      await hideToasts(page);
      await page.getByRole('button', { name: /A-014/ }).click();
      await page.getByRole('button', { name: 'Mark absent' }).click();
      const dialog = page.getByRole('dialog', { name: 'Mark A-014 absent' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('Reason (optional)')).toBeFocused();
      expect(queue.requests.filter((r) => r.line.includes('/absent'))).toHaveLength(0);
      await dialog.getByLabel('Reason (optional)').fill('Went to the pharmacy');
      await shot(page, `w6-reception-absent-confirm-${vp.width}`, false);
      await dialog.getByRole('button', { name: 'Mark absent' }).click();
      await expect(dialog).toBeHidden();
      const sent = queue.requests.find((r) => r.line.includes('/absent'))!;
      expect(sent.body).toMatchObject({ reason: 'Went to the pharmacy' });
    });
  });
}

for (const vp of VIEWPORTS) {
  test.describe(`doctor follow-up and skip at ${vp.width}`, () => {
    test.use({ viewport: vp, deviceScaleFactor: 1 });

    test('create a follow-up for the patient with the doctor, and for the one just completed', async ({ page }) => {
      const { extras } = await setupDesk(page, 'doctor');
      await page.goto('/doctor');
      await hideToasts(page);
      await expect(page.getByRole('button', { name: /^Call next/ })).toBeVisible();
      await page.getByRole('button', { name: /^Call next/ }).click();
      await expect(page.getByTestId('now-active')).toContainText('A-014');
      await page.getByRole('button', { name: 'Start' }).click();
      await page.getByRole('button', { name: 'Create follow-up' }).click();
      const dialog = page.getByRole('dialog', { name: /Create follow-up for Harish Gowda/ });
      await dialog.getByRole('radio', { name: 'Check medication response' }).check();
      await dialog.getByLabel('Detail (optional)').fill('Ask about dizziness since the dose change.');
      await dialog.getByRole('combobox', { name: 'Due in' }).click();
      await page.getByRole('option', { name: '7 days' }).click();
      await shot(page, `w6-doctor-follow-up-${vp.width}`, false);
      await dialog.getByRole('button', { name: 'Create follow-up' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId('followup-confirmation')).toContainText(
        'Check medication response, due Wed, 18 Nov',
      );
      const first = extras.posts.find((p) => p.path === '/follow-up-tasks')!;
      expect(first.body).toMatchObject({
        kind: 'post_visit',
        title: 'Check medication response',
        dueAt: '2026-11-18T11:30:00.000Z',
      });
      expect(first.body.sourceVisitId).toBeTruthy();
      expect(first.key).toMatch(/^[0-9a-f-]{36}$/);

      // Complete: the patient stays on screen with the same action until the next call.
      await page.getByRole('button', { name: 'Complete' }).click();
      const just = page.getByRole('region', { name: 'Just completed' });
      await expect(just).toContainText('Harish Gowda');
      await just.getByRole('button', { name: 'Create follow-up' }).click();
      const again = page.getByRole('dialog', { name: /Create follow-up for Harish Gowda/ });
      await again.getByRole('radio', { name: 'Something else' }).check();
      await again.getByLabel('Title').fill('Review knee X-ray');
      await again.getByRole('button', { name: 'Create follow-up' }).click();
      await expect(again).toBeHidden();
      await expect(just.getByTestId('followup-confirmation')).toContainText('Review knee X-ray');
      await shot(page, `w6-doctor-just-completed-${vp.width}`);

      await page.getByRole('button', { name: /^Call next/ }).click();
      await expect(just).toBeHidden();
    });

    test('Skip asks first', async ({ page }) => {
      const { queue } = await setupDesk(page, 'doctor');
      await page.goto('/doctor');
      await hideToasts(page);
      await page.getByRole('button', { name: /^Call next/ }).click();
      await expect(page.getByTestId('now-active')).toContainText('A-014');
      await page.getByRole('button', { name: 'Skip' }).click();
      const dialog = page.getByRole('dialog', { name: 'Skip A-014?' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Keep called' })).toBeFocused();
      expect(queue.requests.filter((r) => r.line.endsWith('/skip'))).toHaveLength(0);
      await shot(page, `w6-doctor-skip-confirm-${vp.width}`, false);
      await dialog.getByRole('button', { name: 'Skip' }).click();
      await expect(dialog).toBeHidden();
      expect(queue.requests.filter((r) => r.line.endsWith('/skip'))).toHaveLength(1);
    });
  });
}

for (const vp of VIEWPORTS) {
  test.describe(`patient My visit offline at ${vp.width}`, () => {
    test.use({ viewport: vp, deviceScaleFactor: 1 });

    test('says Reconnecting… after 10 s offline and clears when the connection returns', async ({ page, context }) => {
      await installFakeEventSource(page);
      await mockApi(page, 'patient');
      const mock = await mockQueue(page, { view: 'patient' });
      await mockScheduling(page);
      await page.goto(`/patient/visit/${SESSION_ID}`);
      await expect(page.getByText('Your token', { exact: true })).toBeVisible();
      await context.setOffline(true);
      await expect(page.getByText('Reconnecting…')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(/Showing the queue as of/)).toBeVisible();
      await shot(page, `w6-patient-offline-${vp.width}`);
      const before = mock.snapshotFetches();
      await context.setOffline(false);
      await expect(page.getByText('Reconnecting…')).toBeHidden();
      await expect.poll(() => mock.snapshotFetches()).toBeGreaterThan(before);
    });
  });
}
