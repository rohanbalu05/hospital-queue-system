import { cn } from '@/lib/utils';
import { formatIST } from '@/lib/format';

export type LiveStatus = 'live' | 'reconnecting';

/** FR-09: a disconnect longer than 5 s shows "Reconnecting…", then a fresh snapshot replaces it. */
export const RECONNECT_AFTER_MS = 5000;

export function deriveLiveStatus(disconnectedSince: number | null, now: number, thresholdMs = RECONNECT_AFTER_MS): LiveStatus {
  return disconnectedSince !== null && now - disconnectedSince > thresholdMs ? 'reconnecting' : 'live';
}

interface StaleBannerProps {
  status: LiveStatus;
  /** When the snapshot on screen was captured. */
  lastUpdated: string | number | Date | null;
  className?: string;
}

export function StaleBanner({ status, lastUpdated, className }: StaleBannerProps) {
  const stamp = lastUpdated === null ? null : formatIST(lastUpdated, 'time-seconds');
  if (status === 'reconnecting') {
    return (
      <p
        role="status"
        className={cn('flex items-center gap-2 rounded-md border border-ink bg-secondary px-3 py-2 text-sm text-ink', className)}
      >
        <span className="font-bold">Reconnecting…</span>
        {stamp ? <span className="tabular-nums">Showing the queue as of {stamp}.</span> : <span>Waiting for the first update.</span>}
      </p>
    );
  }
  return (
    <p role="status" className={cn('text-sm text-muted-foreground tabular-nums', className)}>
      {stamp ? `Last updated ${stamp}` : 'Waiting for the first update'}
    </p>
  );
}
