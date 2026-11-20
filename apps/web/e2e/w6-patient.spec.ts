/* eslint-disable @typescript-eslint/no-non-null-assertion -- specs assert on boxes of elements they just waited for */
import { expect, test, type Page } from '@playwright/test';
import { shot } from './w3-helpers';
import { S_KULKARNI } from './w5-patient-mocks';
import { ME_PATIENT_ID, TODAY } from './scheduling-mocks';
import { ADVICE, mockW6, sampleFollowUps } from './w6-patient-mocks';

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** One screenshot per width, named w6-patient-<what>-<1440|390>.png. */
async function both(page: Page, name: string, fullPage = true) {
  for (const size of [DESKTOP, PHONE]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(150);
    await shot(page, `${name}-${size.width}`, fullPage);
  }
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

const completed = {
  id: '00000000-0000-4000-8000-0000000000c1',
  patientId: ME_PATIENT_ID,
  sessionId: S_KULKARNI,
  doctorId: '00000000-0000-4000-8000-0000000000d1',
  doctorName: 'Dr. Meenakshi Rao',
  department: 'General Medicine',
  scheduledAt: `${TODAY}T09:00:00+05:30`,
  status: 'completed' as const,
  rescheduledFromId: null,
  followUpTaskId: null,
  version: 3,
  createdAt: '2026-11-05T05:00:00Z',
};

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(PHONE);
});

test.describe('red-flag question on Questions (PR-13)', () => {
  test('the urgent advice comes first, is announced once, and has call links at 390 px', async ({ page }) => {
    const world = await mockW6(page);
    await page.goto('/patient/questions');
    await page.getByLabel('Your question').fill('I feel dizzy and have chest pain after the new tablets. Should I stop taking them?');
    await page.getByRole('button', { name: 'Ask question' }).click();

    const callout = page.getByTestId('urgent-advice');
    await expect(callout).toBeVisible();
    await expect(callout).toHaveAttribute('role', 'alert');
    await expect(callout).toContainText('Urgent');
    await expect(callout).toContainText(ADVICE);
    await expect(callout.getByRole('link', { name: 'Call 108' })).toHaveAttribute('href', 'tel:108');
    await expect(callout.getByRole('link', { name: /Call the hospital front desk, 080 4123 4500/ })).toHaveAttribute('href', 'tel:08041234500');
    await expect(page.getByText(/The care team will contact you within 2 hours, by 11 Nov, 12:05 pm\./)).toBeVisible();
    expect(world.asked).toHaveLength(1);

    // The advice sits above the escalation wording, and the call link is reachable by keyboard.
    const calloutBox = (await callout.boundingBox())!;
    const sentBox = (await page.getByText('Sent to the follow-up team.').boundingBox())!;
    expect(calloutBox.y).toBeLessThan(sentBox.y);
    await callout.getByRole('link', { name: 'Call 108' }).focus();
    await expect(callout.getByRole('link', { name: 'Call 108' })).toBeFocused();

    // Impossible to miss at 390 px: the whole callout, including both call buttons, is inside the first screen.
    await page.waitForTimeout(150);
    const inView = await callout.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    });
    expect(inView).toBe(true);
    await both(page, 'w6-patient-assistant-urgent', false);
    await noHorizontalScroll(page);

    // Reloading shows the same advice as history: still there, no longer an alert.
    await page.reload();
    const history = page.getByTestId('urgent-advice');
    await expect(history).toContainText(ADVICE);
    await expect(history).not.toHaveAttribute('role', 'alert');
    await both(page, 'w6-patient-assistant-urgent-history');
  });

  test('an ordinary unsupported question has no urgent callout', async ({ page }) => {
    await mockW6(page);
    await page.goto('/patient/questions');
    await page.getByLabel('Your question').fill('Can I keep the knee brace on while I sleep?');
    await page.getByRole('button', { name: 'Ask question' }).click();
    await expect(page.getByText(/You'll hear back by 12 Nov, 4:00 pm\./)).toBeVisible();
    await expect(page.getByTestId('urgent-advice')).toHaveCount(0);
  });
});

test.describe('care team reply on Follow-ups (PR-14)', () => {
  test('urgent first, the reply in a labelled block, an unseen reply marked once', async ({ page }) => {
    await mockW6(page, { followUps: sampleFollowUps() });
    await page.goto('/patient/follow-ups');
    await expect(page.getByRole('status').filter({ hasText: '1 new reply from the care team' })).toBeVisible();

    const rows = page.locator('li[data-status]');
    await expect(rows.first()).toContainText('Urgent');
    await expect(rows.first()).toContainText('You\'ll hear back by 11 Nov, 12:05 pm.');

    const reply = page.getByTestId('care-team-reply');
    await expect(reply).toHaveCount(1);
    await expect(reply).toContainText('Reply from the care team');
    await expect(reply).toContainText('10 Nov, 2:10 pm');
    await expect(reply).toContainText('bring the strip to the Paediatrics desk tomorrow at 9 am');
    await expect(page.getByTestId('new-reply-mark')).toHaveCount(1);
    await both(page, 'w6-patient-followups-reply');
    await noHorizontalScroll(page);

    // The next visit no longer marks it as new.
    await page.goto('/patient/follow-ups');
    await expect(page.getByTestId('care-team-reply')).toHaveCount(1);
    await expect(page.getByTestId('new-reply-mark')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'new reply' })).toHaveCount(0);
    await both(page, 'w6-patient-followups-seen');
  });
});

test.describe('Today after a completed visit (PR-15)', () => {
  test('says the visit was completed, links to follow-ups, and labels the return visit', async ({ page }) => {
    const returnVisit = {
      ...completed,
      id: '00000000-0000-4000-8000-0000000000c2',
      doctorName: 'Dr. Arvind Kulkarni',
      department: 'Paediatrics',
      scheduledAt: '2026-11-18T10:20:00+05:30',
      status: 'booked' as const,
      followUpTaskId: '00000000-0000-4000-8000-0000000000f9',
    };
    await mockW6(page, { appointments: [completed, returnVisit] });
    await page.goto('/patient');
    const card = page.getByTestId('today-completed');
    await expect(card).toContainText('Visit completed at 9:00 am with Dr. Meenakshi Rao');
    await expect(card.getByRole('link', { name: 'See your follow-ups' })).toHaveAttribute('href', '/patient/follow-ups');
    await expect(page.getByText('No visit today')).toHaveCount(0);
    await both(page, 'w6-patient-today-completed');
    await noHorizontalScroll(page);

    await page.goto('/patient/visits');
    const line = page.getByTestId('visit-line').filter({ hasText: 'Dr. Arvind Kulkarni' });
    await expect(line.getByTestId('return-visit-tag')).toHaveText('Return visit');
    await both(page, 'w6-patient-visits-return');
  });

  test('a return appointment today is labelled on its Today card', async ({ page }) => {
    await mockW6(page, { appointments: [{ ...completed, status: 'booked', scheduledAt: `${TODAY}T11:20:00+05:30`, followUpTaskId: '00000000-0000-4000-8000-0000000000f9' }] });
    await page.goto('/patient');
    await expect(page.getByTestId('today-appointment').getByTestId('return-visit-tag')).toHaveText('Return visit');
    await both(page, 'w6-patient-today-return');
  });
});

test.describe('after cancelling (PR-19)', () => {
  test('My visits offers Book a new time, which opens Book', async ({ page }) => {
    await mockW6(page);
    await page.goto('/patient/visits');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel appointment' }).click();
    const notice = page.getByTestId('cancelled-notice');
    await expect(notice).toContainText('Appointment cancelled');
    await both(page, 'w6-patient-visits-cancelled');
    await notice.getByRole('link', { name: 'Book a new time' }).click();
    await expect(page).toHaveURL(/\/patient\/book$/);
  });
});
