import { Skeleton } from '@/components/ui/skeleton';
import { HOSPITAL_NAME } from '@/lib/config';
import { formatIST } from '@/lib/format';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useLiveDisplay, useTodayIST } from '@/live';
import { DisplayColumn } from './DisplayColumn';

/**
 * Public waiting-room display (1920x1080). No auth, tokens only, never names or patient detail.
 * One column per doctor: room, a huge Now calling token, then the next three tokens.
 */
/** At most this many doctors per screen, so tokens stay at 120 px or more. More doctors are shown in pages. */
export const COLUMNS_PER_PAGE = 6;
const DEFAULT_PAGE_SECONDS = 15;

/** Seconds per page: 15, or ?pageSeconds=N for a kiosk that wants another rhythm (1 to 120). */
function pageSeconds(): number {
  const n = Number(new URLSearchParams(window.location.search).get('pageSeconds'));
  return Number.isFinite(n) && n >= 1 && n <= 120 ? n : DEFAULT_PAGE_SECONDS;
}

export default function DisplayPage() {
  const date = useTodayIST();
  const { query, snapshot, status, lastUpdated } = useLiveDisplay(date);
  const reconnecting = status === 'reconnecting';
  const columns = snapshot?.columns ?? [];
  const pages = Math.max(1, Math.ceil(columns.length / COLUMNS_PER_PAGE));
  const [page, setPage] = useState(0);
  const seconds = pageSeconds();
  useEffect(() => {
    if (pages <= 1) return;
    const id = setInterval(() => setPage((p) => (p + 1) % pages), seconds * 1000);
    return () => clearInterval(id);
  }, [pages, seconds]);
  const current = Math.min(page, pages - 1);
  const shown = columns.slice(current * COLUMNS_PER_PAGE, (current + 1) * COLUMNS_PER_PAGE);
  // Up to 3 doctors on a page: one tall column each (140 px tokens). 4 to 6: landscape cards in two rows (120 px).
  // Tokens never go below 120 px; more than 6 doctors page through groups of 6.
  const wide = shown.length >= 4;
  const perRow = wide ? Math.ceil(shown.length / 2) : shown.length;

  return (
    <div className="flex h-dvh min-h-[640px] flex-col overflow-hidden bg-paper">
      <header className="flex h-24 shrink-0 items-center bg-ink px-12 text-white">
        <h1 className="text-4xl font-bold">{HOSPITAL_NAME}</h1>
        <p className="ml-auto text-2xl">Outpatient queue</p>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden p-8">
        {query.isPending && query.failureCount === 0 ? (
          <div className="grid h-full grid-cols-3 gap-8" aria-busy="true" aria-label="Loading the queue">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-full rounded-xl" />
            ))}
          </div>
        ) : !snapshot ? (
          <div role="alert" className="flex h-full flex-col justify-center">
            <p className="text-4xl font-bold">The queue cannot be shown right now</p>
            <p className="mt-3 max-w-4xl text-2xl text-muted-foreground">
              This screen tries again on its own every few seconds. If it stays like this, ask the front desk to check the display connection.
            </p>
          </div>
        ) : columns.length === 0 ? (
          <div className="flex h-full flex-col justify-center">
            <p className="text-4xl font-bold">No sessions are running</p>
            <p className="mt-3 max-w-4xl text-2xl text-muted-foreground">
              Each doctor&apos;s room, the token now being called and the next three tokens appear here when a session starts.
            </p>
          </div>
        ) : (
          <div
            className={cn('grid h-full gap-8', wide && 'grid-rows-2')}
            style={{ gridTemplateColumns: `repeat(${perRow}, minmax(0, 1fr))` }}
          >
            {shown.map((c) => (
              <DisplayColumn key={c.sessionId} column={c} variant={wide ? 'wide' : 'tall'} large={shown.length <= 4} />
            ))}
          </div>
        )}
      </main>

      <footer
        role="status"
        className={cn(
          'flex h-16 shrink-0 items-center gap-6 px-12 text-2xl tabular-nums',
          reconnecting ? 'bg-ink text-white' : 'border-t border-rule text-muted-foreground',
        )}
      >
        {reconnecting ? <span className="font-bold">Reconnecting…</span> : null}
        {pages > 1 ? (
          <span data-testid="display-page" className="font-bold text-ink">
            Page {current + 1} of {pages}
          </span>
        ) : null}
        <span data-testid="last-updated">
          {lastUpdated === null
            ? 'Waiting for the first update'
            : reconnecting
              ? `Showing the queue as of ${formatIST(lastUpdated, 'time-seconds')}`
              : `Last updated ${formatIST(lastUpdated, 'time-seconds')}`}
        </span>
      </footer>
    </div>
  );
}
