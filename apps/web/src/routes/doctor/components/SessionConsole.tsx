import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { CallNextResult, QueueDecision, QueueEntry, Session } from '@hqms/contracts';
import { ErrorState, PressureNote, SkeletonRows, StaleBanner } from '@/components/queue';
import { Button } from '@/components/ui/button';
import {
  useCallNext,
  useCompleteVisit,
  useEntryAction,
  useMarkUnavailable,
  usePauseSession,
  useResumeSession,
  useSetPriority,
  useStartVisit,
} from '@/api/queue';
import { useLiveQueue } from '@/live';
import { formatIST } from '@/lib/format';
import { AbsentDialog, PauseDialog, PriorityDialog, UnavailableDialog } from './Dialogs';
import { CallNextPanel } from './CallNextPanel';
import { NowPanel } from './NowPanel';
import { SkippedList, WaitingList } from './Lists';
import { callNextBlock } from './callNextBlock';
import { toastFailure } from './commandError';

type DialogState =
  | { kind: 'priority'; entry: QueueEntry }
  | { kind: 'absent'; entry: QueueEntry }
  | { kind: 'pause' }
  | { kind: 'unavailable' }
  | null;

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** Newest of two decisions, so the screen explains the call just made even before the snapshot catches up. */
function newest(a: QueueDecision | null | undefined, b: QueueDecision | null | undefined): QueueDecision | null {
  if (a && b) return new Date(a.decidedAt) >= new Date(b.decidedAt) ? a : b;
  return a ?? b ?? null;
}

interface SessionConsoleProps {
  session: Session;
  date: string;
  /** Session picker, rendered at the start of the toolbar. */
  picker: ReactNode;
}

/** The doctor's working screen for one session: Now, Call next with its reason, the waiting list, Pause and Resume. */
export function SessionConsole({ session, date, picker }: SessionConsoleProps) {
  const { query, snapshot, status, lastUpdated } = useLiveQueue(session.id);
  const callNext = useCallNext(session.id);
  const start = useStartVisit(session.id);
  const complete = useCompleteVisit(session.id);
  const entryAction = useEntryAction(session.id);
  const setPriority = useSetPriority(session.id);
  const pause = usePauseSession(session.id);
  const resume = useResumeSession(session.id);
  const unavailable = useMarkUnavailable(session.id);

  const [dialog, setDialog] = useState<DialogState>(null);
  const [justCalled, setJustCalled] = useState<CallNextResult | null>(null);

  const callRef = useRef<HTMLButtonElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const completeRef = useRef<HTMLButtonElement>(null);

  // N jumps to Call next (it does not call): the doctor confirms with Enter. Ignored while typing or in a dialog.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== 'n' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (isTyping(e.target) || document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      callRef.current?.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A different session starts with a clean slate.
  useEffect(() => {
    setJustCalled(null);
  }, [session.id]);

  if (query.isPending) return <SkeletonRows count={6} />;
  if (!snapshot) {
    return <ErrorState title="The queue could not be loaded" error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (snapshot.view !== 'staff') {
    return <ErrorState title="This screen is for doctors" hint="Sign in with a doctor account to run the queue." />;
  }

  const active = snapshot.active;
  const blockedReason = callNextBlock(snapshot);
  const decision = newest(justCalled?.decision, snapshot.lastDecision);
  const busy = start.isPending || complete.isPending || entryAction.isPending;
  const sessionLabel = `${session.label} session`;

  function onCall() {
    callNext.mutate(undefined, {
      onSuccess: (result) => {
        setJustCalled(result);
        if (result.entry) {
          toast.success(`Called ${result.entry.token}`);
          startRef.current?.focus();
        } else {
          toast.info('No one to call', { description: result.decision.explanation });
        }
      },
      onError: (err) => toastFailure('Call next', err),
    });
  }

  function onStart() {
    if (!active) return;
    start.mutate(
      { visitId: active.visitId, expectedVersion: active.version },
      {
        onSuccess: () => {
          toast.success(`Started ${active.token}`);
          completeRef.current?.focus();
        },
        onError: (err) => toastFailure('Start', err),
      },
    );
  }

  function onComplete() {
    if (!active) return;
    complete.mutate(
      { visitId: active.visitId, expectedVersion: active.version },
      {
        onSuccess: () => {
          toast.success(`Completed ${active.token}`);
          callRef.current?.focus();
        },
        onError: (err) => toastFailure('Complete', err),
      },
    );
  }

  function onSkip() {
    if (!active) return;
    entryAction.mutate(
      { entryId: active.id, action: 'skip', expectedVersion: active.version },
      {
        onSuccess: () => {
          toast.success(`Skipped ${active.token}`);
          callRef.current?.focus();
        },
        onError: (err) => toastFailure('Skip', err),
      },
    );
  }

  function onReEnter(entry: QueueEntry) {
    entryAction.mutate(
      { entryId: entry.id, action: 're-enter', expectedVersion: entry.version },
      {
        onSuccess: () => toast.success(`Re-entered ${entry.token}`),
        onError: (err) => toastFailure('Re-enter', err),
      },
    );
  }

  const paused = snapshot.status === 'paused';
  const canPause = snapshot.status === 'open';
  const canMarkUnavailable = snapshot.status === 'open' || snapshot.status === 'paused';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        {picker}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {paused ? (
            <Button
              variant="outline"
              disabled={resume.isPending}
              onClick={() =>
                resume.mutate(undefined, {
                  onSuccess: () => toast.success('Resumed session'),
                  onError: (err) => toastFailure('Resume', err),
                })
              }
            >
              Resume session
            </Button>
          ) : (
            <Button variant="outline" disabled={!canPause} onClick={() => setDialog({ kind: 'pause' })}>
              Pause session
            </Button>
          )}
          <Button variant="outline" className="text-priority" disabled={!canMarkUnavailable} onClick={() => setDialog({ kind: 'unavailable' })}>
            Mark unavailable
          </Button>
        </div>
      </div>

      {snapshot.status !== 'open' ? (
        <div
          role="status"
          data-testid="session-status"
          className="rounded-md border border-l-[3px] border-rule border-l-ink bg-surface px-3 py-2"
        >
          <p className="font-bold">
            {snapshot.status === 'paused' && 'Session paused'}
            {snapshot.status === 'unavailable' && 'Session marked unavailable'}
            {snapshot.status === 'closed' && 'Session closed'}
            {snapshot.status === 'scheduled' && 'Session has not started'}
          </p>
          <p>
            {snapshot.status === 'paused'
              ? snapshot.pauseUntil
                ? `Back at ${formatIST(snapshot.pauseUntil)}. Patients see a resume time and their estimates continue.`
                : 'No resume time set. Patient estimates are withheld until you resume.'
              : snapshot.status === 'unavailable'
                ? 'Patients are not reassigned automatically. Reception will advise or rebook them.'
                : `The ${sessionLabel} is not taking calls.`}
          </p>
        </div>
      ) : null}

      <PressureNote pressure={snapshot.pressure} />

      <StaleBanner status={status === 'reconnecting' ? 'reconnecting' : 'live'} lastUpdated={lastUpdated} />
      {query.isRefetchError && status !== 'reconnecting' ? (
        <p role="status" className="rounded-md border border-ink bg-secondary px-3 py-2">
          <span className="font-bold">The last refresh failed.</span> The queue shown is from the previous update. Check before you call.
        </p>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="lg:col-start-2 lg:row-span-3 lg:row-start-1">
          <CallNextPanel
            snapshot={snapshot}
            decision={decision}
            blockedReason={blockedReason}
            calling={callNext.isPending}
            buttonRef={callRef}
            onCall={onCall}
          />
        </div>
        <div className="lg:col-start-1 lg:row-start-1">
          <NowPanel
            active={active}
            fromOtherSession={active !== null && active.sessionId !== session.id}
            completedCount={snapshot.completedCount}
            startRef={startRef}
            completeRef={completeRef}
            onStart={onStart}
            onComplete={onComplete}
            onSkip={onSkip}
            busy={busy}
          />
        </div>
        <div className="lg:col-start-1 lg:row-start-2">
          <WaitingList
            entries={snapshot.waiting}
            onSetPriority={(entry) => setDialog({ kind: 'priority', entry })}
            onMarkAbsent={(entry) => setDialog({ kind: 'absent', entry })}
          />
        </div>
        <div className="lg:col-start-1 lg:row-start-3">
          <SkippedList entries={snapshot.skipped} onReEnter={onReEnter} busy={entryAction.isPending} />
        </div>
      </div>

      <PriorityDialog
        open={dialog?.kind === 'priority'}
        onOpenChange={(open) => !open && setDialog(null)}
        pending={setPriority.isPending}
        entry={dialog?.kind === 'priority' ? dialog.entry : null}
        onSubmit={({ priorityClass, reason }) => {
          if (dialog?.kind !== 'priority') return;
          const entry = dialog.entry;
          setPriority.mutate(
            { entryId: entry.id, priorityClass, reason, expectedVersion: entry.version },
            {
              onSuccess: () => {
                toast.success(priorityClass === null ? `Cleared priority for ${entry.token}` : `Set priority for ${entry.token}`);
                setDialog(null);
              },
              onError: (err) => toastFailure('Set priority', err),
            },
          );
        }}
      />
      <AbsentDialog
        open={dialog?.kind === 'absent'}
        onOpenChange={(open) => !open && setDialog(null)}
        pending={entryAction.isPending}
        entry={dialog?.kind === 'absent' ? dialog.entry : null}
        onSubmit={(reason) => {
          if (dialog?.kind !== 'absent') return;
          const entry = dialog.entry;
          entryAction.mutate(
            { entryId: entry.id, action: 'absent', reason: reason || undefined, expectedVersion: entry.version },
            {
              onSuccess: () => {
                toast.success(`Marked ${entry.token} absent`);
                setDialog(null);
              },
              onError: (err) => toastFailure('Mark absent', err),
            },
          );
        }}
      />
      <PauseDialog
        open={dialog?.kind === 'pause'}
        onOpenChange={(open) => !open && setDialog(null)}
        pending={pause.isPending}
        date={date}
        onSubmit={(vars) =>
          pause.mutate(vars, {
            onSuccess: () => {
              toast.success('Paused session');
              setDialog(null);
            },
            onError: (err) => toastFailure('Pause', err),
          })
        }
      />
      <UnavailableDialog
        open={dialog?.kind === 'unavailable'}
        onOpenChange={(open) => !open && setDialog(null)}
        pending={unavailable.isPending}
        onSubmit={(reason) =>
          unavailable.mutate(
            { reason },
            {
              onSuccess: () => {
                toast.success('Marked session unavailable');
                setDialog(null);
              },
              onError: (err) => toastFailure('Mark unavailable', err),
            },
          )
        }
      />
    </div>
  );
}
