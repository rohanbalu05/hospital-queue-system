import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { QueueVersionNotice } from '@hqms/contracts';
import { API_BASE } from '@/lib/api';
import { useStream } from './useStream';
import type { StreamOptions, StreamStatus } from './stream';

/** Fetches made for one notice before giving up on a server that keeps answering with an older version. */
const MAX_ROUNDS = 3;

export interface LiveSyncArgs<T> {
  /** Query key of the snapshot this stream keeps fresh. */
  queryKey: QueryKey;
  /** Path of the SSE endpoint, without the /api prefix. Null disables the stream. */
  eventsPath: string | null;
  /** True when the notice says the cached snapshot is behind (e.g. notice.queueVersion > held version). */
  isBehind: (notice: QueueVersionNotice, cached: T | undefined) => boolean;
  options?: StreamOptions;
}

/**
 * FR-09 in one hook: subscribe to SSE, refetch the snapshot when a notice is newer than what is held,
 * and always refetch after a reconnect. A notice that arrives while a refetch is in flight still gets its own refetch,
 * so the screen never settles one version behind. Returns the connection status.
 */
export function useLiveSync<T>({ queryKey, eventsPath, isBehind, options }: LiveSyncArgs<T>): StreamStatus {
  const qc = useQueryClient();
  const keyRef = useRef(queryKey);
  const behindRef = useRef(isBehind);
  keyRef.current = queryKey;
  behindRef.current = isBehind;
  const pending = useRef(new Map<string, QueueVersionNotice>());
  const running = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const drain = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      // A refetch that was already in flight when a notice arrived is joined, and it may have been served from before
      // that notice's commit. So after every round, a notice the held snapshot is still behind stays queued and
      // gets a fresh fetch. The round cap stops a server that keeps answering with an older version from being hammered
      // (the one-minute poll and the next notice are the safety net then).
      const rounds = new Map<string, number>();
      while (alive.current && pending.current.size > 0) {
        const batch = new Map(pending.current);
        await qc.refetchQueries({ queryKey: keyRef.current, exact: true }, { cancelRefetch: false });
        if (qc.getQueryState(keyRef.current)?.status === 'error') break;
        const held = qc.getQueryData<T>(keyRef.current);
        for (const [id, notice] of batch) {
          if (pending.current.get(id) !== notice) continue; // a newer notice for this session arrived meanwhile: keep it
          const round = (rounds.get(id) ?? 0) + 1;
          rounds.set(id, round);
          if (!behindRef.current(notice, held) || round >= MAX_ROUNDS) pending.current.delete(id);
        }
      }
    } finally {
      running.current = false;
    }
  }, [qc]);

  const onEvent = useCallback(
    (name: string, data: string) => {
      if (name !== 'queue') return;
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      const parsed = QueueVersionNotice.safeParse(json);
      if (!parsed.success) return;
      const notice = parsed.data;
      const cached = qc.getQueryData<T>(keyRef.current);
      if (!behindRef.current(notice, cached)) return;
      pending.current.set(notice.sessionId, notice);
      void drain();
    },
    [qc, drain],
  );

  const onReconnect = useCallback(() => {
    void qc.refetchQueries({ queryKey: keyRef.current, exact: true });
  }, [qc]);

  return useStream({
    url: eventsPath === null ? null : `${API_BASE}${eventsPath}`,
    onEvent,
    onReconnect,
    ...(options ? { options } : {}),
  });
}
