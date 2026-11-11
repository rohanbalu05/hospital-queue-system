import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ResolveTaskRequest, type Appointment, type Disposition } from '@hqms/contracts';
import { useResolveTask, type FollowUpTaskView } from '@/api';
import { Field } from '@/components/layout/Field';
import { InlineAlert } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { formatLocalDate, istDate } from '@/lib/dates';
import { DISPOSITIONS, DISPOSITION_WORD } from '@/lib/followup';
import { formatIST } from '@/lib/format';

interface DispositionFormProps {
  task: FollowUpTaskView;
  /** Set once "Book return visit" succeeded: prefills the disposition. */
  booked: Appointment | null;
  /** Move focus to the first field on mount (after Acknowledge, for keyboard users). */
  focusOnMount?: boolean;
  onBookReturn: () => void;
  onCancel: () => void;
}

export function bookedWord(a: Appointment): string {
  return `${formatLocalDate(istDate(a.scheduledAt))}, ${formatIST(a.scheduledAt)} with ${a.doctorName}`;
}

/** Disposition select, outcome note, Resolve. "Return booked" needs a linked return appointment (FR-11, FR-14). */
export function DispositionForm({ task, booked, focusOnMount, onBookReturn, onCancel }: DispositionFormProps) {
  const [disposition, setDisposition] = useState<Disposition | ''>('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<{ disposition?: string; note?: string }>({});
  const resolve = useResolveTask();
  const selectRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (focusOnMount) selectRef.current?.focus();
  }, [focusOnMount]);

  const bookedId = booked?.id ?? task.returnAppointmentId ?? null;
  const bookedId0 = useRef(bookedId);
  useEffect(() => {
    // A return visit was just booked from this screen: prefill the outcome and move to the note.
    if (booked && booked.id !== bookedId0.current) {
      bookedId0.current = booked.id;
      setDisposition('return_booked');
      setNote((n) => n || `Return visit booked: ${bookedWord(booked)}.`);
      setErrors({});
      noteRef.current?.focus();
    }
  }, [booked]);

  const submit = () => {
    const next: typeof errors = {};
    if (!disposition) next.disposition = 'Choose what happened.';
    if (note.trim().length < 3) next.note = 'Add a short outcome note, at least 3 characters.';
    if (disposition === 'return_booked' && !bookedId) next.disposition = 'Book the return visit first, or choose another outcome.';
    setErrors(next);
    if (next.disposition || next.note || !disposition) return;
    const body = {
      expectedVersion: task.version,
      disposition,
      outcomeNote: note.trim(),
      ...(disposition === 'return_booked' && bookedId ? { returnAppointmentId: bookedId } : {}),
    };
    if (!ResolveTaskRequest.safeParse(body).success) {
      setErrors({ note: 'Check the outcome note and try again.' });
      return;
    }
    resolve.mutate({ taskId: task.id, ...body }, { onSuccess: () => toast.success('Resolved') });
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      noValidate
    >
      <Field label="Outcome" error={errors.disposition ?? null}>
        {(p) => (
          <Select
            value={disposition}
            onValueChange={(v) => {
              setDisposition(v as Disposition);
              setErrors((x) => ({ ...x, disposition: undefined }));
            }}
          >
            <SelectTrigger {...p} ref={selectRef} className="w-full">
              <SelectValue placeholder="Choose an outcome" />
            </SelectTrigger>
            <SelectContent>
              {DISPOSITIONS.map((d) => (
                <SelectItem key={d} value={d}>
                  {DISPOSITION_WORD[d]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>

      {disposition === 'return_booked' ? (
        bookedId ? (
          <InlineAlert tone="notice" title="Return visit linked">
            {booked ? bookedWord(booked) : 'A return visit is already linked to this task.'}
          </InlineAlert>
        ) : (
          <p className="text-sm text-muted-foreground">No return visit is linked yet. Use Book return visit below, then resolve.</p>
        )
      ) : null}

      <Field label="Outcome note" hint="What you told or did for the patient. Staff see this; the patient does not." error={errors.note ?? null}>
        <Textarea
          ref={noteRef}
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            setErrors((x) => ({ ...x, note: undefined }));
          }}
          rows={4}
          maxLength={2000}
        />
      </Field>

      {resolve.isError ? <InlineAlert title="The task was not resolved">{resolve.error.message}</InlineAlert> : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="lg" disabled={resolve.isPending}>
          {resolve.isPending ? 'Resolving…' : 'Resolve task'}
        </Button>
        <Button type="button" variant="outline" size="lg" onClick={onBookReturn} disabled={resolve.isPending}>
          Book return visit
        </Button>
        <Button type="button" variant="outline" size="lg" className="ml-auto text-priority" onClick={onCancel} disabled={resolve.isPending}>
          Cancel task
        </Button>
      </div>
    </form>
  );
}
