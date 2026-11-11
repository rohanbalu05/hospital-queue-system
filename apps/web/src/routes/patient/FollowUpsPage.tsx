import { Link } from 'react-router-dom';
import type { FollowUpStatus } from '@hqms/contracts';
import type { PatientFollowUp } from '@hqms/contracts';
import { useMyFollowUps } from '@/api';
import { PatientPage } from '@/components/layout/PatientPage';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/queue';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import { DISPOSITION_WORD, KIND_WORD, isClosed } from '@/lib/followup';
import { formatIST } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Patient words for a task's status. Staff notes, owner and detail are never shown here. */
export const PATIENT_TASK_WORD: Record<FollowUpStatus, string> = {
  open: 'Waiting for the follow-up team',
  acknowledged: 'Being handled',
  resolved: 'Done',
  cancelled: 'Closed',
};

function TaskRow({ task }: { task: PatientFollowUp }) {
  const closed = isClosed(task.status);
  return (
    <li className={cn('border-l-[3px] px-4 py-3', task.status === 'resolved' ? 'border-l-done' : 'border-l-rule')} data-status={task.status}>
      <p className="font-bold">{task.summary}</p>
      <p className={cn('font-bold', task.status === 'resolved' ? 'text-done' : 'text-ink')}>{PATIENT_TASK_WORD[task.status]}</p>
      <p className="text-muted-foreground">{KIND_WORD[task.kind] ?? 'Follow-up'}</p>
      {!closed ? (
        <p className="mt-1 tabular-nums">You&apos;ll hear back by {formatIST(task.dueAt, 'date-time')}.</p>
      ) : (
        <p className="mt-1 tabular-nums text-muted-foreground">
          {task.status === 'resolved' && task.disposition ? `${DISPOSITION_WORD[task.disposition]}. ` : ''}
          {task.resolvedAt ? formatIST(task.resolvedAt, 'date-time') : ''}
        </p>
      )}
      {task.returnAppointmentId ? (
        <p className="mt-1">
          A return visit was booked for you.{' '}
          <Link to="/patient/visits" className="font-bold underline underline-offset-2">
            See My visits
          </Link>
        </p>
      ) : null}
    </li>
  );
}

export default function FollowUpsPage() {
  const { me } = useAuth();
  const patientId = me?.patientId ?? undefined;
  const q = useMyFollowUps(patientId !== undefined);
  const open = (q.data ?? []).filter((t) => !isClosed(t.status)).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const done = (q.data ?? []).filter((t) => isClosed(t.status)).sort((a, b) => (b.resolvedAt ?? b.createdAt).localeCompare(a.resolvedAt ?? a.createdAt));

  return (
    <PatientPage title="Follow-ups" description="Checks and questions the hospital team is handling for you.">
      {!patientId ? (
        <EmptyState title="No patient record is linked to this sign-in">Ask reception to link your record so your follow-ups show here.</EmptyState>
      ) : q.isPending ? (
        <SkeletonRows count={3} />
      ) : q.isError && !q.data ? (
        <ErrorState title="Your follow-ups could not be loaded" error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState
          title="No follow-ups"
          action={
            <Button asChild size="lg" variant="outline">
              <Link to="/patient/questions">Ask about your instructions</Link>
            </Button>
          }
        >
          When the hospital needs to check on you after a visit, or a question is sent to the team, it shows here with the time you will hear back.
        </EmptyState>
      ) : (
        <div className="grid gap-6">
          <section aria-labelledby="open-h">
            <h2 id="open-h" className="mb-2 text-lg font-bold">
              In progress
            </h2>
            {open.length === 0 ? (
              <p className="rounded-xl border border-rule bg-surface px-4 py-4 text-muted-foreground">Nothing is waiting on the team right now.</p>
            ) : (
              <ul className="divide-y divide-rule overflow-hidden rounded-xl border border-rule bg-surface">
                {open.map((t) => (
                  <TaskRow key={t.id} task={t} />
                ))}
              </ul>
            )}
          </section>
          {done.length > 0 ? (
            <section aria-labelledby="done-h">
              <h2 id="done-h" className="mb-2 text-lg font-bold">
                Finished
              </h2>
              <ul className="divide-y divide-rule overflow-hidden rounded-xl border border-rule bg-surface">
                {done.map((t) => (
                  <TaskRow key={t.id} task={t} />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </PatientPage>
  );
}
