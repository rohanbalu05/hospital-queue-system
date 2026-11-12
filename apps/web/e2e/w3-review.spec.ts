/* eslint-disable @typescript-eslint/no-non-null-assertion -- fixtures look up ids this file created */
import { expect, test } from '@playwright/test';
import { setupW3, shot } from './w3-helpers';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const D_ANANYA_READY = uuid(0x7d02);
const D_HARISH_READY = uuid(0x7d05);
const D_LAKSHMI_FAILED = uuid(0x7d06);

test.describe('doctor review inbox at 1280', () => {
  test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });

  test('lists documents awaiting verification with status words', async ({ page }) => {
    await setupW3(page, 'doctor');
    await page.goto(`/doctor/review/${D_LAKSHMI_FAILED}`);
    await expect(page.getByRole('heading', { name: 'Awaiting verification' })).toBeVisible();
    const list = page.getByRole('region', { name: 'Awaiting verification' }).or(page.locator('section[aria-labelledby="inbox-h"]'));
    await expect(list.getByRole('link')).toHaveCount(4);
    await expect(list).toContainText('OCR ready');
    await expect(list).toContainText('OCR failed');
    // OCR failed: the failure, Retry OCR and Transcribe manually.
    await expect(page.getByRole('alert').filter({ hasText: 'OCR failed' })).toContainText('handwriting could not be read');
    await expect(page.getByRole('button', { name: 'Retry OCR' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Transcribe manually' })).toBeVisible();
    await shot(page, 'w3-review-inbox-1280');
  });

  test('transcribe manually opens an empty form that needs a title and text', async ({ page }) => {
    await setupW3(page, 'doctor');
    await page.goto(`/doctor/review/${D_LAKSHMI_FAILED}`);
    await page.getByRole('button', { name: 'Transcribe manually' }).click();
    await expect(page.getByLabel('Title')).toHaveValue('');
    await page.getByRole('button', { name: 'Verify instruction' }).click();
    await expect(page.getByText('Give the instruction a title of at least 3 characters.')).toBeVisible();
    await expect(page.getByText('Write the instruction, at least 3 characters.')).toBeVisible();
  });

  test('retry OCR sends the request and the document leaves the inbox', async ({ page }) => {
    const { w3 } = await setupW3(page, 'doctor');
    await page.goto(`/doctor/review/${D_LAKSHMI_FAILED}`);
    await page.getByRole('button', { name: 'Retry OCR' }).click();
    await expect(page.locator('section[aria-labelledby="inbox-h"]').getByRole('link')).toHaveCount(3);
    expect(w3.documents.find((d) => d.id === D_LAKSHMI_FAILED)!.status).toBe('processing');
  });

  test('detail: draft beside the editable instruction, with version history', async ({ page }) => {
    await setupW3(page, 'doctor');
    await page.goto(`/doctor/review/${D_ANANYA_READY}`);
    const draft = page.getByRole('region', { name: 'OCR draft' });
    await expect(draft).toContainText("Draft, not visible to the patient's assistant");
    await expect(draft.getByLabel('OCR draft text, read only')).toContainText('Tab. Cefixime 200 mg');
    // Prefilled from the draft; editable.
    await expect(page.getByLabel('Title')).toHaveValue('Fever and throat infection: home care');
    await expect(page.getByLabel('Instruction', { exact: true })).toHaveValue(/Tab\. Cefixime 200 mg/);
    // Both panels sit side by side.
    const a = await draft.boundingBox();
    const b = await page.getByRole('region', { name: 'Instruction to verify' }).boundingBox();
    expect(Math.abs(a!.y - b!.y)).toBeLessThan(4);
    expect(a!.x).toBeLessThan(b!.x);
    // History: version 2 is Current, version 1 is Superseded.
    const history = page.locator('section[aria-labelledby="history-h"]');
    await expect(history.getByText('Current')).toBeVisible();
    await expect(history.getByText('Superseded')).toBeVisible();
    await shot(page, 'w3-review-detail-1280');
  });

  test('keyboard only: edit and verify an instruction', async ({ page }) => {
    const { w3 } = await setupW3(page, 'doctor');
    await page.goto(`/doctor/review/${D_HARISH_READY}`);
    const title = page.getByLabel('Title');
    await expect(title).toHaveValue('Back pain: exercises and rest');
    await title.focus();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Instruction', { exact: true })).toBeFocused();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nUse a firm mattress.');
    await page.keyboard.press('Tab');
    const verify = page.getByRole('button', { name: 'Verify instruction' });
    await expect(verify).toBeFocused();
    await expect.poll(() => verify.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
    await page.keyboard.press('Enter');

    await expect(page.locator('section[aria-labelledby="inbox-h"]').getByRole('link')).toHaveCount(3);
    const sent = w3.requests.find((r) => r.line === `POST /documents/${D_HARISH_READY}/verify`)!;
    expect(sent.body).toMatchObject({ title: 'Back pain: exercises and rest' });
    expect((sent.body as { body: string }).body).toContain('Use a firm mattress.');
    expect(w3.documents.find((d) => d.id === D_HARISH_READY)!.status).toBe('verified');
    expect(w3.versions.filter((v) => v.patientId.endsWith('a002'))).toHaveLength(1);
  });

  test('verifying as a new version supersedes the current one', async ({ page }) => {
    const { w3 } = await setupW3(page, 'doctor');
    await page.goto(`/doctor/review/${D_ANANYA_READY}`);
    await page.getByRole('combobox', { name: 'Save as' }).click();
    await page.getByRole('option', { name: /New version of .Care after viral fever. \(now version 2\)/ }).click();
    await page.getByRole('button', { name: 'Verify instruction' }).click();
    await expect.poll(() => w3.versions.filter((v) => v.status === 'current' && v.title === 'Care after viral fever' || v.version === 3).length).toBeGreaterThan(0);
    const v3 = w3.versions.find((v) => v.version === 3)!;
    expect(v3.status).toBe('current');
    expect(w3.versions.find((v) => v.version === 2)!.status).toBe('superseded');
  });

  test('empty inbox and error states', async ({ page }) => {
    const { w3 } = await setupW3(page, 'doctor');
    w3.empty = true;
    await page.goto('/doctor/review');
    await expect(page.getByRole('heading', { name: 'Nothing to verify' })).toBeVisible();
    w3.empty = false;
    w3.failReads = true;
    await page.goto('/doctor/review');
    await expect(page.getByRole('alert').filter({ hasText: 'could not be loaded' })).toBeVisible();
  });
});
