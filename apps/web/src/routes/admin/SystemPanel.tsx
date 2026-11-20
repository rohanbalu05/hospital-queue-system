import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { SystemStatus } from '@hqms/contracts';
import { SYSTEM_REFRESH_MS, useSystemStatus } from '@/api';
import { ErrorState } from '@/components/queue';
import { Skeleton } from '@/components/ui/skeleton';
import { formatIST } from '@/lib/format';
import { cn } from '@/lib/utils';

export { SYSTEM_REFRESH_MS };

/** "40 s", "13 min", "3 h 20 min": how long the oldest item has waited. */
export function ageWords(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

const withOldest = (count: number, oldestSeconds: number | null) =>
  count > 0 && oldestSeconds !== null ? `${count}, oldest waiting ${ageWords(oldestSeconds)}` : String(count);

function Stat({ id, label, attention, children }: { id: string; label: string; attention: boolean; children: ReactNode }) {
  return (
    <div className="grid content-start gap-0.5 border-l-[3px] border-l-rule pl-3 data-[attention=true]:border-l-ink" data-attention={attention}>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd data-testid={id} className={cn('tabular-nums', attention && 'font-bold')}>
        {children}
      </dd>
    </div>
  );
}

function WorkerLine({ worker }: { worker: SystemStatus['worker'] }) {
  if (worker.status === 'up') {
    return (
      <p>
        <span className="font-bold">Worker running</span>
        {worker.lastSeenAt ? <span className="text-muted-foreground tabular-nums">. Last seen {formatIST(worker.lastSeenAt)}</span> : null}
      </p>
    );
  }
  return (
    <div role="alert" className="rounded-md border border-l-[6px] border-rule border-l-priority bg-surface px-3 py-2.5">
      <p className="font-bold text-priority">Worker stopped</p>
      <p className="mt-0.5 font-bold">Timers, notifications and document reading are stopped. Start the worker.</p>
      <p className="mt-0.5 text-muted-foreground tabular-nums">{worker.lastSeenAt ? `Last seen ${formatIST(worker.lastSeenAt)}` : 'No worker has reported yet.'}</p>
    </div>
  );
}

/** Admin home: is the background worker alive, and is anything stuck behind it. Calm when all is well, urgent when the worker is down. */
export default function SystemPanel() {
  const q = useSystemStatus();
  const s = q.data;
  const calm = s !== undefined && s.worker.status === 'up' && s.jobs.overdue === 0 && s.jobs.deadLast24h === 0 && s.outbox.undispatched === 0 && s.notifications.queued === 0 && s.notifications.failedLast24h === 0;
  return (
    <section aria-labelledby="system-h" className="mb-4 grid gap-2 rounded-xl border border-rule bg-surface px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 id="system-h" className="text-base font-bold">
          Background work
        </h2>
        {s && !calm ? <p className="text-sm text-muted-foreground tabular-nums">Checked {formatIST(s.checkedAt, 'time-seconds')}</p> : null}
        {s && calm ? (
          <p data-testid="system-calm" className="text-sm">
            <span className="font-bold">Worker running</span>
            <span className="text-muted-foreground tabular-nums">. Last seen {formatIST(s.worker.lastSeenAt)}. Nothing is overdue, waiting or failed. </span>
            <Link to="/admin/notifications" className="font-bold underline underline-offset-2">
              Notifications sent
            </Link>
          </p>
        ) : null}
      </div>
      {q.isPending ? (
        <div data-testid="system-loading" aria-busy="true" aria-label="Loading" className="grid gap-2">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : !s ? (
        <ErrorState title="Background work status could not be loaded" error={q.error} onRetry={() => void q.refetch()} className="border-0 px-0 py-1" />
      ) : calm ? null : (
        <>
          <WorkerLine worker={s.worker} />
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
            <Stat id="stat-overdue" label="Overdue jobs" attention={s.jobs.overdue > 0}>
              {withOldest(s.jobs.overdue, s.jobs.oldestOverdueSeconds)}
            </Stat>
            <Stat id="stat-dead" label="Jobs that failed for good, last 24 hours" attention={s.jobs.deadLast24h > 0}>
              {s.jobs.deadLast24h}
            </Stat>
            <Stat id="stat-outbox" label="Updates waiting to be sent" attention={s.outbox.undispatched > 0}>
              {withOldest(s.outbox.undispatched, s.outbox.oldestSeconds)}
            </Stat>
            <Stat id="stat-notifications" label="Notifications queued now, failed in 24 hours" attention={s.notifications.failedLast24h > 0}>
              {s.notifications.queued} queued, {s.notifications.failedLast24h} failed
            </Stat>
          </dl>
          <p>
            <Link to="/admin/notifications" className="font-bold underline underline-offset-2">
              Notifications sent
            </Link>
          </p>
          {q.isError ? <p className="text-sm text-muted-foreground">Could not refresh just now. Showing the last check.</p> : null}
        </>
      )}
    </section>
  );
}
