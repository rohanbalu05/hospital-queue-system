import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CancelTaskRequest } from '@hqms/contracts';
import { useCancelTask, type FollowUpTaskView } from '@/api';
import { Field } from '@/components/layout/Field';
import { InlineAlert } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

export function CancelTaskDialog({ open, task, onOpenChange }: { open: boolean; task: FollowUpTaskView; onOpenChange: (o: boolean) => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const cancel = useCancelTask();
  const { reset } = cancel;

  useEffect(() => {
    if (!open) {
      setReason('');
      setError(null);
      reset();
    }
  }, [open, reset]);

  const submit = () => {
    const parsed = CancelTaskRequest.safeParse({ expectedVersion: task.version, reason: reason.trim() });
    if (!parsed.success) {
      setError('Say why the task is being cancelled, in at least 3 characters.');
      return;
    }
    setError(null);
    cancel.mutate(
      { taskId: task.id, expectedVersion: task.version, reason: reason.trim() },
      {
        onSuccess: () => {
          toast.success('Task cancelled');
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !cancel.isPending && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel this task</DialogTitle>
          <DialogDescription>
            {task.patientName}: {task.title}. A cancelled task leaves the inbox and the reason is kept in the audit trail.
          </DialogDescription>
        </DialogHeader>
        <Field label="Reason" error={error}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={3} />
        </Field>
        {cancel.isError ? <InlineAlert title="The task was not cancelled">{cancel.error.message}</InlineAlert> : null}
        <DialogFooter>
          <Button variant="outline" size="lg" onClick={() => onOpenChange(false)} disabled={cancel.isPending}>
            Keep task
          </Button>
          <Button variant="destructive" size="lg" onClick={submit} disabled={cancel.isPending}>
            {cancel.isPending ? 'Cancelling…' : 'Cancel task'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
