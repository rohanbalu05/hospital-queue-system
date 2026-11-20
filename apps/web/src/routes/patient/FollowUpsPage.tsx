import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { TriangleAlert } from 'lucide-react';
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

const SEEN_KEY = (patientId: string) => `hqms.seen-replies.${patientId}`;

/** Reply ids this patient has already been shown on this device. Storage can be blocked: then nothing is remembered. */
function readSeen(patientId: string | undefined): Set<string> {
  if (!patientId) return new Set();
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(SEEN_KEY(patientId)) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeSeen(patientId: string, ids: Set<string>): void {
  try {
    window.localStorage.setItem(SEEN_KEY(patientId), JSON.stringify([...ids]));
  } catch {
    /* storage blocked: the reply simply shows as new again next time */
  }
}

const hasReply = (t: PatientFollowUp): boolean => Boolean(t.reply);

/** Urgent first, then replies not yet seen, then the order the caller already chose. */
function byPriority(unseen: Set<string>) {
  return (a: PatientFollowUp, b: PatientFollowUp): number => {
    const urgent = Number(Boolean(b.urgent)) - Number(Boolean(a.urgent));
    if (urgent !== 0) return urgent;
    return Number(unseen.has(b.id)) - Number(unseen.has(a.id));
  };
}

export function ReplyBlock({ task }: { task: PatientFollowUp }) {
  if (!task.reply) return null;
  return (
    <section aria-label="Reply from the care team" data-testid="care-team-reply" className="mt-3 rounded-md border border-rule border-l-[3px] border-l-done bg-paper px-3 py-2.5">
      <h3 className="font-bold text-done">Reply from the care team</h3>
      {task.repliedAt ? <p className="text-sm text-muted-foreground tabular-nums">{formatIST(task.repliedAt, 'date-time')}</p> : null}
      <p className="mt-1 whitespace-pre-wrap text-ink">{task.reply}</p>
    </section>
  );
}

function TaskRow({ task, isNew }: { task: PatientFollowUp; isNew: boolean }) {
  const closed = isClosed(task.status);
  return (
    <li
      className={cn('border-l-[3px] px-4 py-3', isNew ? 'border-l-ink' : task.status === 'resolved' ? 'border-l-done' : 'border-l-rule')}
      data-status={task.status}
      {...(task.urgent ? { 'data-urgent': 'true' } : {})}
    >
      {task.urgent || isNew ? (
        <p className="mb-1 flex flex-wrap items-center gap-2">
          {task.urgent ? (
            <span className="inline-flex items-center gap-1 rounded-sm bg-priority/10 px-1.5 py-0.5 text-sm font-bold text-priority">
              <TriangleAlert aria-hidden="true" className="size-4" />
              Urgent
            </span>
          ) : null}
          {isNew ? (
            <span data-testid="new-reply-mark" className="rounded-sm bg-ink px-1.5 py-0.5 text-sm font-bold text-white">
              New reply
            </span>
          ) : null}
        </p>
      ) : null}
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
      <ReplyBlock task={task} />
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
  // Replies seen on an earlier visit are remembered per patient on this device. The set is read once, so a reply stays
  // marked as new for the whole visit that first showed it (the notification link lands here).
  const [seenBefore] = useState(() => readSeen(patientId));
  const unseen = useMemo(() => new Set((q.data ?? []).filter((t) => hasReply(t) && !seenBefore.has(t.id)).map((t) => t.id)), [q.data, seenBefore]);
  useEffect(() => {
    if (!patientId || !q.data) return;
    const replied = q.data.filter(hasReply).map((t) => t.id);
    if (replied.some((id) => !seenBefore.has(id))) writeSeen(patientId, new Set([...seenBefore, ...replied]));
  }, [patientId, q.data, seenBefore]);

  const open = (q.data ?? []).filter((t) => !isClosed(t.status)).sort((a, b) => a.dueAt.localeCompare(b.dueAt)).sort(byPriority(unseen));
  const done = (q.data ?? [])
    .filter((t) => isClosed(t.status))
    .sort((a, b) => (b.resolvedAt ?? b.createdAt).localeCompare(a.resolvedAt ?? a.createdAt))
    .sort(byPriority(unseen));

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
          {unseen.size > 0 ? (
            <p role="status" className="rounded-md border border-l-[3px] border-rule border-l-ink bg-surface px-4 py-3 font-bold">
              {unseen.size === 1 ? '1 new reply from the care team' : `${unseen.size} new replies from the care team`}
            </p>
          ) : null}
          <section aria-labelledby="open-h">
            <h2 id="open-h" className="mb-2 text-lg font-bold">
              In progress
            </h2>
            {open.length === 0 ? (
              <p className="rounded-xl border border-rule bg-surface px-4 py-4 text-muted-foreground">Nothing is waiting on the team right now.</p>
            ) : (
              <ul className="divide-y divide-rule overflow-hidden rounded-xl border border-rule bg-surface">
                {open.map((t) => (
                  <TaskRow key={t.id} task={t} isNew={unseen.has(t.id)} />
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
                  <TaskRow key={t.id} task={t} isNew={unseen.has(t.id)} />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </PatientPage>
  );
}
