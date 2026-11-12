/* eslint-disable @typescript-eslint/no-non-null-assertion -- fixtures look up ids this file created */
import { expect, test } from '@playwright/test';
import { setupW3, shot } from './w3-helpers';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const T_RECOVERY = uuid(0x7a01); // acknowledged, mine, overdue, source doctor Dr. Rao
const T_BP = uuid(0x7a03); // open, mine

test.describe('follow-up staff at 1440', () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

  test('inbox: owned tasks first, overdue is a word, closed tasks are hidden until asked for', async ({ page }) => {
    await setupW3(page, 'followup');
    await page.goto('/follow-up');
    await expect(page.getByRole('heading', { name: 'Follow-up tasks', level: 1 })).toBeVisible();

    // Mine: recovery check (overdue), BP call and the document review. Resolved tasks are not listed.
    const rows = page.getByTestId('task-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText('Harish Gowda');
    await expect(rows.first()).toContainText('Overdue 17 h');
    await expect(rows.first()).toHaveAttribute('data-overdue', 'true');
    await expect(rows.nth(1)).toContainText('Lakshmi Narayanan');
    await expect(rows.nth(1)).toContainText('Due in 5 h');
    await expect(page.getByRole('tab', { name: 'Mine (3)' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Unassigned (3)' })).toBeVisible();
    await shot(page, 'w3-followup-inbox-1440');

    // Unassigned: the overdue assistant question stays listed.
    await page.getByRole('tab', { name: /Unassigned/ }).click();
    await expect(rows).toHaveCount(3);
    await expect(page.getByRole('row', { name: /Gopal Krishnan/ })).toContainText('Overdue');

    // All + show closed: the resolved task appears, with no timing.
    await page.getByRole('tab', { name: 'All' }).click();
    await expect(rows).toHaveCount(7);
    await page.getByLabel('Show resolved and cancelled').click();
    await expect(rows).toHaveCount(9);
    await expect(page.getByRole('row', { name: /Sneha Kulkarni.*Resolved/ })).toBeVisible();
  });

  test('inbox states: loading skeleton, empty, error with retry', async ({ page }) => {
    const { w3 } = await setupW3(page, 'followup');
    w3.delayTasksMs = 800;
    await page.goto('/follow-up');
    await expect(page.getByLabel('Loading').first()).toBeVisible();
    await expect(page.getByTestId('task-row').first()).toBeVisible();

    w3.empty = true;
    await page.goto('/follow-up?tab=unassigned');
    await expect(page.getByRole('heading', { name: 'No unassigned tasks' })).toBeVisible();

    w3.empty = false;
    w3.failReads = true;
    await page.goto('/follow-up?tab=all');
    await expect(page.getByRole('alert').filter({ hasText: 'could not be loaded' })).toBeVisible({ timeout: 15_000 });
    w3.failReads = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId('task-row').first()).toBeVisible();
  });

  test('task detail shows the patient, the source and the disposition form', async ({ page }) => {
    await setupW3(page, 'followup');
    await page.goto('/follow-up');
    await page.getByRole('link', { name: 'Harish Gowda' }).click();
    await expect(page).toHaveURL(new RegExp(`/follow-up/tasks/${T_RECOVERY}`));
    await expect(page.getByRole('heading', { name: 'Check recovery after fever visit', level: 1 })).toBeVisible();
    await expect(page.getByText('Wed, 4 Nov, Dr. Meenakshi Rao, General Medicine')).toBeVisible();
    await expect(page.getByText('Overdue 17 h')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Record the outcome' })).toBeVisible();
    await shot(page, 'w3-followup-task-1440');
  });

  test('keyboard only: acknowledge, then resolve with an outcome', async ({ page }) => {
    const { w3 } = await setupW3(page, 'followup');
    await page.goto(`/follow-up/tasks/${T_BP}`);
    const ack = page.getByRole('button', { name: 'Acknowledge', exact: true });
    await expect(ack).toBeVisible();

    // Tab to Acknowledge without the mouse.
    for (let i = 0; i < 20 && !(await ack.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
    await expect(ack).toBeFocused();
    await expect.poll(() => ack.evaluate((el) => getComputedStyle(el).outlineStyle + getComputedStyle(el).boxShadow)).not.toBe('nonenone');
    await page.keyboard.press('Enter');

    // Focus moves to the outcome field. Open it, choose the first option, go to the note, resolve.
    const outcome = page.getByRole('combobox', { name: 'Outcome' });
    await expect(outcome).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.keyboard.press('ArrowDown'); // advice given -> return booked
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(outcome).toContainText('Advice given');
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Outcome note')).toBeFocused();
    await page.keyboard.type('Readings are 128/82 and 132/84. Within range. Asked to continue the tablet.');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Resolve task' })).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('heading', { name: 'Outcome', level: 2, exact: true })).toBeVisible();
    await expect(page.getByText('Advice given', { exact: true })).toBeVisible();
    const task = w3.tasks.find((t) => t.id === T_BP)!;
    expect(task.status).toBe('resolved');
    expect(task.ownerName).toBe('Sunita Hegde');
    expect(w3.requests.map((r) => r.line)).toEqual([`POST /follow-up-tasks/${T_BP}/acknowledge`, `POST /follow-up-tasks/${T_BP}/resolve`]);
  });

  test('resolve asks for an outcome and a note', async ({ page }) => {
    await setupW3(page, 'followup');
    await page.goto(`/follow-up/tasks/${T_RECOVERY}`);
    await page.getByRole('button', { name: 'Resolve task' }).click();
    await expect(page.getByText('Choose what happened.')).toBeVisible();
    await expect(page.getByText('Add a short outcome note, at least 3 characters.')).toBeVisible();
  });

  test('book return visit: picks a session, books through capacity, prefills the outcome', async ({ page }) => {
    const { w3, sched } = await setupW3(page, 'followup');
    await page.goto(`/follow-up/tasks/${T_RECOVERY}`);
    await page.getByRole('button', { name: 'Book return visit' }).click();
    const dialog = page.getByRole('dialog', { name: 'Book return visit' });
    await expect(dialog).toBeVisible();
    // The doctor from the source visit is preselected; full sessions are disabled and say so.
    await expect(dialog.getByRole('combobox', { name: 'Doctor' })).toContainText('Dr. Meenakshi Rao');
    await expect(dialog.getByText('Full, 0 of 10 places left').first()).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Book return visit' })).toBeDisabled();
    await shot(page, 'w3-followup-return-1440', false);

    // Choose by keyboard: Tab into the list, arrow to a free session.
    // A return visit is for a later day: pick Thursday's afternoon session, not one that is today.
    const free = dialog.getByRole('radio', { name: /Thu, 12 Nov.*Afternoon/ });
    await free.click();
    await dialog.getByRole('button', { name: 'Book return visit' }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole('combobox', { name: 'Outcome' })).toContainText('Return booked');
    await expect(page.getByLabel('Outcome note')).toHaveValue(/^Return visit booked: .* with Dr\. Meenakshi Rao\.$/);
    await expect(page.getByLabel('Outcome note')).toBeFocused();
    const call = w3.requests.find((r) => r.line.endsWith('/return-booking'))!;
    expect(call.key).toBeTruthy();
    expect(sched.appointments.some((a) => a.followUpTaskId === T_RECOVERY)).toBe(true);
    await expect(page.getByText(/Thu, 12 Nov/).first()).toBeVisible();
    await shot(page, 'w3-followup-return-booked-1440');

    await page.getByRole('button', { name: 'Resolve task' }).click();
    await expect(page.getByText('Resolved').first()).toBeVisible();
    expect(w3.tasks.find((t) => t.id === T_RECOVERY)!.disposition).toBe('return_booked');
  });

  test('book return visit: a full session is an explicit CAPACITY_FULL message, nothing booked', async ({ page }) => {
    const { w3, sched } = await setupW3(page, 'followup');
    await page.goto(`/follow-up/tasks/${T_RECOVERY}`);
    await page.getByRole('button', { name: 'Book return visit' }).click();
    const dialog = page.getByRole('dialog', { name: 'Book return visit' });
    w3.failReturnBookingFull = true;
    await dialog.getByRole('radio').filter({ hasNot: page.locator('[disabled]') }).first().click();
    await dialog.getByRole('button', { name: 'Book return visit' }).click();
    await expect(dialog.getByRole('alert')).toContainText('That session is full');
    await expect(dialog.getByRole('alert')).toContainText('Nobody was booked');
    expect(sched.appointments.some((a) => a.followUpTaskId === T_RECOVERY)).toBe(false);
    await expect(dialog.getByRole('button', { name: 'Book return visit' })).toBeDisabled();
  });

  test('cancel needs a reason and removes the task from the open list', async ({ page }) => {
    const { w3 } = await setupW3(page, 'followup');
    await page.goto(`/follow-up/tasks/${T_BP}`);
    await page.getByRole('button', { name: 'Cancel task' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cancel this task' });
    await dialog.getByRole('button', { name: 'Cancel task' }).click();
    await expect(dialog.getByText('Say why the task is being cancelled')).toBeVisible();
    await dialog.getByLabel('Reason').fill('Patient was seen in person today');
    await dialog.getByRole('button', { name: 'Cancel task' }).click();
    await expect(dialog).toBeHidden();
    expect(w3.tasks.find((t) => t.id === T_BP)!.status).toBe('cancelled');
  });
});
