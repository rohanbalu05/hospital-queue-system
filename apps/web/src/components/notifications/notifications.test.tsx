import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { StaffShell } from '@/components/layout/Shells';
import { Providers, patientUser, stubApi, testQueryClient, uuid, type Handler } from '@/lib/testing';
import { notificationKeys } from '@/api';
import { bellLabel } from './NotificationBell';
import { safeAppPath } from './NotificationPanel';

afterEach(() => vi.unstubAllGlobals());
beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
});

const me = patientUser(1, 'Ananya Iyer');
const SESSION = uuid(0x5e1);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

interface Row {
  id: string;
  kind: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  link: string | null;
  severity: string;
}

const seed = (): Row[] => [
  { id: uuid(0x901), kind: 'SessionUnavailable', body: 'Dr. Arvind Kulkarni is not available for the rest of this session. Please rebook or cancel.', createdAt: ago(2), readAt: null, link: `/patient/visits?rebook=${uuid(0xa91)}`, severity: 'urgent' },
  { id: uuid(0x902), kind: 'SessionPaused', body: 'Dr. Arvind Kulkarni has stepped away and is expected back about 10:45 am.', createdAt: ago(20), readAt: null, link: `/patient/visit/${SESSION}`, severity: 'warning' },
  { id: uuid(0x903), kind: 'SessionResumed', body: 'Dr. Arvind Kulkarni is back.', createdAt: ago(300), readAt: ago(290), link: null, severity: 'info' },
];

/** A server for /notifications that keeps its own read state, like the real one. */
function notificationsServer(items = seed()) {
  const state = { items, reads: [] as string[], readAll: 0 };
  const handler: Handler = ({ method, path }) => {
    if (path === '/me') return { body: me };
    if (method === 'GET' && path === '/notifications/unread-count') return { body: { unreadCount: state.items.filter((n) => !n.readAt).length } };
    if (method === 'GET' && path === '/notifications') return { body: state.items };
    if (method === 'POST' && path === '/notifications/read-all') {
      const unread = state.items.filter((n) => !n.readAt);
      state.readAll += 1;
      state.items = state.items.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() }));
      return { body: { updated: unread.length } };
    }
    const one = /^\/notifications\/([^/]+)\/read$/.exec(path);
    if (method === 'POST' && one) {
      state.reads.push(one[1] as string);
      state.items = state.items.map((n) => (n.id === one[1] ? { ...n, readAt: n.readAt ?? new Date().toISOString() } : n));
      return { body: {} };
    }
    return undefined;
  };
  return { state, handler };
}

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
}

function renderShell(qc = testQueryClient()) {
  render(
    <Providers qc={qc} initial={['/reception']}>
      <Routes>
        <Route
          path="*"
          element={
            <StaffShell title="Arrivals">
              <Where />
            </StaffShell>
          }
        />
      </Routes>
    </Providers>,
  );
  return qc;
}

describe('bell label', () => {
  it('names the unread count for screen readers', () => {
    expect(bellLabel(0)).toBe('Notifications');
    expect(bellLabel(3)).toBe('Notifications, 3 unread');
  });
});

describe('safeAppPath', () => {
  it('follows in-app paths only', () => {
    expect(safeAppPath('/reception?session=abc')).toBe('/reception?session=abc');
    expect(safeAppPath('https://evil.example/x')).toBeNull();
    expect(safeAppPath('//evil.example/x')).toBeNull();
    expect(safeAppPath(null)).toBeNull();
  });
});

describe('notification centre', () => {
  it('shows the unread count on the bell and lists notices newest first with severity words and times', async () => {
    const { handler } = notificationsServer();
    stubApi(handler);
    renderShell();
    const bell = await screen.findByRole('button', { name: 'Notifications, 2 unread' });
    expect(within(bell).getByTestId('notification-count')).toHaveTextContent('2');

    await userEvent.setup().click(bell);
    const items = await screen.findAllByTestId('notification');
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.getAttribute('data-severity'))).toEqual(['urgent', 'warning', 'info']);
    expect(items.map((i) => i.getAttribute('data-unread'))).toEqual(['true', 'true', 'false']);
    expect(items[0]).toHaveTextContent('Action needed');
    expect(items[0]).toHaveTextContent('2 min ago');
    expect(items[1]).toHaveTextContent('Heads up');
    expect(items[2]).toHaveTextContent('5 h ago');
    // Read items carry no buttons; unread ones with a link carry Open and Mark as read.
    expect(within(items[0] as HTMLElement).getByRole('link', { name: 'Open' })).toBeInTheDocument();
    expect(within(items[0] as HTMLElement).getByRole('button', { name: 'Mark as read' })).toBeInTheDocument();
    expect(within(items[2] as HTMLElement).queryByRole('button', { name: 'Mark as read' })).not.toBeInTheDocument();
  });

  it('Open navigates to the link, marks the notice read and closes the list', async () => {
    const { handler, state } = notificationsServer();
    stubApi(handler);
    renderShell();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Notifications, 2 unread' }));
    const first = (await screen.findAllByTestId('notification'))[0] as HTMLElement;
    await user.click(within(first).getByRole('link', { name: 'Open' }));
    expect(screen.getByTestId('where')).toHaveTextContent(`/patient/visits?rebook=${uuid(0xa91)}`);
    await waitFor(() => expect(state.reads).toEqual([uuid(0x901)]));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByRole('button', { name: 'Notifications, 1 unread' })).toBeInTheDocument();
  });

  it('marks one notice read, and all of them', async () => {
    const { handler, state } = notificationsServer();
    stubApi(handler);
    renderShell();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Notifications, 2 unread' }));
    const second = (await screen.findAllByTestId('notification'))[1] as HTMLElement;
    await user.click(within(second).getByRole('button', { name: 'Mark as read' }));
    await waitFor(() => expect(state.reads).toEqual([uuid(0x902)]));
    await waitFor(() => expect(screen.getAllByTestId('notification')[1]).toHaveAttribute('data-unread', 'false'));

    await user.click(screen.getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(state.readAll).toBe(1));
    await waitFor(() => expect(screen.getByTestId('notification-bell')).toHaveAttribute('aria-label', 'Notifications'));
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeDisabled();
  });

  it('shows "No notifications yet" when there are none', async () => {
    const { handler } = notificationsServer([]);
    stubApi(handler);
    renderShell();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Notifications' }));
    expect(await screen.findByText('No notifications yet')).toBeInTheDocument();
  });

  it('shows an error with a retry when the list cannot be loaded, and keeps the bell working', async () => {
    stubApi(({ path }) => (path === '/me' ? { body: me } : undefined), ({ path }) => (path === '/notifications/unread-count' ? { body: { unreadCount: 1 } } : undefined), ({ path }) =>
      path === '/notifications' ? { status: 500, body: { error: { code: 'INTERNAL', message: 'boom' } } } : undefined,
    );
    renderShell();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    expect(await screen.findByText('Notifications could not be loaded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('opens from the keyboard alone and closes on Escape, returning focus to the bell', async () => {
    const { handler } = notificationsServer();
    stubApi(handler);
    renderShell();
    const user = userEvent.setup();
    const bell = await screen.findByRole('button', { name: 'Notifications, 2 unread' });
    bell.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Notifications' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(bell).toHaveFocus();
  });

  it('refetches the unread count when a live queue snapshot is refreshed by a notice', async () => {
    const { handler, state } = notificationsServer();
    const { calls } = stubApi(handler);
    const qc = renderShell();
    await screen.findByRole('button', { name: 'Notifications, 2 unread' });
    state.items = [{ ...seed()[0], id: uuid(0x904) } as Row, ...state.items];
    const before = calls.filter((c) => c.startsWith('GET /notifications/unread-count')).length;
    await act(async () => {
      // What the live hook does when an SSE notice arrives: the snapshot query is refetched and succeeds.
      qc.setQueryData(['queue', 'snapshot', SESSION], { view: 'patient' });
    });
    await screen.findByRole('button', { name: 'Notifications, 3 unread' });
    expect(calls.filter((c) => c.startsWith('GET /notifications/unread-count')).length).toBeGreaterThan(before);
    expect(qc.getQueryState(notificationKeys.unread)?.status).toBe('success');
  });
});
