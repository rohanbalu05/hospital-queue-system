import { useEffect, useId, useState, type FormEvent } from 'react';
import { MarkUnavailableRequest, type SessionAvailability, type StepAwayRequest } from '@hqms/contracts';
import { Field } from '@/components/layout/Field';
import { InlineAlert } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useNow } from '@/lib/useNow';
import { cn } from '@/lib/utils';
import {
  AWAY_REASONS,
  RETURN_PRESETS,
  backAboutText,
  clock,
  reasonProblem,
  reasonText,
  returnAfter,
  returnAtTime,
  returnProblem,
  type AwayReason,
} from './availability';

/** Reset local form state every time a dialog opens. */
function useResetOnOpen(open: boolean, reset: () => void) {
  useEffect(() => {
    if (open) reset();
  }, [open]);
}

interface DialogBase {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  /** Server refusal in plain words (DOCTOR_OCCUPIED, return after the session end ...). Shown inside the dialog. */
  error: string | null;
}

type Return = { kind: 'preset'; minutes: number } | { kind: 'custom' };

interface StepAwayDialogProps extends DialogBase {
  /** Whose absence this is: "you" on the doctor's own screen, else the doctor's name (reception). */
  subject: string;
  /** IST date of the session (YYYY-MM-DD), to turn the custom time into an instant. */
  sessionDate: string;
  sessionEndsAt: string;
  /** Present while already away: the dialog then changes the return time instead of starting an absence. */
  current: SessionAvailability | null;
  onSubmit: (request: StepAwayRequest) => void;
}

/**
 * Step away (B1): a reason and an expected return. Presets of 10, 15, 30 and 60 minutes, or a custom time.
 * The computed "Back about 10:45 am" is shown before anything is sent. Fully keyboard operable.
 */
export function StepAwayDialog({ open, onOpenChange, pending, error, subject, sessionDate, sessionEndsAt, current, onSubmit }: StepAwayDialogProps) {
  const ids = useId();
  const now = new Date(useNow(15_000));
  const changing = current?.state === 'away';
  const [reason, setReason] = useState<AwayReason>('Ward round / emergency');
  const [other, setOther] = useState('');
  const [ret, setRet] = useState<Return>({ kind: 'preset', minutes: 15 });
  const [custom, setCustom] = useState('');
  const [touched, setTouched] = useState(false);

  useResetOnOpen(open, () => {
    const known = AWAY_REASONS.find((r) => r === current?.reason);
    setReason(known ?? (current?.reason ? 'Other' : 'Ward round / emergency'));
    setOther(!known && current?.reason ? current.reason : '');
    setRet({ kind: 'preset', minutes: 15 });
    setCustom('');
    setTouched(false);
  });

  const until = ret.kind === 'preset' ? returnAfter(now, ret.minutes) : custom ? returnAtTime(sessionDate, custom) : null;
  const timeProblem = until ? returnProblem(until, now, sessionEndsAt) : null;
  const customMessage =
    ret.kind === 'custom' && touched && !until
      ? 'Choose a return time.'
      : timeProblem === 'not_future'
        ? `Choose a time later than now (${clock(now)}).`
        : timeProblem === 'after_end'
          ? `The session ends at ${clock(sessionEndsAt)}. Choose an earlier time, or mark the doctor unavailable for the rest of the session instead.`
          : null;
  const reasonMessage = touched ? reasonProblem(reason, other) : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!until || timeProblem || reasonProblem(reason, other)) return;
    onSubmit({ until: until.toISOString(), reason: reasonText(reason, other) });
  }

  const self = subject === 'you';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto">
        <form onSubmit={submit} className="grid gap-5" noValidate>
          <DialogHeader>
            <DialogTitle>{changing ? 'Change return time' : 'Step away'}</DialogTitle>
            <DialogDescription>
              {changing
                ? 'Patients are told the new time. The queue keeps its order.'
                : self
                  ? 'No one is called while you are away. Waiting patients keep their place and are told.'
                  : `No one is called for ${subject} while they are away. Waiting patients keep their place and are told.`}
            </DialogDescription>
          </DialogHeader>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-bold">Reason</legend>
            <RadioGroup value={reason} onValueChange={(v) => setReason(v as AwayReason)} className="gap-1">
              {AWAY_REASONS.map((r) => {
                const id = `${ids}-reason-${r}`;
                return (
                  <div key={r} className="flex min-h-10 items-center gap-3">
                    <RadioGroupItem id={id} value={r} />
                    <Label htmlFor={id} className="flex-1 cursor-pointer text-base">
                      {r}
                    </Label>
                  </div>
                );
              })}
            </RadioGroup>
            {reason === 'Other' ? (
              <Field label="Other reason" error={reasonMessage}>
                {(p) => <Input {...p} value={other} onChange={(e) => setOther(e.target.value)} maxLength={300} autoComplete="off" />}
              </Field>
            ) : null}
          </fieldset>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-bold">Expected return</legend>
            <div role="group" aria-label="Expected return" className="flex flex-wrap gap-2">
              {RETURN_PRESETS.map((m) => {
                const on = ret.kind === 'preset' && ret.minutes === m;
                return (
                  <Button
                    key={m}
                    type="button"
                    variant={on ? 'default' : 'outline'}
                    aria-pressed={on}
                    className="min-w-16"
                    onClick={() => setRet({ kind: 'preset', minutes: m })}
                  >
                    {m} min
                  </Button>
                );
              })}
              <Button type="button" variant={ret.kind === 'custom' ? 'default' : 'outline'} aria-pressed={ret.kind === 'custom'} onClick={() => setRet({ kind: 'custom' })}>
                Custom time
              </Button>
            </div>
            {ret.kind === 'custom' ? (
              <Field label="Back at (India time)" error={customMessage}>
                {(p) => <Input {...p} type="time" value={custom} onChange={(e) => setCustom(e.target.value)} className="w-40" />}
              </Field>
            ) : null}
            <p
              role="status"
              data-testid="back-about"
              className={cn('text-lg font-bold tabular-nums', (timeProblem || (ret.kind === 'custom' && !until)) && 'text-muted-foreground')}
            >
              {until && !timeProblem ? backAboutText(until) : 'Choose when you expect to be back.'}
            </p>
            {ret.kind === 'preset' && timeProblem === 'after_end' ? <p className="font-bold">{customMessage}</p> : null}
          </fieldset>

          {error ? <InlineAlert title="Not changed">{error}</InlineAlert> : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : changing ? 'Update return time' : 'Step away'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface UnavailableDialogProps extends DialogBase {
  subject: string;
  onSubmit: (reason: string) => void;
}

/**
 * Unavailable for the rest of the session (B1): one-way, so it states what happens and asks for a reason.
 * The confirm button says exactly what it does.
 */
export function UnavailableDialog({ open, onOpenChange, pending, error, subject, onSubmit }: UnavailableDialogProps) {
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    setReason('');
    setMessage(null);
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!MarkUnavailableRequest.safeParse({ reason: reason.trim() }).success) {
      setMessage('Give a reason of at least 3 characters.');
      return;
    }
    setMessage(null);
    onSubmit(reason.trim());
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{subject === 'you' ? 'Unavailable for the rest of this session' : `Mark ${subject} unavailable for the rest of this session`}</DialogTitle>
            <DialogDescription>
              Patients waiting and booked for this session will be told and offered other doctors. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <Field label="Reason" hint="For example: called to emergency theatre." error={message}>
            {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoComplete="off" />}
          </Field>
          {error ? <InlineAlert title="Not changed">{error}</InlineAlert> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? 'Saving…' : 'Mark unavailable and notify patients'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
