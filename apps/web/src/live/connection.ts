import { useEffect, useState } from 'react';
import type { StreamStatus } from './stream';

/** A browser that has been offline this long shows the "Reconnecting…" banner (PR-04). */
export const OFFLINE_BANNER_MS = 10_000;

/** Monotonic clock: an offline stretch is measured in elapsed time, whatever the wall clock does. */
const now = () => performance.now();

const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/**
 * Folds the browser's own online/offline state into a live screen's connection status.
 *
 * The SSE stream can sit "open" on a dead socket until the 45 s watchdog trips, so a screen left offline kept a frozen
 * "Last updated" time and said nothing. Offline: stale at once, "reconnecting" after OFFLINE_BANNER_MS. Back online: the
 * stream's own status again (the live hooks also refetch the snapshot on the `online` event).
 *
 * Use it with any StreamStatus: `useLiveQueue` and `useLiveDisplay` already do, so their `status` is the one to read.
 */
export function useConnectionStatus(stream: StreamStatus, graceMs: number = OFFLINE_BANNER_MS): StreamStatus {
  const [offlineSince, setOfflineSince] = useState<number | null>(() => (isOffline() ? now() : null));
  const [, setTick] = useState(0);

  useEffect(() => {
    const goOffline = () => setOfflineSince((since) => since ?? now());
    const goOnline = () => setOfflineSince(null);
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    // The page may have been restored while already offline.
    if (isOffline()) goOffline();
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);

  useEffect(() => {
    if (offlineSince === null) return;
    const remaining = graceMs - (now() - offlineSince);
    if (remaining <= 0) return;
    const id = setTimeout(() => setTick((n) => n + 1), remaining + 1);
    return () => clearTimeout(id);
  }, [offlineSince, graceMs]);

  if (offlineSince === null) return stream;
  if (now() - offlineSince >= graceMs) return 'reconnecting';
  return stream === 'reconnecting' ? 'reconnecting' : 'stale';
}
