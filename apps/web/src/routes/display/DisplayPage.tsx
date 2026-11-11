import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { HOSPITAL_NAME } from '@/lib/config';
import { formatIST } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useLiveDisplay, useTodayIST } from '@/live';
import { DisplayColumn } from './DisplayColumn';

/**
 * Public waiting-room display (1920x1080). No auth, tokens only, never names or patient detail.
 * One column per doctor: room, a huge Now calling token, then the next three tokens.
 */
export default function DisplayPage() {
  const date = useTodayIST();
  const { query, snapshot, status, lastUpdated } = useLiveDisplay(date);
  const reconnecting = status === 'reconnecting';
  const columns = snapshot?.columns ?? [];
  const dense = columns.length > 4;

  return (
    <div className="flex h-dvh min-h-[640px] flex-col overflow-hidden bg-paper">
      <header className="flex h-24 shrink-0 items-center bg-ink px-12 text-white">
        <h1 className="text-4xl font-bold">{HOSPITAL_NAME}</h1>
        <p className="ml-auto text-2xl">Outpatient queue</p>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden p-8">
        {query.isPending ? (
          <div className="grid h-full grid-cols-3 gap-8" aria-busy="true" aria-label="Loading the queue">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-full rounded-xl" />
            ))}
          </div>
        ) : !snapshot ? (
          <div role="alert" className="flex h-full flex-col justify-center">
            <p className="text-4xl font-bold">The queue cannot be shown right now</p>
            <p className="mt-3 max-w-4xl text-2xl text-muted-foreground">
              This screen keeps trying. If it stays like this, ask the front desk to check the display connection.
            </p>
            <Button className="mt-6 h-14 w-fit px-8 text-lg" variant="outline" onClick={() => void query.refetch()}>
              Try again
            </Button>
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
            className={cn('grid h-full gap-8', dense ? 'auto-rows-fr' : '')}
            style={{ gridTemplateColumns: `repeat(${Math.min(columns.length, 4)}, minmax(0, 1fr))` }}
          >
            {columns.map((c) => (
              <DisplayColumn key={c.sessionId} column={c} dense={dense} />
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
