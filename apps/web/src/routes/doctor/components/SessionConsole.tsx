import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CallNextResult, QueueDecision, QueueEntry, Session, SessionAvailability } from '@hqms/contracts';
import { AvailabilityStrip, ConfirmDialog, ErrorState, PressureNote, SkeletonRows, StaleBanner, useAvailabilityControls } from '@/components/queue';
import { Button } from '@/components/ui/button';
import {
  useCallNext,
  useCompleteVisit,
  useEntryAction,
  useSetPriority,
  useStartVisit,
} from '@/api/queue';
import { useLiveQueue } from '@/live';
import { AbsentDialog, PriorityDialog } from './Dialogs';
import { FollowUpDialog, type CreatedFollowUp } from './FollowUpDialog';
import { FollowUpConfirmation, JustCompleted } from './JustCompleted';
import { CallNextPanel } from './CallNextPanel';
import { NowPanel } from './NowPanel';
import { SkippedList, WaitingList } from './Lists';
import { callNextBlock } from './callNextBlock';
import { toastFailure } from './commandError';

type DialogState =
  | { kind: 'priority'; entry: QueueEntry }
  | { kind: 'absent'; entry: QueueEntry }
  | null;

/** Until the first snapshot arrives the availability controls need something to hold; nothing is offered from it. */
const NOT_LOADED: SessionAvailability = { state: 'not_started', since: null, expectedBackAt: null, overdue: false, reason: null };

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
  /** Session picker, rendered at the start of the toolbar. */
  picker: ReactNode;
}

/** The doctor's working screen for one session: Now, Call next with its reason, the waiting list, Step away and I'm back. */
export function SessionConsole({ session, picker }: SessionConsoleProps) {
  const { query, snapshot, status, lastUpdated } = useLiveQueue(session.id);
  const callNext = useCallNext(session.id);
  const start = useStartVisit(session.id);
  const complete = useCompleteVisit(session.id);
  const entryAction = useEntryAction(session.id);
  const setPriority = useSetPriority(session.id);
  const availability = useAvailabilityControls({
    sessionId: session.id,
    sessionDate: session.sessionDate,
    sessionEndsAt: session.endsAt,
    availability: snapshot?.view === 'staff' ? snapshot.availability : NOT_LOADED,
    subject: 'you',
    role: 'doctor',
  });

  // The session list behind the picker is polled; when the live status moves (away, unavailable, back) refresh it so the
  // picker's "(open)" never lags the console (PR-34).
  const qc = useQueryClient();
  const liveStatus = snapshot?.view === 'staff' ? snapshot.status : null;
  useEffect(() => {
    if (liveStatus !== null && liveStatus !== session.status) void qc.invalidateQueries({ queryKey: ['queue', 'sessions'] });
  }, [liveStatus, session.status, qc]);

  const [dialog, setDialog] = useState<DialogState>(null);
  const [justCalled, setJustCalled] = useState<CallNextResult | null>(null);
  // PR-32: the patient just completed stays on screen (with Create follow-up) until the next call.
  const [completed, setCompleted] = useState<QueueEntry | null>(null);
  const [followUpFor, setFollowUpFor] = useState<QueueEntry | null>(null);
  const [created, setCreated] = useState<Record<string, CreatedFollowUp[]>>({});
  // PR-35: Skip asks first.
  const [skipFor, setSkipFor] = useState<QueueEntry | null>(null);

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
    setCompleted(null);
    setFollowUpFor(null);
    setSkipFor(null);
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
          setCompleted(null);
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
          setCompleted(active);
          toast.success(`Completed ${active.token}`);
          callRef.current?.focus();
        },
        onError: (err) => toastFailure('Complete', err),
      },
    );
  }

  function onSkip() {
    if (!active) return;
    setSkipFor(active);
  }

  function confirmSkip() {
    const target = skipFor;
    if (!target) return;
    entryAction.mutate(
      { entryId: target.id, action: 'skip', expectedVersion: target.version },
      {
        onSuccess: () => {
          toast.success(`Skipped ${target.token}`);
          setSkipFor(null);
          callRef.current?.focus();
        },
        onError: (err) => {
          setSkipFor(null);
          toastFailure('Skip', err);
        },
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

  const away = snapshot.availability.state === 'away';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <div className="min-w-0 max-w-full flex-1 sm:flex-none">{picker}</div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {away ? null : (
            <Button variant="outline" disabled={!availability.canStepAway} onClick={availability.openStepAway}>
              Step away
            </Button>
          )}
          <Button
            variant="outline"
            className="border-priority/50 text-priority hover:text-priority"
            disabled={!availability.canUnavailable}
            onClick={availability.openUnavailable}
          >
            Unavailable for rest of session
          </Button>
        </div>
      </div>

      <AvailabilityStrip availability={snapshot.availability} who="You">
        {away ? (
          <>
            <Button size="lg" disabled={availability.backPending} onClick={availability.imBack}>
              {availability.backPending ? 'Saving…' : "I'm back"}
            </Button>
            <Button variant="outline" size="lg" onClick={availability.openStepAway}>
              Change return time
            </Button>
          </>
        ) : null}
      </AvailabilityStrip>

      {snapshot.status === 'closed' || snapshot.status === 'scheduled' ? (
        <div
          role="status"
          data-testid="session-status"
          className="rounded-md border border-l-[3px] border-rule border-l-ink bg-surface px-3 py-2"
        >
          <p className="font-bold">{snapshot.status === 'closed' ? 'Session closed' : 'Session has not started'}</p>
          <p>The {sessionLabel} is not taking calls.</p>
        </div>
      ) : null}

      <PressureNote pressure={snapshot.pressure} />

      <StaleBanner status={status === 'reconnecting' ? 'reconnecting' : 'live'} lastUpdated={lastUpdated} />
      {query.isRefetchError && status !== 'reconnecting' ? (
        <p role="status" className="rounded-md border border-ink bg-secondary px-3 py-2">
          <span className="font-bold">The last refresh failed.</span> The queue shown is from the previous update. Check before you call.
        </p>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
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
            onFollowUp={() => active && setFollowUpFor(active)}
            confirmation={active && created[active.visitId] ? <FollowUpConfirmation created={created[active.visitId] ?? []} /> : null}
            busy={busy}
          />
          {completed && (active === null || active.visitId !== completed.visitId) ? (
            <div className="mt-4">
              <JustCompleted entry={completed} created={created[completed.visitId] ?? []} onFollowUp={() => setFollowUpFor(completed)} />
            </div>
          ) : null}
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
      <FollowUpDialog
        entry={followUpFor}
        onClose={() => setFollowUpFor(null)}
        onCreated={(visitId, c) => setCreated((all) => ({ ...all, [visitId]: [...(all[visitId] ?? []), c] }))}
      />
      <ConfirmDialog
        open={skipFor !== null}
        onOpenChange={(o) => !o && setSkipFor(null)}
        title={`Skip ${skipFor?.token ?? ''}?`}
        description={`${skipFor?.patientName ?? 'This patient'} moves to the Skipped list. You or reception can re-enter them if they arrive.`}
        confirmLabel="Skip"
        cancelLabel="Keep called"
        pending={entryAction.isPending}
        onConfirm={confirmSkip}
      />
      {availability.dialogs}
    </div>
  );
}
