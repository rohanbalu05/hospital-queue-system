import type { ReactNode } from 'react';
import type { FollowUpTaskView } from '@/api';
import { Button } from '@/components/ui/button';
import { formatLocalDate } from '@/lib/dates';
import { formatIST } from '@/lib/format';
import { DISPOSITION_WORD, isClosed, shortId, sortTasks, sourceVisitWord } from '@/lib/followup';
import { cn } from '@/lib/utils';
import { TaskStatusWord } from './words';

/** Urgent (red-flag) tasks: the word "Urgent" in the priority tone, tinted like a queue tag. Never colour alone (PR-13). */
export function UrgentTag({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex h-5 shrink-0 items-center rounded-xs bg-priority/10 px-1.5 text-xs leading-none font-bold text-priority', className)}>
      Urgent
    </span>
  );
}

/** Guidance shown on an unresolved urgent task: the patient reported red-flag symptoms, so staff call rather than write. */
export function UrgentGuidance({ className }: { className?: string }) {
  return (
    <div role="alert" className={cn('rounded-md border border-l-[3px] border-rule border-l-priority bg-surface px-3 py-2.5', className)}>
      <p className="flex flex-wrap items-center gap-2 font-bold">
        <UrgentTag />
        <span>Red-flag symptoms reported. Call the patient now.</span>
      </p>
      <p className="mt-0.5 text-muted-foreground">If you cannot reach them, try again and ask the doctor whether to advise Emergency.</p>
    </div>
  );
}

/** Urgent open tasks first, then the usual order (overdue, then earliest due, closed last). */
export function sortInboxTasks<T extends Pick<FollowUpTaskView, 'status' | 'dueAt' | 'overdue' | 'urgent'>>(tasks: readonly T[], now: number): T[] {
  const isUrgent = (t: T) => t.urgent === true && !isClosed(t.status);
  const ordered = sortTasks(tasks, now);
  return [...ordered.filter(isUrgent), ...ordered.filter((t) => !isUrgent(t))];
}

/** "tel:" target: digits and a leading plus only. */
export const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`;

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-x-3 border-b border-rule py-2 last:border-b-0">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/**
 * How to reach the patient (PR-38): name, MRN, phone as a tap target, the doctor, the source visit and what the call is about.
 * Staff in scope may see the phone; it is shown plainly, not masked.
 */
export function ContactPanel({ task }: { task: FollowUpTaskView }) {
  const doctor = task.doctorName ?? task.sourceVisit?.doctorName ?? null;
  const phone = task.patientPhone ?? null;
  return (
    <section aria-labelledby="contact-h" className="rounded-xl border border-rule bg-surface p-4">
      <h2 id="contact-h" className="mb-1 text-lg font-bold">
        Reach the patient
      </h2>
      {phone ? (
        <Button asChild variant="outline" size="lg" className="my-2 h-12 w-full justify-start text-lg font-bold tabular-nums sm:w-auto">
          <a href={telHref(phone)} aria-label={`Call ${task.patientName} on ${phone}`}>
            <span className="font-normal text-muted-foreground">Call</span> {phone}
          </a>
        </Button>
      ) : (
        <p className="my-2 rounded-md border border-l-[3px] border-rule border-l-ink px-3 py-2">
          <span className="font-bold">No phone number on record.</span> <span className="text-muted-foreground">Ask reception to confirm the patient's contact details.</span>
        </p>
      )}
      <dl>
        <Row term="Patient">
          <span className="font-bold">{task.patientName}</span>
        </Row>
        <Row term="MRN">{task.patientMrn ? <span className="tabular-nums">{task.patientMrn}</span> : <span className="text-muted-foreground">Not available</span>}</Row>
        <Row term="Doctor">{doctor ?? <span className="text-muted-foreground">Not recorded</span>}</Row>
        <Row term="Source visit">
          {sourceVisitWord(task, (d) => formatLocalDate(d))}
          {task.sourceVisit ? `, ${task.sourceVisit.department}` : ''}
        </Row>
      </dl>
      <h3 className="mt-4 mb-1 font-bold">Reason for the call</h3>
      <p className="max-w-prose whitespace-pre-wrap">{task.detail ?? task.title}</p>
    </section>
  );
}

/** The outcome of a closed task: what the patient was told, kept apart from the staff-only note. */
export function OutcomePanel({ task }: { task: FollowUpTaskView }) {
  const resolved = task.status === 'resolved';
  return (
    <div className="grid gap-3">
      <p>
        <TaskStatusWord status={task.status} />
        {task.resolvedAt ? <span className="tabular-nums"> {formatIST(task.resolvedAt, 'date-time')}</span> : null}
      </p>
      {task.disposition ? (
        <p>
          <span className="text-muted-foreground">Outcome: </span>
          <span className="font-bold">{DISPOSITION_WORD[task.disposition]}</span>
        </p>
      ) : null}
      {resolved ? (
        task.patientReply ? (
          <div>
            <h3 className="font-bold">Reply sent to the patient</h3>
            <p className="mt-0.5 border-l-[3px] border-l-done pl-3 whitespace-pre-wrap">{task.patientReply}</p>
          </div>
        ) : (
          <p className="text-muted-foreground">No reply was sent to the patient.</p>
        )
      ) : null}
      {task.outcomeNote ? (
        <div>
          <h3 className="font-bold">{resolved ? 'Staff note' : 'Reason for cancelling'}</h3>
          {resolved ? <p className="text-sm text-muted-foreground">Staff only. The patient does not see this.</p> : null}
          <p className="mt-0.5 whitespace-pre-wrap">{task.outcomeNote}</p>
        </div>
      ) : null}
      {task.returnAppointmentId ? <p className="text-sm text-muted-foreground">Return visit linked, reference {shortId(task.returnAppointmentId)}.</p> : null}
    </div>
  );
}
