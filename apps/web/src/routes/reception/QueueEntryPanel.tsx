import type { QueueEntry } from '@hqms/contracts';
import { GroupTag, TokenText } from '@/components/queue';
import { InlineAlert } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { formatIST } from '@/lib/format';
import type { PanelError } from './model';

const STATE_WORD: Record<QueueEntry['state'], string> = {
  waiting: 'Waiting',
  called: 'Called',
  in_service: 'With the doctor',
  completed: 'Completed',
  skipped: 'Skipped',
  absent: 'Absent',
  cancelled: 'Cancelled',
};

interface QueueEntryPanelProps {
  entry: QueueEntry | null;
  pending: 'absent' | 're-enter' | null;
  error: PanelError | null;
  onMarkAbsent: () => void;
  onReEnter: () => void;
}

/** Actions on the entry selected on the live board: Mark absent (waiting) and Re-enter skipped (skipped or absent). */
export function QueueEntryPanel({ entry, pending, error, onMarkAbsent, onReEnter }: QueueEntryPanelProps) {
  const canAbsent = entry?.state === 'waiting';
  const canReEnter = entry?.state === 'skipped' || entry?.state === 'absent';
  return (
    <div className="rounded-xl border border-rule bg-surface p-4" data-testid="entry-panel">
      <h2 className="text-lg font-bold">Selected on the board</h2>
      {!entry ? (
        <p className="mt-1 text-muted-foreground">Select a patient on the session board to mark them absent, or to bring a skipped patient back.</p>
      ) : (
        <div className="mt-2">
          <div className="flex items-center gap-3">
            <TokenText token={entry.token} size="md" />
            <GroupTag group={entry.group} />
            {entry.priorityClass !== null ? <GroupTag group="P" /> : null}
          </div>
          <p className="mt-1 font-bold">{entry.patientName}</p>
          <p className="text-muted-foreground tabular-nums">
            {STATE_WORD[entry.state]}. Checked in {formatIST(entry.checkedInAt)}.
          </p>
        </div>
      )}
      {error ? (
        <InlineAlert title={error.title} className="mt-3">
          <p>{error.message}</p>
          {error.hint ? <p className="mt-1">{error.hint}</p> : null}
        </InlineAlert>
      ) : null}
      <div className="mt-3 grid gap-2">
        <Button size="lg" variant="outline" disabled={!canAbsent || pending !== null} onClick={onMarkAbsent}>
          {pending === 'absent' ? 'Marking absent…' : 'Mark absent'}
        </Button>
        <Button size="lg" variant="outline" disabled={!canReEnter || pending !== null} onClick={onReEnter}>
          {pending === 're-enter' ? 'Re-entering…' : 'Re-enter skipped'}
        </Button>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {entry
          ? canAbsent
            ? 'Mark absent takes them out of the calling order. They can be re-entered later.'
            : canReEnter
              ? 'Re-enter puts the same entry back in the waiting list.'
              : 'Only waiting patients can be marked absent, and only skipped or absent patients can be re-entered.'
          : 'Mark absent works on waiting patients. Re-enter works on skipped or absent ones.'}
      </p>
    </div>
  );
}
