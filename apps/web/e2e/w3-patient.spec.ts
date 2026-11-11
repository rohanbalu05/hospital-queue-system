import { expect, test, type Page } from '@playwright/test';
import { ME_PATIENT_ID } from './scheduling-mocks';
import { CONVERSATION_ID } from './w3-mocks';
import { setupW3, shot } from './w3-helpers';

/** Reopen the conversation the way the page does: its id is remembered in this browser only. */
async function rememberConversation(page: Page) {
  await page.addInitScript(
    ([key, id]) => {
      window.localStorage.setItem(key as string, id as string);
    },
    [`hqms.assistant.${ME_PATIENT_ID}`, CONVERSATION_ID] as const,
  );
}

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test.describe('patient at 390', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

  test('documents: statuses in words, verified instructions, no horizontal scroll', async ({ page }) => {
    await setupW3(page, 'patient');
    await page.goto('/patient/documents');
    await expect(page.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible();
    const list = page.getByRole('list').filter({ hasText: 'discharge-summary-4-nov.pdf' });
    await expect(list.locator('[data-status="verified"]')).toContainText('Verified');
    await expect(list.locator('[data-status="ocr_ready"]')).toContainText('Ready for review');
    await expect(list.locator('[data-status="processing"]')).toContainText('Processing');
    await expect(list.locator('[data-status="ocr_failed"]')).toContainText("Couldn't read — staff will review");
    await expect(page.getByText('PDF, PNG or JPEG, up to 10 MB and 10 pages.')).toBeVisible();
    // Nothing from OCR or the staff reaches the patient.
    await expect(page.locator('body')).not.toContainText('Cefixime');
    expect(await noHorizontalScroll(page)).toBe(true);
    await shot(page, 'w3-patient-documents-390');
  });

  test('documents: client-side checks for size and type, then an upload shows as Uploaded', async ({ page }) => {
    const { w3 } = await setupW3(page, 'patient');
    await page.goto('/patient/documents');
    const input = page.getByLabel('Choose a file');

    await input.setInputFiles({ name: 'huge-scan.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(11 * 1024 * 1024) });
    await expect(page.getByText(/This file is 11\.0 MB\. The limit is 10 MB/)).toBeVisible();
    await page.getByRole('button', { name: 'Upload document' }).click();
    expect(w3.requests.filter((r) => r.line === 'POST /documents')).toHaveLength(0);

    await input.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await expect(page.getByText('This file type is not accepted. Choose a PDF, PNG or JPEG.')).toBeVisible();

    await input.setInputFiles({ name: 'lab-report.png', mimeType: 'image/png', buffer: Buffer.alloc(40_000, 1) });
    await expect(page.getByText('This file type is not accepted.')).toBeHidden();
    await page.getByRole('button', { name: 'Upload document' }).click();
    await expect(page.locator('[data-status="uploaded"]')).toContainText('lab-report.png');
    await expect(page.locator('[data-status="uploaded"]')).toContainText('Uploaded');
  });

  test('documents: a server page-limit error is explained in plain words', async ({ page }) => {
    await setupW3(page, 'patient');
    await page.goto('/patient/documents');
    await page.getByLabel('Choose a file').setInputFiles({ name: 'too-many-pages.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(30_000, 2) });
    await page.getByRole('button', { name: 'Upload document' }).click();
    await expect(page.getByRole('status').or(page.getByRole('alert')).filter({ hasText: 'more than 10 pages' })).toBeVisible();
  });

  test('documents: empty and error states', async ({ page }) => {
    const { w3 } = await setupW3(page, 'patient');
    w3.empty = true;
    await page.goto('/patient/documents');
    await expect(page.getByRole('heading', { name: 'No documents yet' })).toBeVisible();
    w3.empty = false;
    w3.failReads = true;
    await page.goto('/patient/documents');
    await expect(page.getByRole('alert').filter({ hasText: 'Your documents could not be loaded' })).toBeVisible();
  });

  test('assistant: answers cite the verified version, escalations name the time, no sparkle', async ({ page }) => {
    await setupW3(page, 'patient');
    await rememberConversation(page);
    await page.goto('/patient/questions');
    await expect(page.getByRole('heading', { name: 'Questions about your instructions', level: 1 })).toBeVisible();
    await expect(page.getByTestId('assistant-note')).toContainText('only uses instructions your doctor has verified');
    await expect(page.getByTestId('assistant-note')).toContainText('cannot change your treatment');

    const answered = page.locator('[data-outcome="answered"]');
    await expect(answered).toContainText('no more than 3 tablets in a day');
    await expect(answered).toContainText('From: Care after viral fever (version 2, verified 9 Nov 2026)');
    const escalated = page.locator('[data-outcome="escalated"]');
    await expect(escalated).toContainText("Sent to the follow-up team. You'll hear back by 11 Nov, 2:00 pm.");
    // No icons or sparkle on the assistant rows.
    await expect(page.locator('li[data-role="assistant"] svg')).toHaveCount(0);
    expect(await noHorizontalScroll(page)).toBe(true);
    await shot(page, 'w3-patient-assistant-390');
  });

  test('assistant: ask a question, get an answer, then one that is sent to the team', async ({ page }) => {
    await setupW3(page, 'patient');
    await page.goto('/patient/questions');
    await expect(page.getByText(/No questions yet/)).toBeVisible();

    await page.getByRole('button', { name: 'Ask question' }).click();
    await expect(page.getByText('Type your question first')).toBeVisible();

    await page.getByLabel('Your question').fill('How long should I rest after the fever?');
    await page.getByRole('button', { name: 'Ask question' }).click();
    await expect(page.locator('[data-outcome="answered"]').last()).toContainText('Rest for 3 days');
    await expect(page.locator('[data-outcome="answered"]').last()).toContainText('From: Care after viral fever (version 2, verified 9 Nov 2026)');

    await page.getByLabel('Your question').fill('Can I go swimming this weekend?');
    await page.getByRole('button', { name: 'Ask question' }).click();
    await expect(page.locator('[data-outcome="escalated"]').last()).toContainText("Sent to the follow-up team. You'll hear back by 11 Nov, 4:00 pm.");

    await page.getByLabel('Your question').fill('Can I stop taking the medicine now?');
    await page.getByRole('button', { name: 'Ask question' }).click();
    await expect(page.locator('[data-outcome="refused"]').last()).toContainText('cannot change your treatment');
    await shot(page, 'w3-patient-assistant-escalated-390');
  });

  test('follow-ups: status in words and a hear-back time, never staff notes', async ({ page }) => {
    await setupW3(page, 'patient');
    await page.goto('/patient/follow-ups');
    await expect(page.getByRole('heading', { name: 'Follow-ups', level: 1 })).toBeVisible();
    const open = page.locator('[data-status="open"]');
    await expect(open).toContainText('Waiting for the follow-up team');
    await expect(open).toContainText("You'll hear back by 11 Nov, 2:00 pm.");
    await expect(page.locator('[data-status="resolved"]')).toContainText('Done');
    const text = await page.locator('main').innerText();
    expect(text).not.toContain('Internal');
    expect(text).not.toContain('Rakesh');
    expect(text).not.toContain('No verified instruction covers this');
    expect(await noHorizontalScroll(page)).toBe(true);
    await shot(page, 'w3-patient-followups-390');
  });

  test('patient navigation has the three new pages and reaches them by keyboard', async ({ page }) => {
    await setupW3(page, 'patient');
    await page.goto('/patient/visits');
    const nav = page.getByRole('navigation', { name: 'Patient' });
    for (const name of ['Documents', 'Questions', 'Follow-ups']) await expect(nav.getByRole('link', { name })).toBeVisible();
    await nav.getByRole('link', { name: 'Questions' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/patient\/questions$/);
    await expect(nav.getByRole('link', { name: 'Questions' })).toHaveAttribute('aria-current', 'page');
  });
});
