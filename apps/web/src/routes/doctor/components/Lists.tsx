import { ChevronDown } from 'lucide-react';
import type { QueueEntry } from '@hqms/contracts';
import { Lane, QueueRow } from '@/components/queue';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { formatIST } from '@/lib/format';

interface WaitingListProps {
  entries: QueueEntry[];
  onSetPriority: (entry: QueueEntry) => void;
  onMarkAbsent: (entry: QueueEntry) => void;
}

function minutes(min: number | null): string {
  return min === null ? '-' : `${Math.max(0, Math.round(min))} min`;
}

/** Waiting patients in projected policy order: the order the policy will call them, not arrival order. */
export function WaitingList({ entries, onSetPriority, onMarkAbsent }: WaitingListProps) {
  return (
    <Lane
      title="Waiting, in call order"
      count={entries.length}
      empty="No one is waiting. Patients appear here once they check in or are admitted as walk-ins."
    >
      {entries.map((e, i) => {
        const hasPriority = e.priorityClass !== null;
        return (
          <QueueRow
            key={e.id}
            token={e.token}
            group={e.group}
            priority={hasPriority}
            title={
              <>
                <span className="mr-2 inline-block w-5 text-muted-foreground tabular-nums">{e.projectedPosition ?? i + 1}</span>
                {e.patientName}
              </>
            }
            detail={hasPriority ? `Priority ${e.priorityClass}: ${e.priorityReason ?? 'no reason recorded'}` : `In at ${formatIST(e.checkedInAt)}`}
            trailing={
              <span className="flex items-center gap-2">
                <span title="Waiting since eligible">{minutes(e.waitingMinutes)}</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" aria-label={`Actions for ${e.token}, ${e.patientName}`}>
                      Actions
                      <ChevronDown aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => onSetPriority(e)}>{hasPriority ? 'Change or clear priority' : 'Set priority'}</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onMarkAbsent(e)}>Mark absent</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </span>
            }
          />
        );
      })}
    </Lane>
  );
}

interface SkippedListProps {
  entries: QueueEntry[];
  onReEnter: (entry: QueueEntry) => void;
  busy: boolean;
}

/** Skipped or absent patients who can still come back. Re-enter returns them to the waiting list. */
export function SkippedList({ entries, onReEnter, busy }: SkippedListProps) {
  return (
    <Lane
      title="Skipped or absent"
      count={entries.length}
      empty="No one has been skipped. Patients who miss their call appear here and can be re-entered."
    >
      {entries.map((e) => (
        <QueueRow
          key={e.id}
          token={e.token}
          group={e.group}
          priority={e.priorityClass !== null}
          title={e.patientName}
          detail={e.state === 'absent' ? 'Absent' : 'Skipped'}
          trailing={
            <Button variant="outline" disabled={busy} onClick={() => onReEnter(e)} aria-label={`Re-enter ${e.token}, ${e.patientName}`}>
              Re-enter
            </Button>
          }
        />
      ))}
    </Lane>
  );
}
