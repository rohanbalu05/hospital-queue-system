import { useQuery } from '@tanstack/react-query';
import { fetchDisplaySnapshot, fetchQueueSnapshot, queueKeys, type RoleQueueSnapshot } from '@/api/queue';
import type { DisplaySnapshot } from '@hqms/contracts';
import { useLiveSync } from './useLiveSync';
import type { StreamStatus } from './stream';

/** Safety net for a missed notice: the snapshot is refetched at least once a minute while the screen is open. */
const FALLBACK_POLL_MS = 60_000;

export type LiveStatus = StreamStatus;

export interface LiveInfo {
  /** live: connected. stale: briefly disconnected, or the last refresh failed. reconnecting: disconnected for more than 5 s. */
  status: LiveStatus;
  /** When the snapshot on screen was fetched (ms since epoch), or null before the first one. */
  lastUpdated: number | null;
}

/** GET /sessions/{id}/queue: role-scoped snapshot (view = 'staff' or 'patient'). */
export function useQueueSnapshot(sessionId: string | null) {
  return useQuery({
    queryKey: queueKeys.snapshot(sessionId ?? 'none'),
    queryFn: ({ signal }) => fetchQueueSnapshot(sessionId as string, signal),
    enabled: sessionId !== null,
    refetchInterval: FALLBACK_POLL_MS,
    staleTime: 2_000,
  });
}

function mergeStatus(stream: StreamStatus, refreshFailed: boolean): LiveStatus {
  if (stream === 'live' && refreshFailed) return 'stale';
  return stream;
}

/**
 * GET /sessions/{id}/events: refetch the snapshot whenever a notice carries a newer queueVersion than the one held,
 * and always after a reconnect. Exposes the connection status and when the snapshot was last refreshed.
 */
export function useQueueEvents(sessionId: string | null): LiveInfo {
  const snapshot = useQueueSnapshot(sessionId);
  const stream = useLiveSync<RoleQueueSnapshot>({
    queryKey: queueKeys.snapshot(sessionId ?? 'none'),
    eventsPath: sessionId === null ? null : `/sessions/${encodeURIComponent(sessionId)}/events`,
    isBehind: (notice, cached) => cached === undefined || notice.queueVersion > cached.queueVersion,
  });
  return {
    status: mergeStatus(stream, snapshot.isRefetchError),
    lastUpdated: snapshot.dataUpdatedAt > 0 ? snapshot.dataUpdatedAt : null,
  };
}

/** Snapshot query plus live status in one call. */
export function useLiveQueue(sessionId: string | null) {
  const query = useQueueSnapshot(sessionId);
  const live = useQueueEvents(sessionId);
  return { query, snapshot: query.data, ...live };
}

/** GET /display/sessions?date=: the public display snapshot (tokens only). */
export function useDisplaySnapshot(date: string) {
  return useQuery({
    queryKey: queueKeys.display(date),
    queryFn: ({ signal }) => fetchDisplaySnapshot(date, signal),
    refetchInterval: FALLBACK_POLL_MS,
    staleTime: 2_000,
    // An unattended TV keeps retrying quietly instead of giving up.
    retry: true,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 15_000),
  });
}

/** GET /display/events: notices carry a session id and version; refetch when any column is behind or unknown. */
export function useDisplayEvents(date: string): LiveInfo {
  const snapshot = useDisplaySnapshot(date);
  const stream = useLiveSync<DisplaySnapshot>({
    queryKey: queueKeys.display(date),
    eventsPath: '/display/events',
    isBehind: (notice, cached) => {
      const column = cached?.columns.find((c) => c.sessionId === notice.sessionId);
      return column === undefined || notice.queueVersion > column.queueVersion;
    },
  });
  return {
    status: mergeStatus(stream, snapshot.isRefetchError),
    lastUpdated: snapshot.dataUpdatedAt > 0 ? snapshot.dataUpdatedAt : null,
  };
}

export function useLiveDisplay(date: string) {
  const query = useDisplaySnapshot(date);
  const live = useDisplayEvents(date);
  return { query, snapshot: query.data, ...live };
}
