import { Link } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Notification } from '@hqms/contracts';
import { useMarkAllNotificationsRead, useMarkNotificationRead } from '@/api';
import { ToneTag, TONE_EDGE, type Tone } from '@/components/layout/Tone';
import { ErrorState, SkeletonRows } from '@/components/queue';
import { Button } from '@/components/ui/button';
import type { ApiRequestError } from '@/lib/api';
import { relativeWithClock } from '@/lib/relative';
import { cn } from '@/lib/utils';

/** Only same-app paths are followed: a notification can never send someone to another site. */
export function safeAppPath(link: string | null | undefined): string | null {
  if (!link || !link.startsWith('/') || link.startsWith('//') || link.includes('\\')) return null;
  return link;
}

const toneOf = (n: Notification): Tone => n.severity ?? 'info';

function Item({ n, onNavigate }: { n: Notification; onNavigate: () => void }) {
  const markRead = useMarkNotificationRead();
  const unread = n.readAt === null;
  const tone = toneOf(n);
  const link = safeAppPath(n.link);
  return (
    <li
      data-testid="notification"
      data-unread={unread ? 'true' : 'false'}
      data-severity={tone}
      className={cn(
        'border-b border-rule px-4 py-3',
        unread ? ['bg-surface', TONE_EDGE[tone]] : 'border-l-[3px] border-l-transparent bg-paper text-muted-foreground',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {unread ? <span className="rounded-xs bg-ink px-1.5 py-0.5 text-xs leading-4 font-bold text-white">New</span> : null}
        <ToneTag tone={tone} />
        <time dateTime={n.createdAt} className="text-sm text-muted-foreground tabular-nums">
          {relativeWithClock(n.createdAt)}
        </time>
      </div>
      <p className={cn('mt-1.5 text-base', unread && 'font-bold text-ink')}>{n.body}</p>
      {link || unread ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {link ? (
            <Button asChild size="lg" className="min-h-12">
              <Link
                to={link}
                onClick={() => {
                  if (unread) markRead.mutate({ id: n.id });
                  onNavigate();
                }}
              >
                Open
              </Link>
            </Button>
          ) : null}
          {unread ? (
            <Button variant="outline" size="lg" disabled={markRead.isPending} onClick={() => markRead.mutate({ id: n.id })}>
              Mark as read
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** The list inside the notification sheet: loading, error, empty and stale states included. */
export function NotificationPanel({ query, onNavigate }: { query: UseQueryResult<Notification[], ApiRequestError>; onNavigate: () => void }) {
  const markAll = useMarkAllNotificationsRead();
  const items = query.data ?? [];
  const unread = items.filter((n) => n.readAt === null).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-rule bg-paper px-4 py-2">
        <p className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
          {query.isPending ? 'Loading…' : unread > 0 ? `${unread} unread` : 'All read'}
        </p>
        <Button variant="outline" size="lg" disabled={unread === 0 || markAll.isPending} onClick={() => markAll.mutate()}>
          Mark all as read
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="notification-scroll">
        {query.isPending ? (
          <div className="p-4">
            <SkeletonRows count={4} />
          </div>
        ) : query.isError && !query.data ? (
          <div className="p-4">
            <ErrorState
              title="Notifications could not be loaded"
              error={query.error}
              hint="Check the connection, then try again. New notices also appear here by themselves."
              onRetry={() => void query.refetch()}
            />
          </div>
        ) : items.length === 0 ? (
          <div className="px-4 py-10">
            <p className="text-lg font-bold">No notifications yet</p>
            <p className="mt-1 text-muted-foreground">Changes to your visit or your session show up here as they happen.</p>
          </div>
        ) : (
          <>
            {query.isError ? (
              <p role="status" className="border-b border-rule bg-secondary px-4 py-2 text-sm">
                <span className="font-bold">Could not refresh.</span> Showing the last list. Trying again shortly.
              </p>
            ) : null}
            <ul>
              {items.map((n) => (
                <Item key={n.id} n={n} onNavigate={onNavigate} />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
