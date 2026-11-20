import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Session } from '@hqms/contracts';
import { stubApi, testQueryClient, uuid, type Handler } from '@/lib/testing';
import { addDays, istDate } from '@/lib/dates';
import SessionsPage from './SessionsPage';

afterEach(() => vi.unstubAllGlobals());

// Radix Select expects pointer-capture and scrollIntoView, which jsdom lacks.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
});

const TODAY = istDate();
const RAO = { id: uuid(0xd1), fullName: 'Dr. Meenakshi Rao', department: 'General Medicine', room: '12', active: true };
const KULKARNI = { id: uuid(0xd2), fullName: 'Dr. Arvind Kulkarni', department: 'Paediatrics', room: '4', active: true };
const POLICY = {
  id: uuid(0x70),
  version: 1,
  rotation: ['A', 'A', 'W'],
  earlyEligibilityMin: 10,
  lateGraceMin: 15,
  agingTriggerMin: 45,
  calledTimeoutSec: 120,
  ewmaAlpha: 0.2,
  initialEstimateMin: 12,
  defaultBookedCapacity: 10,
  defaultWalkinCapacity: 5,
  createdAt: '2026-11-01T08:00:00+05:30',
};

function session(n: number, over: Partial<Session> = {}): Session {
  return {
    id: uuid(0x100 + n),
    doctorId: RAO.id,
    doctorName: RAO.fullName,
    department: RAO.department,
    room: RAO.room,
    sessionDate: TODAY,
    label: 'morning',
    startsAt: `${TODAY}T23:00:00+05:30`,
    endsAt: `${TODAY}T23:59:00+05:30`,
    slotMinutes: 20,
    status: 'scheduled',
    availability: { state: 'not_started', since: null, expectedBackAt: null, overdue: false, reason: null },
    policyVersion: 1,
    capacity: { bookedCapacity: 10, walkinCapacity: 5, bookedReserved: 2, walkinUsed: 0, bookedAvailable: 8, walkinAvailable: 5 },
    version: 1,
    ...over,
  };
}

const json = (body: unknown, status = 200) => ({ status, body });
const error = (status: number, code: string, message: string, details?: unknown) => ({ status, body: { error: { code, message, ...(details ? { details } : {}) } } });

function render_(...handlers: Handler[]) {
  const api = stubApi(
    (r) => (r.method === 'GET' && r.path === '/doctors' ? json([RAO, KULKARNI]) : undefined),
    (r) => (r.method === 'GET' && r.path === '/policies/current' ? json(POLICY) : undefined),
    ...handlers,
  );
  render(
    <QueryClientProvider client={testQueryClient()}>
      <MemoryRouter>
        <SessionsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return api;
}

const list = (sessions: Session[]): Handler => (r) => (r.method === 'GET' && r.path === '/sessions' ? json(sessions) : undefined);

describe('Sessions page: status and actions', () => {
  it('shows availability words and only the actions that fit each status', async () => {
    const away = session(2, {
      status: 'paused',
      startsAt: `${TODAY}T00:00:01+05:30`,
      endsAt: `${TODAY}T23:59:00+05:30`,
      availability: { state: 'away', since: null, expectedBackAt: `${TODAY}T23:35:00+05:30`, overdue: false, reason: null },
    });
    const unavailable = session(3, {
      doctorName: KULKARNI.fullName,
      status: 'unavailable',
      endsAt: `${TODAY}T23:59:00+05:30`,
      availability: { state: 'unavailable', since: null, expectedBackAt: null, overdue: false, reason: 'Family emergency' },
    });
    const closed = session(4, { status: 'closed', availability: { state: 'ended', since: null, expectedBackAt: null, overdue: false, reason: null } });
    render_(list([session(1), away, unavailable, closed]));

    const rows = await screen.findAllByTestId('session-row');
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText('Not started')).toBeVisible();
    expect(within(rows[0]!).getByRole('button', { name: /Open session, Dr\. Meenakshi Rao/ })).toBeVisible();
    expect(within(rows[0]!).queryByRole('button', { name: /Close session/ })).toBeNull();

    expect(within(rows[1]!).getByText('Away until 11:35 pm')).toBeVisible();
    expect(within(rows[1]!).getByRole('button', { name: /Close session/ })).toBeVisible();
    expect(within(rows[1]!).queryByRole('button', { name: /Reopen session/ })).toBeNull();

    expect(within(rows[2]!).getByText('Unavailable')).toBeVisible();
    expect(within(rows[2]!).getByRole('button', { name: /Reopen session, Dr\. Arvind Kulkarni/ })).toBeVisible();
    expect(within(rows[2]!).getByRole('button', { name: /Close session/ })).toBeVisible();

    expect(within(rows[3]!).getByText('Ended')).toBeVisible();
    expect(within(rows[3]!).queryByRole('button', { name: /Open session|Close session|Reopen session/ })).toBeNull();
    // Edit capacity stays for every row.
    for (const r of rows) expect(within(r).getByRole('button', { name: /Edit capacity/ })).toBeVisible();
  });

  it('opens a session with an Idempotency-Key', async () => {
    const user = userEvent.setup();
    const target = session(1);
    const seen: Array<{ path: string; key: string | null; body: unknown }> = [];
    render_(list([target]), (r) => {
      if (r.method === 'POST' && r.path === `/sessions/${target.id}/open`) {
        seen.push({ path: r.path, key: r.headers.get('Idempotency-Key'), body: r.body });
        return json({ ...target, status: 'open' });
      }
      return undefined;
    });
    await user.click(await screen.findByRole('button', { name: /Open session, Dr\. Meenakshi Rao/ }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[0]!.body).toEqual({});
  });

  it('asks before closing, and says the session cannot be opened again', async () => {
    const user = userEvent.setup();
    const target = session(1, { status: 'open', availability: { state: 'available', since: null, expectedBackAt: null, overdue: false, reason: null } });
    const closes: string[] = [];
    render_(list([target]), (r) => {
      if (r.method === 'POST' && r.path === `/sessions/${target.id}/close`) {
        closes.push(r.path);
        return json({ ...target, status: 'closed' });
      }
      return undefined;
    });
    await user.click(await screen.findByRole('button', { name: /Close session, Dr\. Meenakshi Rao/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Close this session?' });
    expect(dialog).toHaveTextContent('cannot be opened again');
    expect(closes).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Keep session open' }));
    expect(closes).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /Close session, Dr\. Meenakshi Rao/ }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close session' }));
    await waitFor(() => expect(closes).toHaveLength(1));
  });

  it('reopens an unavailable session only with a reason', async () => {
    const user = userEvent.setup();
    const target = session(1, {
      status: 'unavailable',
      endsAt: `${TODAY}T23:59:00+05:30`,
      availability: { state: 'unavailable', since: null, expectedBackAt: null, overdue: false, reason: 'Pressed by mistake' },
    });
    const reopen: Array<{ key: string | null; body: unknown }> = [];
    render_(list([target]), (r) => {
      if (r.method === 'POST' && r.path === `/sessions/${target.id}/reopen`) {
        reopen.push({ key: r.headers.get('Idempotency-Key'), body: r.body });
        return json({ ...target, status: 'open' });
      }
      return undefined;
    });
    await user.click(await screen.findByRole('button', { name: /Reopen session, Dr\. Meenakshi Rao/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Reopen this session' });
    await user.click(within(dialog).getByRole('button', { name: 'Reopen session' }));
    expect(within(dialog).getByText('Give a reason of at least 3 characters.')).toBeVisible();
    expect(reopen).toHaveLength(0);

    await user.type(within(dialog).getByLabelText('Reason'), 'Marked unavailable by mistake');
    await user.click(within(dialog).getByRole('button', { name: 'Reopen session' }));
    await waitFor(() => expect(reopen).toHaveLength(1));
    expect(reopen[0]!.body).toEqual({ reason: 'Marked unavailable by mistake' });
    expect(reopen[0]!.key).toBeTruthy();
  });
});

describe('Sessions page: dates and empty days', () => {
  it('shows an empty day with a New session action, and moves past the seeded week', async () => {
    const user = userEvent.setup();
    const api = render_(list([]));
    expect(await screen.findByRole('heading', { name: /^No sessions on / })).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'New session' }).length).toBeGreaterThanOrEqual(2);
    await user.click(screen.getByRole('button', { name: 'Next day' }));
    await waitFor(() => expect(api.calls.some((c) => c.includes(`date=${addDays(TODAY, 1)}`))).toBe(true));
    expect(await screen.findByRole('heading', { name: /^No sessions on / })).toBeVisible();
  });

  it('shows the chosen date as "Fri, 20 Nov" next to the date field', async () => {
    render_(list([session(1)]));
    await screen.findAllByTestId('session-row');
    expect(screen.getByTestId('session-date-words')).toHaveTextContent(/^[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2}$/);
  });
});

describe('New session dialog', () => {
  async function openDialog(user: ReturnType<typeof userEvent.setup>) {
    await user.click((await screen.findAllByRole('button', { name: 'New session' }))[0]!);
    return screen.findByRole('dialog', { name: 'New session' });
  }
  async function pickDoctor(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, name: string) {
    await user.click(within(dialog).getByRole('combobox', { name: 'Doctor' }));
    await user.click(await screen.findByRole('option', { name: new RegExp(name) }));
  }

  it('fills the label from the start time and the capacity from the current policy', async () => {
    const user = userEvent.setup();
    render_(list([]));
    const dialog = await openDialog(user);
    await waitFor(() => expect(within(dialog).getByLabelText('Booked places')).toHaveValue(10));
    expect(within(dialog).getByLabelText('Walk-in places')).toHaveValue(5);
    expect(within(dialog).getByLabelText('Date')).toHaveValue(TODAY);

    const label = within(dialog).getByTestId('new-session-label');
    for (const [start, word] of [
      ['09:00', 'Morning'],
      ['14:00', 'Afternoon'],
      ['18:30', 'Evening'],
      ['22:00', 'Night'],
    ] as const) {
      const input = within(dialog).getByLabelText('Start time');
      await user.clear(input);
      await user.type(input, start);
      expect(label).toHaveTextContent(word);
    }
  });

  it('creates one session in hospital time with an Idempotency-Key', async () => {
    const user = userEvent.setup();
    const posts: Array<{ key: string | null; body: unknown }> = [];
    render_(list([]), (r) => {
      if (r.method === 'POST' && r.path === '/sessions') {
        posts.push({ key: r.headers.get('Idempotency-Key'), body: r.body });
        return json(session(7), 201);
      }
      return undefined;
    });
    const dialog = await openDialog(user);
    await pickDoctor(user, dialog, 'Meenakshi Rao');
    const start = within(dialog).getByLabelText('Start time');
    await user.clear(start);
    await user.type(start, '09:00');
    const end = within(dialog).getByLabelText('End time');
    await user.clear(end);
    await user.type(end, '13:00');
    await waitFor(() => expect(within(dialog).getByLabelText('Booked places')).toHaveValue(10));
    await user.click(within(dialog).getByRole('button', { name: 'Create session' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({
      doctorId: RAO.id,
      sessionDate: TODAY,
      label: 'morning',
      startsAt: `${TODAY}T09:00:00+05:30`,
      endsAt: `${TODAY}T13:00:00+05:30`,
      bookedCapacity: 10,
      walkinCapacity: 5,
    });
    expect(posts[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull());
  });

  it('needs a doctor and an end time after the start time', async () => {
    const user = userEvent.setup();
    const api = render_(list([]));
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Create session' }));
    expect(within(dialog).getByText('Choose a doctor.')).toBeVisible();
    await pickDoctor(user, dialog, 'Meenakshi Rao');
    const end = within(dialog).getByLabelText('End time');
    await user.clear(end);
    await user.type(end, '08:00');
    await user.click(within(dialog).getByRole('button', { name: 'Create session' }));
    expect(within(dialog).getByText('The end time must be after the start time.')).toBeVisible();
    expect(api.calls.some((c) => c.startsWith('POST /sessions'))).toBe(false);
  });

  it('explains an overlap in plain words with the other session’s times and keeps the form open', async () => {
    const user = userEvent.setup();
    render_(list([]), (r) =>
      r.method === 'POST' && r.path === '/sessions'
        ? error(409, 'CONFLICT', 'Overlaps another session', {
            reason: 'SESSION_OVERLAP',
            overlappingSessionId: uuid(0x55),
            startsAt: `${TODAY}T09:00:00+05:30`,
            endsAt: `${TODAY}T13:00:00+05:30`,
          })
        : undefined,
    );
    const dialog = await openDialog(user);
    await pickDoctor(user, dialog, 'Meenakshi Rao');
    await user.click(within(dialog).getByRole('button', { name: 'Create session' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Session not created');
    expect(alert).toHaveTextContent('Dr. Meenakshi Rao already has a session from 9:00 am to 1:00 pm');
    expect(dialog).toBeVisible();
  });

  it('repeats for the next N days, skips days that fail and lists each day', async () => {
    const user = userEvent.setup();
    const day2 = addDays(TODAY, 1);
    const day3 = addDays(TODAY, 2);
    const posted: string[] = [];
    render_(list([]), (r) => {
      if (r.method === 'POST' && r.path === '/sessions') {
        const body = r.body as { sessionDate: string };
        posted.push(body.sessionDate);
        if (body.sessionDate === day2) {
          return error(409, 'CONFLICT', 'Overlaps another session', {
            reason: 'SESSION_OVERLAP',
            overlappingSessionId: uuid(0x55),
            startsAt: `${day2}T09:00:00+05:30`,
            endsAt: `${day2}T13:00:00+05:30`,
          });
        }
        return json(session(8, { sessionDate: body.sessionDate }), 201);
      }
      return undefined;
    });
    const dialog = await openDialog(user);
    await pickDoctor(user, dialog, 'Meenakshi Rao');
    const start = within(dialog).getByLabelText('Start time');
    await user.clear(start);
    await user.type(start, '09:00');
    const repeat = within(dialog).getByLabelText('Repeat for the next days');
    await user.clear(repeat);
    await user.type(repeat, '2');
    await user.click(within(dialog).getByRole('button', { name: 'Create 3 sessions' }));

    const results = await within(dialog).findAllByTestId('create-result');
    expect(results).toHaveLength(3);
    expect(posted).toEqual([TODAY, day2, day3]);
    expect(results[0]).toHaveTextContent('created');
    expect(results[1]).toHaveTextContent('overlaps Morning 9:00 am to 1:00 pm');
    expect(results[2]).toHaveTextContent('created');
    expect(within(dialog).getByText('2 of 3 sessions created. 1 was skipped.')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull());
  });

  it('refuses a repeat above 13 days', async () => {
    const user = userEvent.setup();
    const api = render_(list([]));
    const dialog = await openDialog(user);
    await pickDoctor(user, dialog, 'Meenakshi Rao');
    const repeat = within(dialog).getByLabelText('Repeat for the next days');
    await user.clear(repeat);
    await user.type(repeat, '20');
    await user.click(within(dialog).getByRole('button', { name: /^Create/ }));
    expect(within(dialog).getByText('Repeat for 0 to 13 days.')).toBeVisible();
    expect(api.calls.some((c) => c.startsWith('POST /sessions'))).toBe(false);
  });
});
