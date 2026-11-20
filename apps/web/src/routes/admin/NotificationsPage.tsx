import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { DeliveryChannel, DeliveryStatus, NotificationDelivery } from '@hqms/contracts';
import { useNotificationLog } from '@/api/admin';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/queue';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ROLE_LABEL } from '@/lib/auth';
import { formatIST } from '@/lib/format';
import { cn } from '@/lib/utils';

export const CHANNEL_WORD: Record<DeliveryChannel, string> = { in_app: 'In-app', sms: 'SMS', email: 'Email' };
const STATUS_WORD: Record<DeliveryStatus, string> = { queued: 'Queued', sent: 'Sent', failed: 'Failed' };

const CHANNEL_OPTIONS = [{ value: 'all', label: 'All channels' }, ...(Object.keys(CHANNEL_WORD) as DeliveryChannel[]).map((c) => ({ value: c, label: CHANNEL_WORD[c] }))];
const STATUS_OPTIONS = [{ value: 'all', label: 'All statuses' }, ...(Object.keys(STATUS_WORD) as DeliveryStatus[]).map((s) => ({ value: s, label: STATUS_WORD[s] }))];

/** "Patient", "Reception" ... for the recipient's role; an unknown role is shown as the server sent it. */
export function recipientRoleWord(role: string): string {
  return (ROLE_LABEL as Record<string, string>)[role] ?? role;
}

/** Status as a word first. Failed also says how many tries were made and the last error; colour only reinforces it. */
export function DeliveryStatusCell({ row }: { row: NotificationDelivery }) {
  const tone = row.status === 'sent' ? 'text-done' : row.status === 'failed' ? 'text-priority' : 'text-ink';
  return (
    <div>
      <p className={cn('font-bold', tone)}>{STATUS_WORD[row.status]}</p>
      {row.status === 'failed' ? (
        <p className="text-xs text-muted-foreground">
          {row.attempts} {row.attempts === 1 ? 'attempt' : 'attempts'}
          {row.lastError ? `, last error: ${row.lastError}` : ''}
        </p>
      ) : row.status === 'queued' && row.attempts > 0 ? (
        <p className="text-xs text-muted-foreground">
          {row.attempts} {row.attempts === 1 ? 'attempt' : 'attempts'} so far
        </p>
      ) : row.status === 'sent' && row.sentAt ? (
        <p className="text-xs text-muted-foreground tabular-nums">{formatIST(row.sentAt, 'time-seconds')}</p>
      ) : null}
    </div>
  );
}

/** Every message the system sent about a doctor's availability: who got it, by which channel, and whether it arrived. */
export default function NotificationsPage() {
  const [channel, setChannel] = useState<'all' | DeliveryChannel>('all');
  const [status, setStatus] = useState<'all' | DeliveryStatus>('all');
  const q = useNotificationLog({
    ...(channel !== 'all' ? { channel } : {}),
    ...(status !== 'all' ? { status } : {}),
  });
  const filtered = channel !== 'all' || status !== 'all';

  return (
    <section aria-labelledby="notif-h" className="grid gap-3">
      <div>
        <h2 id="notif-h" className="text-lg font-bold">
          Notifications sent
        </h2>
        <p className="max-w-prose text-muted-foreground">
          One row for each person and channel a message went to, newest first. Phone numbers and email addresses are masked. Times are Bengaluru time.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="notif-channel">Channel</Label>
          <Select value={channel} onValueChange={(v) => setChannel(v as 'all' | DeliveryChannel)}>
            <SelectTrigger id="notif-channel" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHANNEL_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="notif-status">Status</Label>
          <Select value={status} onValueChange={(v) => setStatus(v as 'all' | DeliveryStatus)}>
            <SelectTrigger id="notif-status" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="button" variant="outline" onClick={() => void q.refetch()} disabled={q.isFetching}>
          <RefreshCw aria-hidden="true" className={cn(q.isFetching && 'animate-spin motion-reduce:animate-none')} />
          {q.isFetching && !q.isPending ? 'Refreshing…' : 'Refresh'}
        </Button>
        {q.data ? (
          <p className="ml-auto text-muted-foreground tabular-nums" aria-live="polite">
            {q.data.length} {q.data.length === 1 ? 'message' : 'messages'}
            {q.dataUpdatedAt ? `, updated ${formatIST(q.dataUpdatedAt, 'time-seconds')}` : ''}
          </p>
        ) : null}
      </div>

      {q.isRefetchError && q.data ? (
        <p role="status" className="rounded-md border border-ink bg-secondary px-3 py-2">
          <span className="font-bold">The last refresh failed.</span> Showing the log as of {formatIST(q.dataUpdatedAt, 'time-seconds')}. Press Refresh to try again.
        </p>
      ) : null}

      {q.isPending ? (
        <SkeletonRows count={8} />
      ) : q.isError && !q.data ? (
        <ErrorState title="The notification log could not be loaded" error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState title={filtered ? 'No notifications match' : 'No notifications sent yet'}>
          {filtered
            ? 'Choose All channels and All statuses to see everything.'
            : 'When a doctor steps away or becomes unavailable, each patient and staff member who is told appears here with the channel used.'}
        </EmptyState>
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-xl border border-rule bg-surface md:block">
            <Table>
              <TableHeader className="bg-paper">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-3">Time</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Recipient</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead className="pr-3">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {q.data.map((n) => (
                  <TableRow key={n.id} data-testid="notification-row" className="align-top">
                    <TableCell className="py-2 pl-3 whitespace-nowrap tabular-nums">
                      {formatIST(n.createdAt, 'time-seconds')} <span className="text-muted-foreground">{formatIST(n.createdAt, 'date')}</span>
                    </TableCell>
                    <TableCell className="py-2 font-bold">{CHANNEL_WORD[n.channel]}</TableCell>
                    <TableCell className="py-2">
                      <span className="font-bold">{n.recipientName}</span> <span className="text-muted-foreground">{recipientRoleWord(n.recipientRole)}</span>
                    </TableCell>
                    <TableCell className="py-2 whitespace-nowrap tabular-nums">{n.address}</TableCell>
                    <TableCell className="max-w-md py-2 whitespace-normal">{n.body}</TableCell>
                    <TableCell className="py-2 pr-3 whitespace-normal">
                      <DeliveryStatusCell row={n} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <ul className="grid gap-2 md:hidden" aria-label="Notifications sent">
            {q.data.map((n) => (
              <li key={n.id} data-testid="notification-row" className="grid gap-1 rounded-xl border border-rule bg-surface px-3 py-2.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-bold">{CHANNEL_WORD[n.channel]}</span>
                  <span className="text-muted-foreground tabular-nums">{formatIST(n.createdAt, 'date-time')}</span>
                  <span className="ml-auto">
                    <DeliveryStatusCell row={n} />
                  </span>
                </div>
                <p>
                  <span className="font-bold">{n.recipientName}</span> <span className="text-muted-foreground">{recipientRoleWord(n.recipientRole)}</span>
                </p>
                <p className="text-muted-foreground tabular-nums">{n.address}</p>
                <p>{n.body}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
