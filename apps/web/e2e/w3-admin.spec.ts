/* eslint-disable @typescript-eslint/no-non-null-assertion -- fixtures look up ids this file created */
import { expect, test } from '@playwright/test';
import { setupW3, shot } from './w3-helpers';

test.describe('admin at 1440', () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

  test('sessions and capacity: table for the day, capacity shown as x/y', async ({ page }) => {
    await setupW3(page, 'admin');
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Administration', level: 1 })).toBeVisible();
    const rows = page.getByTestId('session-row');
    await expect(rows).toHaveCount(10);
    const rao = rows.filter({ hasText: 'Dr. Meenakshi Rao' }).filter({ hasText: 'Morning' });
    await expect(rao).toContainText('Open');
    await expect(rao).toContainText('8/10');
    await expect(rao).toContainText('0/5');
    await shot(page, 'w3-admin-sessions-1440');

    // Another date.
    await page.getByRole('button', { name: 'Next day' }).click();
    await expect(page.getByLabel('Date')).toHaveValue('2026-11-12');
    await expect(rows).toHaveCount(10);
  });

  test('edit capacity: a reduction below what is used is refused inline, a valid change is saved', async ({ page }) => {
    const { w3 } = await setupW3(page, 'admin');
    await page.goto('/admin');
    await page.getByRole('button', { name: /Edit capacity, Dr\. Meenakshi Rao, Morning/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit capacity' });
    await expect(dialog).toContainText('Already used: 8 booked, 0 walk-in');

    await dialog.getByLabel('Booked places').fill('5');
    await dialog.getByRole('button', { name: 'Save capacity' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Capacity not reduced');
    await expect(dialog.getByRole('alert')).toContainText('cannot go below 8');
    await expect(dialog).toBeVisible();
    await shot(page, 'w3-admin-capacity-error-1440', false);

    await dialog.getByLabel('Booked places').fill('12');
    await dialog.getByLabel('Walk-in places').fill('6');
    await dialog.getByRole('button', { name: 'Save capacity' }).click();
    await expect(dialog).toBeHidden();
    const rao = page.getByTestId('session-row').filter({ hasText: 'Dr. Meenakshi Rao' }).filter({ hasText: 'Morning' });
    await expect(rao).toContainText('8/12');
    await expect(rao).toContainText('0/6');
    expect(w3.requests.filter((r) => r.line.startsWith('PATCH'))).toHaveLength(2);
  });

  test('edit capacity works by keyboard and rejects non-numbers', async ({ page }) => {
    await setupW3(page, 'admin');
    await page.goto('/admin');
    await page.getByRole('button', { name: /Edit capacity, Dr\. Meenakshi Rao, Morning/ }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Edit capacity' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Booked places').fill('');
    await page.keyboard.press('Enter');
    await expect(dialog.getByText('Enter whole numbers from 0 to 100 for both places.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('staff assignments: user to doctors, multi-select', async ({ page }) => {
    const { w3 } = await setupW3(page, 'admin');
    await page.goto('/admin/staff');
    const rows = page.getByTestId('staff-row');
    await expect(rows).toHaveCount(4);
    await expect(rows.filter({ hasText: 'Deepa Nair' })).toContainText('Dr. Meenakshi Rao, Dr. Arvind Kulkarni');
    await shot(page, 'w3-admin-staff-1440');

    await page.getByRole('button', { name: 'Edit assignments, Deepa Nair' }).click();
    const dialog = page.getByRole('dialog', { name: 'Assign doctors' });
    await expect(dialog.getByRole('checkbox', { name: /Dr\. Meenakshi Rao/ })).toBeChecked();
    await dialog.getByRole('checkbox', { name: /Dr\. Farah Siddiqui/ }).click();
    await dialog.getByRole('checkbox', { name: /Dr\. Arvind Kulkarni/ }).click();
    await dialog.getByRole('button', { name: 'Save assignments' }).click();
    await expect(dialog).toBeHidden();
    await expect(rows.filter({ hasText: 'Deepa Nair' })).toContainText('Dr. Meenakshi Rao, Dr. Farah Siddiqui');
    const put = w3.requests.find((r) => r.line.startsWith('PUT /admin/staff'))!;
    expect((put.body as { doctorIds: string[] }).doctorIds).toHaveLength(2);
  });

  test('current policy: read-only Table 7 values and the version', async ({ page }) => {
    await setupW3(page, 'admin');
    await page.goto('/admin/policy');
    await expect(page.getByTestId('policy-version')).toContainText('Policy version 1');
    const table = page.getByRole('table');
    await expect(table.getByRole('row', { name: /Group rotation/ })).toContainText('A, A, W');
    await expect(table.getByRole('row', { name: /Early eligibility/ })).toContainText('10 min');
    await expect(table.getByRole('row', { name: /Late grace/ })).toContainText('15 min');
    await expect(table.getByRole('row', { name: /Aging trigger/ })).toContainText('45 min');
    await expect(table.getByRole('row', { name: /Called timeout/ })).toContainText('2 min');
    await expect(table.getByRole('row', { name: /EWMA/ })).toContainText('0.2');
    await expect(table.getByRole('row', { name: /Initial estimate/ })).toContainText('12 min');
    await expect(table.getByRole('row', { name: /Booked capacity/ })).toContainText('10');
    await expect(table.getByRole('row', { name: /Walk-in capacity/ })).toContainText('5');
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await shot(page, 'w3-admin-policy-1440');
  });

  test('reports: every metric is labelled Measured or Target', async ({ page }) => {
    await setupW3(page, 'admin');
    await page.goto('/admin/reports');
    await expect(page.getByRole('heading', { name: 'Throughput' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Waiting time by group' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Call decisions by reason' })).toBeVisible();
    // Every block heading carries a kind tag; every metric row carries one.
    const rows = page.locator('tr[data-kind]');
    await expect(rows).toHaveCount(7);
    for (const r of await rows.all()) {
      const kind = await r.getAttribute('data-kind');
      await expect(r.locator(`[data-kind="${kind}"]`)).toHaveText(kind === 'measured' ? 'Measured' : 'Target');
    }
    const latency = page.locator('tr[data-kind="target"]').filter({ hasText: '500 ms' });
    await expect(latency).toHaveCount(1);
    await expect(page.locator('tr[data-kind="measured"]').filter({ hasText: 'Not enough data' }).first()).toBeVisible();
    await expect(page.getByRole('row', { name: /Rotation/ })).toContainText('168');
    await expect(page.getByRole('row', { name: /Appointment/ }).first()).toContainText('14.0 min');
    // No screenshot here: these figures are a test fixture. The report screenshot comes from e2e-real/reports.spec.ts,
    // which runs against the real seeded API.
  });

  test('reports: empty period and error', async ({ page }) => {
    const { w3 } = await setupW3(page, 'admin');
    w3.empty = true;
    await page.goto('/admin/reports');
    await expect(page.getByRole('heading', { name: 'No sessions in this period' })).toBeVisible();
    w3.empty = false;
    w3.failReads = true;
    await page.goto('/admin/reports');
    await expect(page.getByRole('alert').filter({ hasText: 'The report could not be loaded' })).toBeVisible();
  });

  test('audit: filter by entity, shows actor, time, operation, policy version and reason', async ({ page }) => {
    await setupW3(page, 'admin');
    await page.goto('/admin/audit');
    const rows = page.getByTestId('audit-row');
    await expect(rows).toHaveCount(10);
    await expect(rows.first()).toContainText('Called next patient');
    await expect(rows.first()).toContainText('Dr. Meenakshi Rao');
    await expect(rows.first()).toContainText('Queue entry');
    await expect(rows.first().getByTitle('queue.call_next')).toBeVisible();
    await expect(rows.first()).toContainText('9:58:14 am');
    await expect(rows.first()).toContainText('v1');
    await expect(rows.first()).toContainText('Called by rotation: 2nd appointment of A, A, W');
    await shot(page, 'w3-admin-audit-1440');

    await page.getByRole('combobox', { name: 'Entity' }).click();
    await page.getByRole('option', { name: 'Sessions' }).click();
    await page.getByRole('button', { name: 'Apply filter' }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Changed session capacity');

    await page.getByLabel('Entity id (optional)').fill('not-an-id');
    await page.getByRole('button', { name: 'Apply filter' }).click();
    await expect(page.getByRole('alert')).toContainText('An entity id looks like');
  });
});
