import { expect, test } from '@playwright/test';
import { setupW3, shot } from './w3-helpers';
import { T_NO_VISIT, T_RECOVERY, T_URGENT, applyW6 } from './w6-followup-mocks';

async function open(page: import('@playwright/test').Page, path: string) {
  const world = await setupW3(page, 'followup');
  await applyW6(page, world.w3);
  await page.goto(path);
  return world;
}

for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const) {
  test.describe(`follow-up staff reach and reply at ${width}`, () => {
    test.use({ viewport: { width, height }, deviceScaleFactor: 1 });

    test(`inbox: the urgent task is first and marked with the word Urgent (${width})`, async ({ page }) => {
      await open(page, '/follow-up');
      const rows = page.getByTestId('task-row');
      await expect(rows.first()).toContainText('Harish Gowda');
      await expect(rows.first()).toContainText('Urgent');
      await expect(rows.first()).toHaveAttribute('data-urgent', 'true');
      await expect(page.getByText('Urgent', { exact: true })).toHaveCount(1);
      await shot(page, `w6-followup-inbox-${width}`);
    });

    test(`urgent task detail: call-now guidance and how to reach the patient (${width})`, async ({ page }) => {
      await open(page, `/follow-up/tasks/${T_URGENT}`);
      await expect(page.getByRole('alert').filter({ hasText: 'Red-flag symptoms reported. Call the patient now.' })).toBeVisible();
      const call = page.getByRole('link', { name: /Call Harish Gowda/ });
      await expect(call).toHaveAttribute('href', /^tel:\+91\d{10}$/);
      await expect(page.getByText('MRN-204102')).toBeVisible();
      await expect(page.getByText('Dr. Meenakshi Rao', { exact: true }).first()).toBeVisible();
      await expect(page.getByText(/dizzy after the new tablets/).first()).toBeVisible();
      if (width === 390) {
        const box = await call.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
        expect(box?.width ?? 0).toBeGreaterThan(200);
      }
      await shot(page, `w6-followup-urgent-detail-${width}`);
    });

    test(`resolve: the reply is required for Advice given, separate from the staff note, and shown afterwards (${width})`, async ({ page }) => {
      const { w3 } = await open(page, `/follow-up/tasks/${T_URGENT}`);
      await page.getByRole('button', { name: 'Acknowledge', exact: true }).click();
      const outcome = page.getByRole('combobox', { name: 'Outcome' });
      await expect(outcome).toBeVisible();
      await outcome.click();
      await page.getByRole('option', { name: 'Advice given' }).click();

      await expect(page.getByText('The patient sees this')).toBeVisible();
      await expect(page.getByText('Staff only.')).toBeVisible();
      await expect(page.getByText('Required for this outcome.')).toBeVisible();

      await page.getByLabel('Outcome note').fill('Called 10:42. Patient anxious, no chest pain. Doctor informed.');
      await page.getByRole('button', { name: 'Resolve task' }).click();
      await expect(page.getByText('Write the reply the patient will read, at least 3 characters.')).toBeVisible();
      expect(w3.requests.some((r) => r.line.endsWith('/resolve'))).toBe(false);
      await shot(page, `w6-followup-resolve-form-${width}`);

      await page.getByLabel('Reply to the patient').fill('Please do not stop the tablets on your own. Come to the General Medicine desk today before 1 pm and we will check you.');
      await page.getByRole('button', { name: 'Resolve task' }).click();

      await expect(page.getByRole('heading', { name: 'Outcome', level: 2, exact: true })).toBeVisible();
      await expect(page.getByText('Reply sent to the patient')).toBeVisible();
      await expect(page.getByText(/Please do not stop the tablets on your own/)).toBeVisible();
      await expect(page.getByText('Staff note', { exact: true })).toBeVisible();
      const resolve = w3.requests.find((r) => r.line.endsWith('/resolve'));
      expect(resolve?.body).toMatchObject({
        disposition: 'advice_given',
        outcomeNote: 'Called 10:42. Patient anxious, no chest pain. Doctor informed.',
        patientReply: expect.stringContaining('Please do not stop the tablets'),
      });
      await shot(page, `w6-followup-resolved-${width}`);
    });

    test(`return booking: defaults to the task's doctor and names the real date range (${width})`, async ({ page }) => {
      await open(page, `/follow-up/tasks/${T_NO_VISIT}`);
      await page.getByRole('button', { name: 'Book return visit' }).click();
      const dialog = page.getByRole('dialog', { name: 'Book return visit' });
      await expect(dialog.getByRole('combobox', { name: 'Doctor' })).toContainText('Dr. Meenakshi Rao');
      await expect(dialog.getByText(/^Sessions (from|on) /)).toBeVisible();
      await expect(dialog.getByText(/next 14 days/)).toHaveCount(0);
      await shot(page, `w6-followup-return-${width}`, false);
    });
  });
}

test.describe('keyboard', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('resolve with a reply by keyboard alone', async ({ page }) => {
    const { w3 } = await open(page, `/follow-up/tasks/${T_RECOVERY}`);
    const outcome = page.getByRole('combobox', { name: 'Outcome' });
    await outcome.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter'); // Advice given
    await expect(outcome).toContainText('Advice given');
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Reply to the patient')).toBeFocused();
    await page.keyboard.type('Glad you are recovering. Finish the antibiotic course and drink plenty of fluids.');
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Outcome note')).toBeFocused();
    await page.keyboard.type('Called, afebrile for 24 h.');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Reply sent to the patient')).toBeVisible();
    expect(w3.tasks.find((t) => t.id === T_RECOVERY)?.patientReply).toMatch(/Finish the antibiotic course/);
  });
});
