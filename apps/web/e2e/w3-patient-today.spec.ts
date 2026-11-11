/* eslint-disable @typescript-eslint/no-non-null-assertion -- fixtures look up ids this file created */
import { expect, test, type Page } from '@playwright/test';
import { mockApi } from './mocks';
import { installFakeEventSource, mockQueue } from './mocks-queue';
import { ME_PATIENT_ID, mockScheduling, type ApptRow, type SchedulingMock } from './scheduling-mocks';
import { mockWave3, routeLiveBoardToQueueMock } from './w3-mocks';
import { shot } from './w3-helpers';

async function setup(page: Page, status: ApptRow['status'] = 'checked_in'): Promise<SchedulingMock> {
  await installFakeEventSource(page);
  await mockApi(page, 'patient');
  await mockQueue(page, { view: 'patient' });
  const sched = await mockScheduling(page);
  await mockWave3(page, sched, 'patient');
  await routeLiveBoardToQueueMock(page);
  const session = sched.sessions.find((s) => s.sessionDate === '2026-11-11' && s.label === 'morning' && s.doctorName === 'Dr. Meenakshi Rao')!;
  sched.appointments.push({
    id: '00000000-0000-4000-8000-00000000b777',
    patientId: ME_PATIENT_ID,
    sessionId: session.id,
    doctorId: session.doctorId,
    doctorName: session.doctorName,
    department: session.department,
    scheduledAt: '2026-11-11T10:20:00+05:30',
    status,
    rescheduledFromId: null,
    followUpTaskId: null,
    version: 1,
    createdAt: '2026-11-05T05:00:00Z',
  });
  return sched;
}

test.describe('patient Today tab at 390', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

  test("shows today's appointment with a link to the live place in the queue", async ({ page }) => {
    await setup(page);
    await page.goto('/patient');
    const today = page.getByTestId('today-appointment');
    await expect(today).toHaveCount(1);
    await expect(today).toContainText('10:20 am');
    await expect(today).toContainText('Dr. Meenakshi Rao');
    await expect(today).toContainText('Checked in');
    await shot(page, 'w3-patient-today-390');

    // Reach the live visit by keyboard, and the Today tab stays active there.
    const link = today.getByRole('link', { name: 'See my place in the queue' });
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/patient\/visit\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('position')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Patient' }).getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'page');
  });

  test('a booked appointment today also links to the queue', async ({ page }) => {
    await setup(page, 'booked');
    await page.goto('/patient');
    await expect(page.getByTestId('today-appointment')).toContainText('Booked');
    await expect(page.getByRole('link', { name: 'See my place in the queue' })).toBeVisible();
  });

  test("My visits links today's row to the queue, other days do not", async ({ page }) => {
    await setup(page);
    await page.goto('/patient/visits');
    await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'See my place in the queue' })).toHaveCount(1);
  });

  test('without an appointment today the empty state offers booking', async ({ page }) => {
    const sched = await setup(page);
    sched.appointments.length = 0;
    await page.goto('/patient');
    await expect(page.getByRole('heading', { name: 'No visit today' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Book appointment' })).toBeVisible();
  });
});
