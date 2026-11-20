import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLiveQueue } from './useQueue';
import { FakeEventSource } from './fakeEventSource';
import { SESSION_ID, entry, staffSnapshot } from './fixtures';

/**
 * B4 defect 9: the live view must never settle one version behind, and never go back to an older version.
 * The fetch mock hands out controllable responses so the tests decide which request answers when, and with what.
 */

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

interface Pending {
  answer: (version: number) => void;
}

describe('live sync version races', () => {
  let inflight: Pending[] = [];
  let calls = 0;

  const snapshotResponse = (version: number) =>
    new Response(JSON.stringify(staffSnapshot({ queueVersion: version, waiting: [entry(15, { projectedPosition: 1 })] })), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  beforeEach(() => {
    inflight = [];
    calls = 0;
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            calls += 1;
            inflight.push({ answer: (version) => resolve(snapshotResponse(version)) });
          }),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Answer the request the page is waiting for. */
  const answerNext = async (version: number) => {
    await waitFor(() => expect(inflight.length).toBeGreaterThan(0));
    const next = inflight.shift();
    await act(async () => next?.answer(version));
  };

  it('refetches again when a notice arrived while an older fetch (not started by that notice) was still in flight', async () => {
    const { result } = renderHook(() => useLiveQueue(SESSION_ID), { wrapper: wrapper() });
    await answerNext(7);
    await waitFor(() => expect(result.current.snapshot?.queueVersion).toBe(7));

    // A reconnect starts a refetch. The server answers it from before the next commit.
    act(() => FakeEventSource.last.open());
    act(() => FakeEventSource.last.fail());
    await new Promise((r) => setTimeout(r, 1100));
    act(() => FakeEventSource.last.open());
    await waitFor(() => expect(calls).toBe(2));

    // Version 8 is committed and its notice arrives while that refetch is still in flight.
    act(() => FakeEventSource.last.emit('queue', notice(8)));
    await answerNext(7);

    // The notice must not be dropped: a further fetch is made and the screen reaches version 8.
    await answerNext(8);
    await waitFor(() => expect(result.current.snapshot?.queueVersion).toBe(8));
    expect(calls).toBe(3);
  });

  it('never goes back to an older queueVersion when a later response is older than the one on screen', async () => {
    const { result } = renderHook(() => useLiveQueue(SESSION_ID), { wrapper: wrapper() });
    await answerNext(7);
    act(() => FakeEventSource.last.open());

    act(() => FakeEventSource.last.emit('queue', notice(8)));
    await answerNext(8);
    await waitFor(() => expect(result.current.snapshot?.queueVersion).toBe(8));

    // A lagging replica answers the next refetch with version 6.
    act(() => FakeEventSource.last.fail());
    await new Promise((r) => setTimeout(r, 1100));
    act(() => FakeEventSource.last.open());
    await answerNext(6);
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.snapshot?.queueVersion).toBe(8);
  });

  it('a notice that arrives while its own fetch is in flight gets one more fetch, then settles', async () => {
    const { result } = renderHook(() => useLiveQueue(SESSION_ID), { wrapper: wrapper() });
    await answerNext(7);
    act(() => FakeEventSource.last.open());

    act(() => FakeEventSource.last.emit('queue', notice(8)));
    await waitFor(() => expect(calls).toBe(2));
    act(() => FakeEventSource.last.emit('queue', notice(9)));

    await answerNext(8);
    await answerNext(9);
    await waitFor(() => expect(result.current.snapshot?.queueVersion).toBe(9));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(3);
  });
});
