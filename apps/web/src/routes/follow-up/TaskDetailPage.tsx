import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import type { Appointment } from '@hqms/contracts';
import { useAcknowledgeTask, useFollowUpTask } from '@/api';
import { TaskStatusWord, TimingWord } from '@/components/followup/words';
import { StaffShell } from '@/components/layout/Shells';
import { ErrorState, SkeletonRows } from '@/components/queue';
import { InlineAlert } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { ApiRequestError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatLocalDate } from '@/lib/dates';
import { formatIST } from '@/lib/format';
import { DISPOSITION_WORD, KIND_WORD, isClosed, shortId, sourceVisitWord } from '@/lib/followup';
import { useNow } from '@/lib/useNow';
import { CancelTaskDialog } from './components/CancelTaskDialog';
import { DispositionForm, bookedWord } from './components/DispositionForm';
import { ReturnBookingDialog } from './components/ReturnBookingDialog';

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-x-3 border-b border-rule py-2 last:border-b-0">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

export default function TaskDetailPage() {
  const { taskId } = useParams();
  const q = useFollowUpTask(taskId);
  const { me } = useAuth();
  const now = useNow();
  const ack = useAcknowledgeTask();
  const [returnOpen, setReturnOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [booked, setBooked] = useState<Appointment | null>(null);
  const [justAcknowledged, setJustAcknowledged] = useState(false);
  const task = q.data;

  const back = (
    <Link to="/follow-up" className="font-bold underline underline-offset-2 focus-visible:rounded-xs">
      All follow-up tasks
    </Link>
  );

  if (q.isPending) {
    return (
      <StaffShell title="Follow-up task" actions={back}>
        <SkeletonRows count={7} />
      </StaffShell>
    );
  }
  if (!task) {
    const notFound = q.error instanceof ApiRequestError && q.error.status === 404;
    return (
      <StaffShell title="Follow-up task" actions={back}>
        <ErrorState
          title={notFound ? 'This task was not found' : 'The task could not be loaded'}
          error={q.error}
          {...(notFound ? { hint: 'It may have been removed, or it belongs to a doctor outside your assignments.' } : {})}
          onRetry={() => void q.refetch()}
        />
      </StaffShell>
    );
  }

  const closed = isClosed(task.status);
  const ownedByOther = task.ownerId !== null && me !== null && task.ownerId !== me.userId;
  const stale = ack.error instanceof ApiRequestError && ack.error.code === 'CONFLICT';

  const acknowledge = () => {
    ack.mutate(
      { taskId: task.id, expectedVersion: task.version },
      {
        onSuccess: () => {
          setJustAcknowledged(true);
          toast.success('Acknowledged');
        },
      },
    );
  };

  return (
    <StaffShell title={task.title} description={`${task.patientName}. ${KIND_WORD[task.kind] ?? task.kind}.`} actions={back}>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_440px]">
        <section aria-labelledby="task-h" className="rounded-xl border border-rule bg-surface p-4">
          <h2 id="task-h" className="mb-1 text-lg font-bold">
            Task
          </h2>
          <dl>
            <Row term="Patient">
              <span className="font-bold">{task.patientName}</span>
            </Row>
            <Row term="Source visit">{sourceVisitWord(task, (d) => formatLocalDate(d))}{task.sourceVisit ? `, ${task.sourceVisit.department}` : ''}</Row>
            <Row term="Status">
              <TaskStatusWord status={task.status} />
            </Row>
            <Row term="Due">
              <span className="tabular-nums">{formatIST(task.dueAt, 'date-time')}</span>
              {!closed ? (
                <>
                  {' '}
                  <TimingWord task={task} now={now} />
                </>
              ) : null}
            </Row>
            <Row term="Owner">{task.ownerName ?? <span className="text-muted-foreground">Unassigned</span>}</Row>
            <Row term="Created">
              <span className="tabular-nums">{formatIST(task.createdAt, 'date-time')}</span>
            </Row>
            {task.acknowledgedAt ? (
              <Row term="Acknowledged">
                <span className="tabular-nums">{formatIST(task.acknowledgedAt, 'date-time')}</span>
              </Row>
            ) : null}
          </dl>
          <h3 className="mt-4 mb-1 font-bold">Detail</h3>
          {task.detail ? <p className="max-w-prose whitespace-pre-wrap">{task.detail}</p> : <p className="text-muted-foreground">No further detail was written for this task.</p>}
        </section>

        <section aria-labelledby="action-h" className="rounded-xl border border-rule bg-surface p-4">
          <h2 id="action-h" className="mb-3 text-lg font-bold">
            {closed ? 'Outcome' : task.status === 'open' ? 'Take this task' : 'Record the outcome'}
          </h2>

          {closed ? (
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
              {task.outcomeNote ? <p className="whitespace-pre-wrap">{task.outcomeNote}</p> : null}
              {task.returnAppointmentId ? (
                <p className="text-sm text-muted-foreground">Return visit linked, reference {shortId(task.returnAppointmentId)}.</p>
              ) : null}
            </div>
          ) : task.status === 'open' ? (
            <div className="grid gap-3">
              <p className="max-w-prose">Acknowledging makes you the owner. The task stays on your list, and overdue, until you resolve or cancel it.</p>
              {ack.isError ? (
                <InlineAlert title="Not acknowledged">
                  {ack.error.message}
                  {stale ? ' Someone else changed this task. Reload it, then try again.' : ''}
                </InlineAlert>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button size="lg" onClick={acknowledge} disabled={ack.isPending}>
                  {ack.isPending ? 'Acknowledging…' : 'Acknowledge'}
                </Button>
                {stale ? (
                  <Button variant="outline" size="lg" onClick={() => void q.refetch()}>
                    Reload task
                  </Button>
                ) : null}
                <Button variant="outline" size="lg" className="text-priority" onClick={() => setCancelOpen(true)}>
                  Cancel task
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid gap-3">
              {ownedByOther ? (
                <InlineAlert tone="notice" title={`Owned by ${task.ownerName ?? 'another staff member'}`}>
                  You can still record the outcome. The audit trail shows who did.
                </InlineAlert>
              ) : null}
              <DispositionForm task={task} booked={booked} focusOnMount={justAcknowledged} onBookReturn={() => setReturnOpen(true)} onCancel={() => setCancelOpen(true)} />
            </div>
          )}
          {booked && !closed ? <p className="mt-3 text-sm text-muted-foreground">Booked: {bookedWord(booked)}.</p> : null}
        </section>
      </div>

      <ReturnBookingDialog
        open={returnOpen}
        task={task}
        onOpenChange={setReturnOpen}
        onBooked={(appt) => {
          setBooked(appt);
          setReturnOpen(false);
          toast.success('Return visit booked');
        }}
      />
      <CancelTaskDialog open={cancelOpen} task={task} onOpenChange={setCancelOpen} />
    </StaffShell>
  );
}
