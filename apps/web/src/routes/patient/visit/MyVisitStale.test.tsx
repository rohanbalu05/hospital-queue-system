import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '@/lib/auth';
import { OFFLINE_BANNER_MS } from '@/live/connection';
import { FakeEventSource } from '@/live/fakeEventSource';
import { AVAILABLE, SESSION_ID, uid } from '@/live/fixtures';
import MyVisitPage from './MyVisitPage';

/**
 * PR-04 on the patient's My visit screen: after the browser has been offline for more than 10 s the page says
 * "Reconnecting…" with the time of the snapshot on screen, and when the connection returns it refetches the snapshot
 * and the banner clears.
 */

const eta = { status: 'ok', lowMinutes: 25, highMinutes: 40, note: null, computedAt: '2026-11-11T04:35:00.000Z', estimatorMeanMinutes: 12, estimatorSamples: 3, uncertainty: 'warm' };
const snapshot = (position: number, version: number) => ({
  view: 'patient',
  sessionId: SESSION_ID,
  status: 'open',
  availability: AVAILABLE,
  doctorName: 'Dr. Meenakshi Rao',
  queueVersion: version,
  capturedAt: '2026-11-11T04:35:00.000Z',
  myEntry: { queueEntryId: uid(0xe1), token: 'A-014', group: 'A', state: 'waiting', position, eta },
  nowCalling: 'A-012',
});

function setOnline(value: boolean) {
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(value);
  window.dispatchEvent(new Event(value ? 'online' : 'offline'));
}

let position = 4;
let version = 7;
let snapshotFetches = 0;

beforeEach(() => {
  position = 4;
  version = 7;
  snapshotFetches = 0;
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, '');
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (path === '/me') return json({ userId: uid(9), email: 'p@hqms.test', displayName: 'Ananya Iyer', role: 'patient', patientId: uid(0xa1), doctorId: null, assignedDoctorIds: [] });
      if (path === `/sessions/${SESSION_ID}/queue`) {
        snapshotFetches += 1;
        return json(snapshot(position, version));
      }
      if (path === '/appointments') return json([]);
      return json({ error: { code: 'NOT_FOUND', message: 'Not mocked.' } }, 404);
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/patient/visit/${SESSION_ID}`]}>
        <AuthProvider>
          <Routes>
            <Route path="/patient/visit/:sessionId" element={<MyVisitPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('My visit while offline (PR-04)', () => {
  it('shows Reconnecting… after 10 s offline, then refetches and clears when the connection returns', async () => {
    renderPage();
    expect(await screen.findByText('Number 4')).toBeVisible();
    act(() => FakeEventSource.last.open());
    await waitFor(() => expect(screen.getByText(/^Last updated/)).toBeVisible());
    expect(screen.queryByText('Reconnecting…')).toBeNull();

    // From here the clock is controlled: the offline period is measured against performance.now().
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    act(() => setOnline(false));
    // Offline for less than the grace period: no banner yet.
    act(() => {
      vi.advanceTimersByTime(OFFLINE_BANNER_MS - 1000);
    });
    expect(screen.queryByText('Reconnecting…')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    const banner = screen.getByText('Reconnecting…');
    expect(banner).toBeVisible();
    expect(banner.parentElement).toHaveTextContent(/Showing the queue as of/);
    // The place on screen is the old one.
    expect(screen.getByText('Number 4')).toBeVisible();

    vi.useRealTimers();
    position = 2;
    version = 9;
    const before = snapshotFetches;
    act(() => setOnline(true));
    await waitFor(() => expect(screen.getByText('Number 2')).toBeVisible());
    expect(snapshotFetches).toBeGreaterThan(before);
    expect(screen.queryByText('Reconnecting…')).toBeNull();
  });
});
