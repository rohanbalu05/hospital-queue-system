import type { QueueEntry, StaffQueueSnapshot } from '@hqms/contracts';
import { CapacityBar, EmptyState, ErrorState, Lane, QueueRow, SkeletonRows, StaleBanner, GroupTag } from '@/components/queue';
import { formatIST } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useLiveQueue, type LiveStatus } from './useQueue';

const SESSION_STATUS_WORD: Record<StaffQueueSnapshot['status'], string> = {
  scheduled: 'Not started',
  open: 'Open',
  paused: 'Paused',
  unavailable: 'Doctor unavailable',
  closed: 'Closed',
};

interface SessionBoardLiveProps {
  sessionId: string;
  /** Highlights one row (the reception desk selects an entry to act on). */
  selectedEntryId?: string | null;
  /** When set, rows become buttons: focusable, Enter or Space selects. */
  onSelectEntry?: (entry: QueueEntry) => void;
  className?: string;
}

function waited(min: number | null): string | null {
  return min === null ? null : `${Math.max(0, Math.round(min))} min`;
}

/**
 * Live session board: lanes for waiting A, waiting W, called, in service and skipped, plus the capacity bar.
 * Subscribes to the session's SSE stream and refetches the snapshot on each version notice (FR-09).
 * Mount it anywhere a staff role needs the board: reception centre column, doctor tablet, admin.
 */
export function SessionBoardLive({ sessionId, selectedEntryId = null, onSelectEntry, className }: SessionBoardLiveProps) {
  const { query, snapshot, status, lastUpdated } = useLiveQueue(sessionId);

  if (query.isPending) {
    return (
      <div className={className}>
        <SkeletonRows count={6} />
      </div>
    );
  }
  if (!snapshot) {
    return (
      <ErrorState
        className={className}
        title="The session board could not be loaded"
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (snapshot.view !== 'staff') {
    return (
      <ErrorState
        className={className}
        title="This board is for staff"
        hint="Sign in with a reception or doctor account to see the full session board."
      />
    );
  }

  return (
    <BoardBody
      snapshot={snapshot}
      status={status}
      lastUpdated={lastUpdated}
      refreshFailed={query.isRefetchError}
      selectedEntryId={selectedEntryId}
      onSelectEntry={onSelectEntry}
      className={className}
    />
  );
}

interface BoardBodyProps {
  snapshot: StaffQueueSnapshot;
  status: LiveStatus;
  lastUpdated: number | null;
  refreshFailed: boolean;
  selectedEntryId: string | null;
  onSelectEntry: ((entry: QueueEntry) => void) | undefined;
  className: string | undefined;
}

function BoardBody({ snapshot, status, lastUpdated, refreshFailed, selectedEntryId, onSelectEntry, className }: BoardBodyProps) {
  const waitingA = snapshot.waiting.filter((e) => e.group === 'A');
  const waitingW = snapshot.waiting.filter((e) => e.group === 'W');
  const called = snapshot.active?.state === 'called' ? [snapshot.active] : [];
  const inService = snapshot.active?.state === 'in_service' ? [snapshot.active] : [];

  const select = (e: QueueEntry) => (onSelectEntry ? () => onSelectEntry(e) : undefined);
  const row = (e: QueueEntry, trailing: string | null, detail: string) => (
    <QueueRow
      key={e.id}
      token={e.token}
      group={e.group}
      priority={e.priorityClass !== null}
      title={e.patientName}
      detail={detail}
      trailing={trailing}
      selected={selectedEntryId === e.id}
      onSelect={select(e)}
    />
  );

  return (
    <div className={cn('@container flex flex-col gap-3', className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="font-bold">
          Session{' '}
          <span
            className={cn(
              'ml-1 rounded-xs px-1.5 py-0.5 text-xs',
              snapshot.status === 'open' ? 'bg-done/10 text-done' : 'bg-priority/10 text-priority',
            )}
          >
            {SESSION_STATUS_WORD[snapshot.status]}
          </span>
        </p>
        {snapshot.status === 'paused' ? (
          <p className="text-muted-foreground">
            {snapshot.pauseUntil ? `Resumes about ${formatIST(snapshot.pauseUntil)}.` : 'No resume time set. Patient estimates are withheld.'}
          </p>
        ) : null}
        <p className="ml-auto text-muted-foreground tabular-nums">Completed today {snapshot.completedCount}</p>
      </div>

      <CapacityBar
        booked={snapshot.capacity.bookedReserved}
        bookedCapacity={snapshot.capacity.bookedCapacity}
        walkin={snapshot.capacity.walkinUsed}
        walkinCapacity={snapshot.capacity.walkinCapacity}
      />

      <StaleBanner status={status === 'reconnecting' ? 'reconnecting' : 'live'} lastUpdated={lastUpdated} />
      {refreshFailed && status !== 'reconnecting' ? (
        <p role="status" className="rounded-md border border-ink bg-secondary px-3 py-2">
          <span className="font-bold">The last refresh failed.</span> Showing the board as of the previous update.
        </p>
      ) : null}

      <div className="grid gap-3 @2xl:grid-cols-2">
        <Lane title="Called" count={called.length} empty="Nobody is being called.">
          {called.map((e) => row(e, e.calledAt ? `Called ${formatIST(e.calledAt)}` : null, 'Waiting for the patient'))}
        </Lane>
        <Lane title="In service" count={inService.length} empty="Nobody is with the doctor.">
          {inService.map((e) => row(e, e.calledAt ? `Since ${formatIST(e.calledAt)}` : null, 'With the doctor'))}
        </Lane>
        <Lane title="Waiting, appointment" badge={<GroupTag group="A" />} count={waitingA.length} empty="No appointment patients are waiting.">
          {waitingA.map((e) => row(e, waited(e.waitingMinutes), `Checked in ${formatIST(e.checkedInAt)}`))}
        </Lane>
        <Lane title="Waiting, walk-in" badge={<GroupTag group="W" />} count={waitingW.length} empty="No walk-in patients are waiting.">
          {waitingW.map((e) => row(e, waited(e.waitingMinutes), `Checked in ${formatIST(e.checkedInAt)}`))}
        </Lane>
      </div>
      <Lane
        title="Skipped or absent"
        count={snapshot.skipped.length}
        empty="Nobody has been skipped. Patients who miss their call appear here and can be re-entered."
      >
        {snapshot.skipped.map((e) => row(e, null, e.state === 'absent' ? 'Absent' : 'Skipped'))}
      </Lane>
    </div>
  );
}

/** Convenience for screens that only have an id and want the board with its own empty state. */
export function SessionBoardEmpty() {
  return <EmptyState title="No session selected">Choose a doctor and session to see its board.</EmptyState>;
}
