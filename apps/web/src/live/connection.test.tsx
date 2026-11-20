import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OFFLINE_BANNER_MS, useConnectionStatus } from './connection';
import { useLiveQueue, useLiveDisplay } from './useQueue';
import { FakeEventSource } from './fakeEventSource';
import { AVAILABLE, SESSION_ID, staffSnapshot } from './fixtures';

/**
 * PR-04: with the browser offline the screens must say so (a stale banner after about 10 s), and when the connection
 * comes back they must refetch the snapshot and clear the banner. The SSE stream alone is not enough: a socket that
 * the browser has not noticed is dead can stay "open" for the 45 s watchdog.
 */

function setOnline(value: boolean) {
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(value);
  window.dispatchEvent(new Event(value ? 'online' : 'offline'));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useConnectionStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('passes the stream status through while the browser is online', () => {
    const { result, rerender } = renderHook(({ s }) => useConnectionStatus(s), { initialProps: { s: 'live' as const } as { s: 'live' | 'stale' | 'reconnecting' } });
    expect(result.current).toBe('live');
    rerender({ s: 'reconnecting' });
    expect(result.current).toBe('reconnecting');
  });

  it('is stale at once when the browser goes offline and reconnecting after the grace period', () => {
    const { result } = renderHook(() => useConnectionStatus('live'));
    act(() => setOnline(false));
    expect(result.current).toBe('stale');
    act(() => {
      vi.advanceTimersByTime(OFFLINE_BANNER_MS - 100);
    });
    expect(result.current).toBe('stale');
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe('reconnecting');
  });

  it('clears as soon as the browser is back online', () => {
    const { result } = renderHook(() => useConnectionStatus('live'));
    act(() => setOnline(false));
    act(() => {
      vi.advanceTimersByTime(OFFLINE_BANNER_MS + 1000);
    });
    expect(result.current).toBe('reconnecting');
    act(() => setOnline(true));
    expect(result.current).toBe('live');
  });
});

describe('live screens while offline', () => {
  let fetchCount = 0;
  let version = 7;

  function wrapper() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  beforeEach(() => {
    fetchCount = 0;
    version = 7;
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        fetchCount += 1;
        const body = String(input).includes('/display/')
          ? { view: 'display', capturedAt: '2026-11-11T04:35:00.000Z', columns: [{ sessionId: SESSION_ID, doctorLabel: 'Dr. Meenakshi Rao, General Medicine', room: 'Room 12', status: 'open', availability: AVAILABLE, nowCalling: null, next: [], queueVersion: version }] }
          : staffSnapshot({ queueVersion: version });
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('the staff queue refetches when the browser comes back online and shows the newer version', async () => {
    const { result } = renderHook(() => useLiveQueue(SESSION_ID), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.snapshot?.queueVersion).toBe(7));
    act(() => FakeEventSource.last.open());
    await waitFor(() => expect(result.current.status).toBe('live'));

    act(() => setOnline(false));
    expect(result.current.status).toBe('stale');
    version = 9;
    act(() => setOnline(true));
    await waitFor(() => expect(result.current.snapshot?.queueVersion).toBe(9));
    expect(fetchCount).toBe(2);
    expect(result.current.status).toBe('live');
  });

  it('the display refetches when the browser comes back online', async () => {
    const { result } = renderHook(() => useLiveDisplay('2026-11-11'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.snapshot?.columns[0]?.queueVersion).toBe(7));
    act(() => FakeEventSource.last.open());
    act(() => setOnline(false));
    version = 8;
    act(() => setOnline(true));
    await waitFor(() => expect(result.current.snapshot?.columns[0]?.queueVersion).toBe(8));
  });
});
