import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import type { Appointment } from '@hqms/contracts';
import { useAcknowledgeTask, useFollowUpTask } from '@/api';
import { ContactPanel, OutcomePanel, UrgentGuidance } from '@/components/followup/task-parts';
import { TaskStatusWord, TimingWord } from '@/components/followup/words';
import { StaffShell } from '@/components/layout/Shells';
import { ErrorState, SkeletonRows } from '@/components/queue';
import { InlineAlert } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { ApiRequestError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatIST } from '@/lib/format';
import { KIND_WORD, isClosed } from '@/lib/followup';
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
      {task.urgent && !closed ? <UrgentGuidance className="mb-4" /> : null}
      {/* DOM order is contact, action, status: on a phone the number and the form come before the bookkeeping. */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_440px]">
        <div className="lg:col-start-1 lg:row-start-1">
          <ContactPanel task={task} />
        </div>

        <section aria-labelledby="action-h" className="rounded-xl border border-rule bg-surface p-4 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <h2 id="action-h" className="mb-3 text-lg font-bold">
            {closed ? 'Outcome' : task.status === 'open' ? 'Take this task' : 'Record the outcome'}
          </h2>

          {closed ? (
            <OutcomePanel task={task} />
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

        <section aria-labelledby="task-h" className="rounded-xl border border-rule bg-surface p-4 lg:col-start-1 lg:row-start-2">
          <h2 id="task-h" className="mb-1 text-lg font-bold">
            Task status
          </h2>
          <dl>
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
