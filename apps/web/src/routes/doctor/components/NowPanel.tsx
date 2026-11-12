import type { Ref } from 'react';
import type { QueueEntry } from '@hqms/contracts';
import { GroupTag, TokenText } from '@/components/queue';
import { GROUPS } from '@/components/queue/group';
import { Button } from '@/components/ui/button';
import { formatIST } from '@/lib/format';
import { cn } from '@/lib/utils';

interface NowPanelProps {
  active: QueueEntry | null;
  /** True when the active entry belongs to another of this doctor's sessions. */
  fromOtherSession: boolean;
  completedCount: number;
  startRef: Ref<HTMLButtonElement>;
  completeRef: Ref<HTMLButtonElement>;
  onStart: () => void;
  onComplete: () => void;
  onSkip: () => void;
  busy: boolean;
}

/** The one big panel: who is with the doctor now, with Start and Complete. */
export function NowPanel({ active, fromOtherSession, completedCount, startRef, completeRef, onStart, onComplete, onSkip, busy }: NowPanelProps) {
  const state = active?.state ?? null;
  const canStart = state === 'called' && !busy;
  const canComplete = state === 'in_service' && !busy;
  const edge = active ? (active.priorityClass !== null ? GROUPS.P.edge : GROUPS[active.group].edge) : 'border-l-rule';

  // aria-disabled keeps the buttons in the Tab order so the keyboard path is the same whether or not they apply.
  const soft = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

  return (
    <section aria-labelledby="now-heading" className={cn('rounded-xl border border-l-[6px] border-rule bg-surface p-5', edge)}>
      <div className="flex items-baseline gap-3">
        <h2 id="now-heading" className="text-lg font-bold">
          Now
        </h2>
        <p className="ml-auto text-muted-foreground tabular-nums">Completed today {completedCount}</p>
      </div>

      {active ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2" data-testid="now-active">
          <TokenText token={active.token} size="xl" priority={active.priorityClass !== null} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <GroupTag group={active.group} showName />
            </div>
            <p className="mt-1 truncate text-lg font-bold">{active.patientName}</p>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-lg font-bold">No patient with you</p>
          <p className="text-muted-foreground">Use Call next when you are ready for the next patient.</p>
        </div>
      )}

      {active ? (
        <p className="mt-3" data-testid="now-state">
          {state === 'called' ? (
            <>
              <span className="font-bold">Called {formatIST(active.calledAt)}.</span> Waiting for the patient to arrive. If they do not
              come within the call timeout the entry moves to Skipped.
            </>
          ) : (
            <>
              <span className="font-bold">In service.</span> Called {formatIST(active.calledAt)}. Complete the visit when you are done.
            </>
          )}
          {fromOtherSession ? <span className="mt-1 block text-muted-foreground">This patient is from another of your sessions today.</span> : null}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          ref={startRef}
          size="lg"
          aria-disabled={!canStart}
          className={soft}
          onClick={() => canStart && onStart()}
        >
          Start
        </Button>
        <Button
          ref={completeRef}
          size="lg"
          aria-disabled={!canComplete}
          className={soft}
          onClick={() => canComplete && onComplete()}
        >
          Complete
        </Button>
        {state === 'called' ? (
          <Button size="lg" variant="outline" className="ml-auto" disabled={busy} onClick={onSkip}>
            Skip
          </Button>
        ) : null}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {state === 'called'
          ? 'Start when the patient is in the room.'
          : state === 'in_service'
            ? 'Complete records the visit length and updates wait estimates.'
            : 'Start and Complete apply once a patient has been called.'}
      </p>
    </section>
  );
}
