import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLiveQueue } from './useQueue';
import { FakeEventSource } from './fakeEventSource';
import { SESSION_ID, entry, staffSnapshot } from './fixtures';

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const notice = (queueVersion: number) => ({
  sessionId: SESSION_ID,
  queueVersion,
  eventType: 'queue.called',
  committedAt: '2026-11-11T04:43:00.000Z',
});

describe('useLiveQueue', () => {
  let version = 7;
  let fetchCount = 0;
  let failNext = false;

  beforeEach(() => {
    version = 7;
    fetchCount = 0;
    failNext = false;
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchCount += 1;
        if (failNext) return new Response('', { status: 503 });
        const snap = staffSnapshot({ queueVersion: version, waiting: [entry(15, { projectedPosition: 1 })] });
        return new Response(JSON.stringify(snap), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads the snapshot, then refetches only when a notice is newer than the version held', async () => {
    const { result } = renderHook(() => useLiveQueue(SESSION_ID), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.snapshot?.queueVersion).toBe(7));
    expect(fetchCount).toBe(1);
    expect(FakeEventSource.last.url).toBe(`/api/sessions/${SESSION_ID}/events`);

    act(() => FakeEventSource.last.open());
    await waitFor(() => expect(result.current.status).toBe('live'));

    // Same or older version: ignored.
    act(() => FakeEventSource.last.emit('queue', notice(7)));
    act(() => FakeEventSource.last.emit('queue', notice(6)));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchCount).toBe(1);

    // Newer: one refetch, and the new version lands.
    version = 8;
    act(() => FakeEventSource.last.emit('queue', notice(8)));
    await waitFor(() => expect(result.current.snapshot?.queueVersion).toBe(8));
    expect(fetchCount).toBe(2);
  });

  it('ignores malformed notices', async () => {
    const { result } = renderHook(() => useLiveQueue(SESSION_ID), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.snapshot).toBeDefined());
    act(() => FakeEventSource.last.open());
    act(() => FakeEventSource.last.emit('queue', 'not json'));
    act(() => FakeEventSource.last.emit('queue', { queueVersion: 'x' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchCount).toBe(1);
  });

  it('always refetches the snapshot after a reconnect (FR-09)', async () => {
    const { result } = renderHook(() => useLiveQueue(SESSION_ID), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.snapshot).toBeDefined());
    act(() => FakeEventSource.last.open());
    expect(fetchCount).toBe(1);

    act(() => FakeEventSource.last.fail());
    await waitFor(() => expect(result.current.status).toBe('stale'));

    version = 9;
    await new Promise((r) => setTimeout(r, 1100));
    act(() => FakeEventSource.last.open());
    await waitFor(() => expect(result.current.snapshot?.queueVersion).toBe(9));
    expect(result.current.status).toBe('live');
    expect(fetchCount).toBe(2);
  });

  it('reports stale while connected if the last refresh failed, and keeps the old data on screen', async () => {
    const { result } = renderHook(() => useLiveQueue(SESSION_ID), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.snapshot).toBeDefined());
    act(() => FakeEventSource.last.open());
    await waitFor(() => expect(result.current.status).toBe('live'));

    failNext = true;
    act(() => FakeEventSource.last.emit('queue', notice(8)));
    await waitFor(() => expect(result.current.status).toBe('stale'));
    expect(result.current.snapshot?.queueVersion).toBe(7);
    expect(result.current.lastUpdated).not.toBeNull();
  });
});
