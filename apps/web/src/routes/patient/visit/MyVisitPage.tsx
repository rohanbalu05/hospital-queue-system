import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Eta, PatientQueueSnapshot, QueueEntryState } from '@hqms/contracts';
import { PatientPage } from '@/components/layout/PatientPage';
import { EmptyState, ErrorState, GroupTag, SkeletonRows, StaleBanner, TokenText } from '@/components/queue';
import { GROUPS } from '@/components/queue/group';
import { Button } from '@/components/ui/button';
import { ApiRequestError } from '@/lib/api';
import { formatIST, formatMinuteRange } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useLiveQueue } from '@/live';

/** What the patient reads about their own entry, in plain words. */
export const STATE_WORDS: Record<QueueEntryState, { title: string; detail: string }> = {
  waiting: { title: 'You are in the queue', detail: 'Stay near the waiting area. You will be called by your token.' },
  called: { title: 'It is your turn', detail: 'Please go to the consulting room now.' },
  in_service: { title: 'You are with the doctor', detail: 'Your visit is in progress.' },
  completed: { title: 'Your visit is complete', detail: 'Thank you for waiting.' },
  skipped: { title: 'You were called and did not arrive', detail: 'Please see the front desk so they can put you back in the queue.' },
  absent: { title: 'You are marked as not present', detail: 'Please see the front desk if you are here.' },
  cancelled: { title: 'This visit was cancelled', detail: 'Please see the front desk if you think this is a mistake.' },
};

const UNCERTAINTY_WORDS: Record<NonNullable<Eta['uncertainty']>, string> = {
  cold_start: 'Early estimate: few consultations recorded yet, so the range is wide.',
  warm: 'Based on consultations recorded so far today.',
  widened_overrun: 'Range widened: the current consultation is running longer than usual.',
};

/** ETA as a range, or "Estimate paused" with the reason when it is withheld or unsupported (FR-10). */
export function EtaBlock({ eta }: { eta: Eta }) {
  if (eta.status === 'ok' && eta.lowMinutes !== null && eta.highMinutes !== null) {
    return (
      <div data-testid="eta">
        <p className="text-base text-muted-foreground">Estimated wait</p>
        <p className="text-2xl font-bold tabular-nums">{formatMinuteRange(eta.lowMinutes, eta.highMinutes)}</p>
        <p className="mt-1 text-muted-foreground">
          {eta.uncertainty ? UNCERTAINTY_WORDS[eta.uncertainty] : null} Worked out at {formatIST(eta.computedAt)}. It can change if someone with a
          medical priority arrives.
        </p>
      </div>
    );
  }
  return (
    <div data-testid="eta">
      <p className="text-base text-muted-foreground">Estimated wait</p>
      <p className="text-2xl font-bold">Estimate paused</p>
      <p className="mt-1 text-muted-foreground">
        {eta.status === 'withheld'
          ? "The doctor has paused this session. We'll show a new estimate when it resumes."
          : `${eta.note ?? 'No estimate is available right now.'} The front desk can tell you more.`}
      </p>
    </div>
  );
}

const SESSION_NOTE: Partial<Record<PatientQueueSnapshot['status'], string>> = {
  paused: 'The doctor has paused this session. Your place in the queue is kept.',
  unavailable: 'The doctor is not available for this session. Please check with the front desk.',
  closed: 'This session has closed.',
  scheduled: 'This session has not started yet.',
};

function Panel({ children, className, edge }: { children: ReactNode; className?: string; edge?: string }) {
  return <section className={cn('rounded-xl border border-rule bg-surface p-5', edge && `border-l-[6px] ${edge}`, className)}>{children}</section>;
}

function VisitBody({ snapshot, status, lastUpdated }: { snapshot: PatientQueueSnapshot; status: 'live' | 'stale' | 'reconnecting'; lastUpdated: number | null }) {
  const mine = snapshot.myEntry;
  const sessionNote = SESSION_NOTE[snapshot.status];
  return (
    <div className="flex flex-col gap-4">
      <StaleBanner status={status === 'reconnecting' ? 'reconnecting' : 'live'} lastUpdated={lastUpdated} />
      {sessionNote ? (
        <p role="status" className="rounded-md border border-l-[3px] border-rule border-l-priority bg-surface px-4 py-3">
          {sessionNote}
        </p>
      ) : null}

      {mine ? (
        <>
          <Panel edge={GROUPS[mine.group].edge}>
            <p className="text-base text-muted-foreground">Your token</p>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <TokenText token={mine.token} size="display" />
            </div>
            <div className="mt-2 flex items-center gap-2">
              <GroupTag group={mine.group} showName />
            </div>
            <h2 className="mt-4 text-xl font-bold" data-testid="visit-state">
              {STATE_WORDS[mine.state].title}
            </h2>
            <p className="mt-1">{STATE_WORDS[mine.state].detail}</p>
          </Panel>

          {mine.state === 'waiting' ? (
            <Panel>
              <div className="grid gap-5 sm:grid-cols-2">
                <div data-testid="position">
                  <p className="text-base text-muted-foreground">Your place in the queue</p>
                  <p className="text-2xl font-bold tabular-nums">{mine.position !== null ? `Number ${mine.position}` : 'Not yet placed'}</p>
                  {mine.position !== null && mine.position > 1 ? (
                    <p className="mt-1 text-muted-foreground tabular-nums">{mine.position - 1} ahead of you</p>
                  ) : mine.position === 1 ? (
                    <p className="mt-1 text-muted-foreground">You are next.</p>
                  ) : null}
                </div>
                <EtaBlock eta={mine.eta} />
              </div>
            </Panel>
          ) : null}
        </>
      ) : (
        <EmptyState
          title="You have not checked in for this session"
          action={
            <Button asChild size="lg" variant="outline">
              <Link to="/patient/visits">See my visits</Link>
            </Button>
          }
        >
          Check in at the front desk when you arrive. Your token and place in the queue appear here as soon as you do.
        </EmptyState>
      )}

      <Panel>
        <p className="text-base text-muted-foreground">Now calling</p>
        {snapshot.nowCalling ? (
          <TokenText token={snapshot.nowCalling} size="xl" className="mt-1" />
        ) : (
          <p className="mt-1 text-xl font-bold">No one is being called right now</p>
        )}
      </Panel>
    </div>
  );
}

/** /patient/visit/:sessionId: token, state in words, position, ETA range and who is being called. Live over SSE. */
export default function MyVisitPage() {
  const { sessionId = null } = useParams();
  const { query, snapshot, status, lastUpdated } = useLiveQueue(sessionId);
  const notFound = query.error instanceof ApiRequestError && (query.error.status === 404 || query.error.status === 403);

  return (
    <PatientPage title="My visit">
      {query.isPending ? (
        <SkeletonRows count={4} />
      ) : !snapshot ? (
        <ErrorState
          title={notFound ? 'We could not find your visit in this session' : 'Your visit could not be loaded'}
          error={query.error}
          hint={notFound ? 'Open My visits and choose today’s appointment, or ask the front desk.' : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : snapshot.view !== 'patient' ? (
        <ErrorState title="This page is for patients" hint="Sign in with a patient account to see your visit." />
      ) : (
        <VisitBody snapshot={snapshot} status={status} lastUpdated={lastUpdated} />
      )}
    </PatientPage>
  );
}
