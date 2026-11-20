import { useState } from 'react';
import { toast } from 'sonner';
import type { Session } from '@hqms/contracts';
import { useReopenSession, useSessionCommand } from '@/api';
import { Field } from '@/components/layout/Field';
import { plainErrorMessage } from '@/components/queue/states';
import { sessionLabelWord } from '@/components/scheduling/sessions';
import { InlineAlert } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { formatLocalDate } from '@/lib/dates';

const describe = (s: Session) => `${s.doctorName}, ${sessionLabelWord(s)} ${formatLocalDate(s.sessionDate)}`;

/** Closing is final, so it asks first. */
export function CloseSessionDialog({ session, onClose }: { session: Session | null; onClose: () => void }) {
  const command = useSessionCommand();
  const { reset } = command;
  const dismiss = () => {
    reset();
    onClose();
  };
  return (
    <Dialog open={session !== null} onOpenChange={(o) => !o && !command.isPending && dismiss()}>
      <DialogContent>
        {session ? (
          <>
            <DialogHeader>
              <DialogTitle>Close this session?</DialogTitle>
              <DialogDescription>
                {describe(session)}. A closed session cannot be opened again. Patients still waiting stay visible, but no one new can be booked into it.
              </DialogDescription>
            </DialogHeader>
            {command.isError ? <InlineAlert title="Session not closed">{plainErrorMessage(command.error)}</InlineAlert> : null}
            <DialogFooter>
              <Button
                variant="outline"
                size="lg"
                disabled={command.isPending}
                onClick={dismiss}
              >
                Keep session open
              </Button>
              <Button
                variant="destructive"
                size="lg"
                disabled={command.isPending}
                onClick={() =>
                  command.mutate(
                    { sessionId: session.id, command: 'close' },
                    {
                      onSuccess: () => {
                        toast.success('Session closed');
                        onClose();
                      },
                    },
                  )
                }
              >
                {command.isPending ? 'Closing…' : 'Close session'}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Admin-only undo of "unavailable for the rest of the session" (PR-30). A reason is required and is audited. */
export function ReopenSessionDialog({ session, onClose }: { session: Session | null; onClose: () => void }) {
  const reopen = useReopenSession();
  const { reset } = reopen;
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const close = () => {
    reset();
    setReason('');
    setFieldError(null);
    onClose();
  };
  const submit = () => {
    if (!session) return;
    if (reason.trim().length < 3) {
      setFieldError('Give a reason of at least 3 characters.');
      return;
    }
    setFieldError(null);
    reopen.mutate(
      { sessionId: session.id, reason: reason.trim() },
      {
        onSuccess: () => {
          toast.success('Session reopened');
          close();
        },
      },
    );
  };

  return (
    <Dialog open={session !== null} onOpenChange={(o) => !o && !reopen.isPending && close()}>
      <DialogContent>
        {session ? (
          <>
            <DialogHeader>
              <DialogTitle>Reopen this session</DialogTitle>
              <DialogDescription>
                {describe(session)}. The doctor becomes available again and waiting patients are told. Patients who were already moved to another doctor stay there.
              </DialogDescription>
            </DialogHeader>
            <form
              className="grid gap-4"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <Field label="Reason" hint="Kept in the audit trail." error={fieldError}>
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={3} />
              </Field>
              {reopen.isError ? <InlineAlert title="Session not reopened">{plainErrorMessage(reopen.error)}</InlineAlert> : null}
              <DialogFooter>
                <Button type="button" variant="outline" size="lg" onClick={close} disabled={reopen.isPending}>
                  Cancel
                </Button>
                <Button type="submit" size="lg" disabled={reopen.isPending}>
                  {reopen.isPending ? 'Reopening…' : 'Reopen session'}
                </Button>
              </DialogFooter>
            </form>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
