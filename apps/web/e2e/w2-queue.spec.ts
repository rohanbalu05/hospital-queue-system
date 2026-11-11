/* eslint-disable @typescript-eslint/no-non-null-assertion -- specs assert on values the mock just created */
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { mockApi } from './mocks';
import { ETA_WITHHELD, SESSION_ID, installFakeEventSource, mockQueue, type QueueMock, type QueueMockOptions } from './mocks-queue';

const SHOTS = path.resolve(import.meta.dirname, '../../../docs/evidence/screenshots');
const shot = (page: Page, name: string, fullPage = true) => page.screenshot({ path: path.join(SHOTS, `w2-${name}.png`), fullPage });

type Role = 'doctor' | 'patient' | 'reception' | null;

async function setup(page: Page, role: Role, options: QueueMockOptions = {}): Promise<QueueMock> {
  await installFakeEventSource(page);
  await mockApi(page, role);
  return mockQueue(page, options);
}

const callNext = (page: Page) => page.getByRole('button', { name: /^Call next/ });
const start = (page: Page) => page.getByRole('button', { name: 'Start', exact: true });
const complete = (page: Page) => page.getByRole('button', { name: 'Complete', exact: true });

async function doctorReady(page: Page) {
  await expect(page.getByRole('heading', { name: 'Doctor console', level: 1 })).toBeVisible();
  await expect(callNext(page)).toBeVisible();
  await expect(page.getByText('Waiting, in call order')).toBeVisible();
  // SSE is open once the status line reads "Last updated".
  await expect(page.getByText(/Last updated/)).toBeVisible();
}

async function expectInkFocusRing(page: Page, locator: ReturnType<Page['getByRole']>) {
  await expect.poll(() => locator.evaluate((el) => `${getComputedStyle(el).boxShadow} ${getComputedStyle(el).outlineColor}`)).toContain('rgb(22, 35, 43)');
}

test.describe('doctor console at 1280', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('keyboard only: N, Enter, reason, Start, Complete (NFR-08-b)', async ({ page }) => {
    const mock = await setup(page, 'doctor');
    await page.goto('/doctor');
    await doctorReady(page);

    // Nothing is clicked from here on. N jumps to Call next; Enter calls.
    await page.keyboard.press('n');
    await expect(callNext(page)).toBeFocused();
    await expectInkFocusRing(page, callNext(page));
    await page.keyboard.press('Enter');

    // The reason is shown in words with the policy version, and focus moves to Start.
    const decision = page.getByTestId('decision');
    await expect(decision).toContainText('Called by rotation: 2nd appointment of A, A, W');
    await expect(decision).toContainText('Rotation');
    await expect(decision).toContainText('Policy v1');
    await expect(start(page)).toBeFocused();
    await expect(page.getByTestId('now-active')).toContainText('A-014');
    await expect(page.getByTestId('now-active')).toContainText('Harish Gowda');
    await expect(page.getByTestId('now-state')).toContainText('Called');
    await expect(callNext(page)).toHaveAttribute('aria-disabled', 'true');
    await shot(page, 'doctor-1280');

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('now-state')).toContainText('In service');
    await expect(complete(page)).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.getByText('No patient with you')).toBeVisible();
    await expect(callNext(page)).toBeFocused();

    // Call next sent an Idempotency-Key; start and complete carried the entry version.
    const call = mock.requests.find((r) => r.line.endsWith('/call-next'));
    expect(call?.key).toBeTruthy();
    expect(mock.requests.find((r) => r.line.endsWith('/start'))?.body).toMatchObject({ expectedVersion: 2 });
    expect(mock.requests.some((r) => r.line.endsWith('/complete'))).toBe(true);
  });

  test('keyboard only: Tab reaches Call next without a mouse', async ({ page }) => {
    await setup(page, 'doctor');
    await page.goto('/doctor');
    await doctorReady(page);
    let reached = false;
    for (let i = 0; i < 30 && !reached; i += 1) {
      await page.keyboard.press('Tab');
      reached = await callNext(page).evaluate((el) => el === document.activeElement);
    }
    expect(reached).toBe(true);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('decision')).toBeVisible();
  });

  test('N does nothing while typing in a dialog field', async ({ page }) => {
    await setup(page, 'doctor');
    await page.goto('/doctor');
    await doctorReady(page);
    await page.getByRole('button', { name: 'Pause session' }).click();
    const reason = page.getByLabel('Reason (optional)');
    await reason.fill('');
    await reason.press('n');
    await expect(reason).toHaveValue('n');
    await expect(reason).toBeFocused();
  });

  test('the waiting list is in projected order with a P tag after priority is set', async ({ page }) => {
    const mock = await setup(page, 'doctor');
    await page.goto('/doctor');
    await doctorReady(page);
    const rows = page.getByRole('region', { name: 'Waiting, in call order' }).getByRole('listitem');
    await expect(rows.first()).toContainText('A-014');
    await expect(rows.nth(1)).toContainText('W-005');

    await page.getByRole('button', { name: /Actions for W-006/ }).click();
    await page.getByRole('menuitem', { name: 'Set priority' }).click();
    const dialog = page.getByRole('dialog', { name: 'Set priority for W-006' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Priority is a clinical decision');
    await page.waitForTimeout(500); // let the dialog finish its open animation
    await shot(page, 'priority-dialog-1280', false);

    // Too-short reason is refused with a message, nothing is sent.
    await dialog.getByLabel('Reason').fill('hi');
    await dialog.getByRole('button', { name: 'Set priority' }).click();
    await expect(dialog.getByRole('alert')).toContainText('at least 3 characters');
    expect(mock.requests.some((r) => r.line.endsWith('/priority'))).toBe(false);

    await dialog.getByLabel('Reason').fill('Chest pain on arrival');
    await dialog.getByRole('button', { name: 'Set priority' }).click();
    await expect(dialog).toBeHidden();
    expect(mock.requests.find((r) => r.line.endsWith('/priority'))?.body).toMatchObject({ priorityClass: 1, reason: 'Chest pain on arrival' });
    await expect(rows.first()).toContainText('W-006');
    await expect(rows.first().locator('[data-group="P"]')).toBeVisible();
  });

  test('mark absent moves the patient to the skipped list, and Re-enter brings them back', async ({ page }) => {
    await setup(page, 'doctor');
    await page.goto('/doctor');
    await doctorReady(page);
    await page.getByRole('button', { name: /Actions for A-017/ }).click();
    await page.getByRole('menuitem', { name: 'Mark absent' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Mark absent' }).click();
    const skipped = page.getByRole('region', { name: 'Skipped or absent' });
    await expect(skipped).toContainText('A-017');
    await expect(skipped).toContainText('Absent');
    await skipped.getByRole('button', { name: /Re-enter A-017/ }).click();
    await expect(page.getByRole('region', { name: 'Waiting, in call order' })).toContainText('A-017');
  });

  test('pause with unknown duration, then resume', async ({ page }) => {
    const mock = await setup(page, 'doctor');
    await page.goto('/doctor');
    await doctorReady(page);
    await page.getByRole('button', { name: 'Pause session' }).click();
    const dialog = page.getByRole('dialog', { name: 'Pause session' });
    await expect(dialog).toContainText('Unknown duration withholds patient estimates');
    await dialog.getByRole('button', { name: 'Pause session' }).click();
    await expect(page.getByTestId('session-status')).toContainText('No resume time set');
    expect(mock.requests.find((r) => r.line.endsWith('/pause'))?.body).toEqual({});
    await expect(callNext(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByText('The session is paused. Resume it to call the next patient.')).toBeVisible();
    await page.getByRole('button', { name: 'Resume session' }).click();
    await expect(page.getByTestId('session-status')).toBeHidden();
    await expect(callNext(page)).toHaveAttribute('aria-disabled', 'false');
  });

  test('pause until a time sends an IST instant', async ({ page }) => {
    const mock = await setup(page, 'doctor');
    await page.goto('/doctor');
    await doctorReady(page);
    await page.getByRole('button', { name: 'Pause session' }).click();
    const dialog = page.getByRole('dialog', { name: 'Pause session' });
    await dialog.getByLabel('Back at (optional)').fill('09:30');
    await dialog.getByRole('button', { name: 'Pause session' }).click();
    await expect(dialog.getByRole('alert')).toContainText('later than now');
    await dialog.getByLabel('Back at (optional)').fill('10:30');
    await dialog.getByRole('button', { name: 'Pause session' }).click();
    await expect(page.getByTestId('session-status')).toContainText('Back at 10:30 am');
    expect(mock.requests.find((r) => r.line.endsWith('/pause'))?.body).toEqual({ until: '2026-11-11T05:00:00.000Z' });
  });

  test('mark unavailable asks for a reason and says patients are not reassigned', async ({ page }) => {
    await setup(page, 'doctor');
    await page.goto('/doctor');
    await doctorReady(page);
    await page.getByRole('button', { name: 'Mark unavailable' }).click();
    const dialog = page.getByRole('dialog', { name: 'Mark session unavailable' });
    await expect(dialog).toContainText('not reassigned to another doctor');
    await dialog.getByRole('button', { name: 'Mark unavailable' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await dialog.getByLabel('Reason').fill('Called to emergency theatre');
    await dialog.getByRole('button', { name: 'Mark unavailable' }).click();
    await expect(page.getByTestId('session-status')).toContainText('Session marked unavailable');
  });

  test('a notice from another screen refreshes the queue without a reload; a 409 shows the real state', async ({ page }) => {
    const mock = await setup(page, 'doctor');
    await page.goto('/doctor');
    await doctorReady(page);
    const waiting = page.getByRole('region', { name: 'Waiting, in call order' });
    await expect(waiting).not.toContainText('Divya Shenoy');

    // Reception admits a walk-in elsewhere; the doctor's screen follows the SSE notice.
    mock.world.waiting.push({ ...mock.world.waiting[0]!, id: '00000000-0000-4000-8000-00000000e999', visitId: '00000000-0000-4000-8000-00000000f999', token: 'W-007', group: 'W', patientName: 'Divya Shenoy' });
    await mock.publish();
    await expect(waiting).toContainText('Divya Shenoy');

    // Reception called someone from the same doctor in another tab: our Call next hits DOCTOR_OCCUPIED.
    mock.world.active = { ...mock.world.waiting.shift()!, state: 'called', calledAt: '2026-11-11T04:34:00.000Z' };
    await callNext(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Call next failed')).toBeVisible();
    await expect(page.getByTestId('now-active')).toContainText('A-014');
  });

  test('loading, error and empty states', async ({ page }) => {
    const mock = await setup(page, 'doctor', { failQueue: true });
    await page.goto('/doctor');
    await expect(page.getByRole('alert')).toContainText('The queue could not be loaded');
    mock.world.failQueue = false;
    mock.world.waiting = [];
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByText('No one is waiting. Patients appear here once they check in or are admitted as walk-ins.')).toBeVisible();
    await expect(callNext(page)).toHaveAttribute('aria-disabled', 'true');
  });

  test('paused session screenshot', async ({ page }) => {
    await setup(page, 'doctor', { status: 'paused' });
    await page.goto('/doctor');
    await expect(page.getByTestId('session-status')).toContainText('Session paused');
    await expect(page.getByRole('button', { name: 'Resume session' })).toBeVisible();
    await shot(page, 'doctor-paused-1280');
  });
});

test.describe('doctor console on a tablet', () => {
  test.use({ viewport: { width: 1024, height: 768 } });
  test('screenshot with a patient in service', async ({ page }) => {
    const mock = await setup(page, 'doctor');
    await page.goto('/doctor');
    await doctorReady(page);
    await callNext(page).focus();
    await page.keyboard.press('Enter');
    await expect(start(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('now-state')).toContainText('In service');
    expect(mock.world.active?.state).toBe('in_service');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, 'doctor-1024');
  });
});

test.describe('session board', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test('lanes, capacity bar and row selection by keyboard', async ({ page }) => {
    const mock = await setup(page, 'reception');
    mock.world.active = { ...mock.world.waiting.shift()!, state: 'called', calledAt: '2026-11-11T04:33:00.000Z' };
    await page.goto('/_dev/board');
    const board = page.getByRole('heading', { name: 'Waiting, appointment' });
    await expect(board).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Waiting, walk-in' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Called', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'In service' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Skipped or absent' })).toBeVisible();
    await expect(page.getByText('8', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Last updated/)).toBeVisible();

    const row = page.getByRole('button', { name: /W-005/ });
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    await shot(page, 'board-1440');
  });
});

test.describe('waiting-room display at 1920', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('one column per doctor, tokens only; a new call highlights the token; screenshot', async ({ page }) => {
    const mock = await setup(page, null);
    await page.goto('/display');
    await expect(page.getByTestId('display-column')).toHaveCount(4);
    await expect(page.getByTestId('last-updated')).toContainText('Last updated 10:05:00 am');
    await expect(page.getByTestId('display-column').nth(1).getByTestId('now-calling')).toHaveText('A-022');
    await expect(page.getByTestId('display-column').nth(3)).toContainText('Doctor has paused');
    await shot(page, 'display-1920');

    // The doctor calls A-014: the first column's token changes and flashes.
    mock.world.active = { ...mock.world.waiting.shift()!, state: 'called' };
    await mock.publish();
    const first = page.getByTestId('display-column').first();
    await expect(first.getByTestId('now-calling')).toHaveText('A-014');
    await expect(first.getByTestId('now-calling')).toHaveClass(/animate-token-called/);
    await expect(first.getByTestId('next-tokens')).toContainText('W-005');
    await expect(first.getByTestId('next-tokens').getByRole('listitem')).toHaveCount(3);

    // Never names or other patient detail.
    const text = await page.locator('body').innerText();
    for (const name of ['Harish', 'Rohan', 'Lakshmi', 'Ananya', 'Iyer', 'Deshpande', 'Narayanan']) expect(text).not.toContain(name);
  });

  test('three doctors fit as tall columns with 140 px tokens', async ({ page }) => {
    const mock = await setup(page, null);
    mock.world.columns = [
      { sessionId: '00000000-0000-4000-8000-000000005e61', doctorLabel: 'Dr. Arvind Kulkarni, Paediatrics', room: 'Room 4', status: 'open', nowCalling: 'A-022', next: ['A-023', 'W-009', 'A-024'], queueVersion: 12 },
      { sessionId: '00000000-0000-4000-8000-000000005e62', doctorLabel: 'Dr. Farah Siddiqui, ENT', room: 'Room 7', status: 'open', nowCalling: 'W-011', next: ['A-031', 'A-032', 'W-012'], queueVersion: 5 },
    ];
    mock.world.active = { ...mock.world.waiting.shift()!, state: 'called' };
    await page.goto('/display');
    await expect(page.getByTestId('display-column')).toHaveCount(3);
    const token = page.getByTestId('now-calling').nth(2);
    await expect(token).toHaveText('W-011');
    expect(await token.evaluate((el) => getComputedStyle(el).fontSize)).toBe('140px');
    // Nothing is clipped: the token fits inside its column.
    const box = await token.boundingBox();
    const col = await page.getByTestId('display-column').nth(2).boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(col!.x + col!.width);
    await shot(page, 'display-3doctors-1920');
  });

  test('Reconnecting… appears after 5 s without a connection and clears with a fresh snapshot', async ({ page }) => {
    const mock = await setup(page, null);
    await page.goto('/display');
    await expect(page.getByTestId('display-column')).toHaveCount(4);
    const before = mock.requests.filter((r) => r.line === 'GET /display/sessions').length;

    await mock.disconnect();
    await expect(page.getByText('Reconnecting…')).toBeHidden();
    await expect(page.getByText('Reconnecting…')).toBeVisible({ timeout: 9000 });
    await expect(page.getByTestId('last-updated')).toContainText('Showing the queue as of 10:05:00 am');
    await shot(page, 'display-reconnecting-1920');

    // While we were away a patient was called; reconnecting must fetch a fresh snapshot (FR-09).
    mock.world.active = { ...mock.world.waiting.shift()!, state: 'called' };
    mock.world.version += 1;
    await mock.reconnect();
    await expect(page.getByText('Reconnecting…')).toBeHidden({ timeout: 20_000 });
    await expect(page.getByTestId('display-column').first().getByTestId('now-calling')).toHaveText('A-014');
    expect(mock.requests.filter((r) => r.line === 'GET /display/sessions').length).toBeGreaterThan(before);
  });

  test('error state keeps trying and says what to do', async ({ page }) => {
    const mock = await setup(page, null);
    mock.world.failDisplay = true;
    await page.goto('/display');
    await expect(page.getByRole('alert')).toContainText('The queue cannot be shown right now');
    mock.world.failDisplay = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId('display-column')).toHaveCount(4);
  });
});

test.describe('display over a real text/event-stream', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('consumes server-sent events and refreshes without a reload', async ({ page }) => {
    // No fake EventSource here: the browser's own EventSource reads a mocked event stream.
    await mockApi(page, null);
    const mock = await mockQueue(page);
    let sendNotice = false;
    await page.route('**/api/display/events', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: sendNotice
          ? `event: queue\ndata: ${JSON.stringify({ sessionId: SESSION_ID, queueVersion: 99, eventType: 'queue.called', committedAt: '2026-11-11T04:35:00.000Z' })}\n\n`
          : ': connected\n\nevent: ping\ndata: {}\n\n',
      }),
    );
    await page.goto('/display');
    const first = page.getByTestId('display-column').first();
    await expect(first).toBeVisible();
    await expect(first.getByTestId('now-calling-idle')).toBeVisible();

    mock.world.active = { ...mock.world.waiting.shift()!, state: 'called' };
    mock.world.version = 99;
    sendNotice = true;
    await expect(first.getByTestId('now-calling')).toHaveText('A-014', { timeout: 15_000 });
  });
});

test.describe('my visit on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

  test('token, state in words, position and an ETA range', async ({ page }) => {
    const mock = await setup(page, 'patient', { view: 'patient' });
    await page.goto(`/patient/visit/${SESSION_ID}`);
    await expect(page.getByRole('heading', { name: 'My visit', level: 1 })).toBeVisible();
    await expect(page.getByText('A-016').first()).toBeVisible();
    await expect(page.getByTestId('visit-state')).toHaveText('You are in the queue');
    await expect(page.getByTestId('position')).toContainText('Number 4');
    await expect(page.getByTestId('position')).toContainText('3 ahead of you');
    await expect(page.getByTestId('eta')).toContainText('about 25–40 min');
    await expect(page.getByTestId('eta')).toContainText('Early estimate: few consultations recorded yet');
    await expect(page.getByText('Now calling')).toBeVisible();
    await expect(page.getByText(/Last updated 10:05:00 am/)).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, 'myvisit-390');

    // Live: the position moves when the server says so; no reload.
    mock.world.patient.position = 2;
    await mock.publish();
    await expect(page.getByTestId('position')).toContainText('Number 2');
  });

  test('estimate paused when the ETA is withheld', async ({ page }) => {
    const mock = await setup(page, 'patient', { view: 'patient', status: 'paused' });
    mock.world.patient.eta = ETA_WITHHELD;
    await page.goto(`/patient/visit/${SESSION_ID}`);
    await expect(page.getByTestId('eta')).toContainText('Estimate paused');
    await expect(page.getByTestId('eta')).toContainText('Doctor paused (unknown duration)');
    await expect(page.getByTestId('eta')).not.toContainText('about');
    await expect(page.getByRole('status').filter({ hasText: 'paused this session' })).toBeVisible();
    await shot(page, 'myvisit-withheld-390');
  });

  test('called state tells the patient what to do; the stale banner shows when disconnected', async ({ page }) => {
    const mock = await setup(page, 'patient', { view: 'patient' });
    mock.world.patient.state = 'called';
    mock.world.patient.position = null;
    await page.goto(`/patient/visit/${SESSION_ID}`);
    await expect(page.getByTestId('visit-state')).toHaveText('It is your turn');
    await expect(page.getByTestId('eta')).toHaveCount(0);
    await mock.disconnect();
    await expect(page.getByText('Reconnecting…')).toBeVisible({ timeout: 9000 });
  });

  test('unknown session shows a plain error', async ({ page }) => {
    const mock = await setup(page, 'patient', { view: 'patient', failQueue: true });
    await page.goto(`/patient/visit/${SESSION_ID}`);
    await expect(page.getByRole('alert')).toContainText('Your visit could not be loaded');
    mock.world.failQueue = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId('visit-state')).toBeVisible();
  });
});
