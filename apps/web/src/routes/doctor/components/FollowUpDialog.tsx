import { useEffect, useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { QueueEntry } from '@hqms/contracts';
import { useCreateFollowUpTask } from '@/api/queue';
import { Field } from '@/components/layout/Field';
import { InlineAlert } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiRequestError } from '@/lib/api';
import { addDays, formatLocalDate, istDate } from '@/lib/dates';
import { cn } from '@/lib/utils';

export const FOLLOW_UP_PRESETS = ['Review test results', 'Check medication response', 'Call with report'] as const;
const OTHER = 'other';
const DUE_CHOICES = [
  { value: '1', label: '1 day' },
  { value: '3', label: '3 days' },
  { value: '7', label: '7 days' },
  { value: '14', label: '14 days' },
  { value: 'date', label: 'Choose a date' },
] as const;

/** What the doctor sees after creating one: kept on the panel, with no link anywhere. */
export interface CreatedFollowUp {
  title: string;
  dueAt: string;
}

/** Due at 5 pm hospital time on the chosen day, so the task is not overdue by morning. */
const dueAtFor = (date: string) => new Date(`${date}T17:00:00+05:30`).toISOString();

function errorWords(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.code === 'NETWORK')
      return `${err.message} Press Create follow-up again: the same request is sent, so only one task is made.`;
    if (err.code === 'FORBIDDEN') return 'Your account cannot create follow-ups.';
    return err.message;
  }
  return 'Something went wrong. Nothing was created. Try again.';
}

interface FollowUpDialogProps {
  /** The patient the follow-up is for: the one in service, or the one just completed. */
  entry: QueueEntry | null;
  onClose: () => void;
  onCreated: (visitId: string, created: CreatedFollowUp) => void;
}

/**
 * PR-32: the doctor creates an owned follow-up task for a patient from the console. Title presets, optional detail, and a due
 * interval. The task goes to the follow-up team's inbox (POST /follow-up-tasks, kind post_visit, linked to this visit).
 */
export function FollowUpDialog({ entry, onClose, onCreated }: FollowUpDialogProps) {
  const ids = useId();
  const create = useCreateFollowUpTask();
  const [preset, setPreset] = useState<string>(FOLLOW_UP_PRESETS[0]);
  const [custom, setCustom] = useState('');
  const [detail, setDetail] = useState('');
  const [dueIn, setDueIn] = useState('3');
  const [dueDate, setDueDate] = useState('');
  const [errors, setErrors] = useState<{ title?: string; date?: string }>({});

  const open = entry !== null;
  useEffect(() => {
    if (!open) return;
    setPreset(FOLLOW_UP_PRESETS[0]);
    setCustom('');
    setDetail('');
    setDueIn('3');
    setDueDate('');
    setErrors({});
    create.reset();
  }, [open, entry?.id]);

  const tomorrow = addDays(istDate(), 1);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!entry || create.isPending) return;
    const title = preset === OTHER ? custom.trim() : preset;
    const next: typeof errors = {};
    if (title.length < 3) next.title = 'Enter a title of at least 3 letters.';
    let due = '';
    if (dueIn === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || dueDate < tomorrow) next.date = 'Choose a date from tomorrow on.';
      else due = dueDate;
    } else {
      due = addDays(istDate(), Number(dueIn));
    }
    setErrors(next);
    if (next.title || next.date) return;
    const dueAt = dueAtFor(due);
    create.mutate(
      {
        patientId: entry.patientId,
        sourceVisitId: entry.visitId,
        kind: 'post_visit',
        title,
        ...(detail.trim() ? { detail: detail.trim() } : {}),
        dueAt,
      },
      {
        onSuccess: () => {
          toast.success('Follow-up created', {
            description: `${title} for ${entry.patientName}, due ${formatLocalDate(due)}. The follow-up team will see it.`,
          });
          onCreated(entry.visitId, { title, dueAt });
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto">
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Create follow-up for {entry?.patientName}</DialogTitle>
            <DialogDescription>
              A follow-up nurse takes this task and records what was done. It is linked to {entry?.token}&apos;s visit
              today.
            </DialogDescription>
          </DialogHeader>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-bold">What needs following up</legend>
            <RadioGroup
              value={preset}
              onValueChange={setPreset}
              aria-label="What needs following up"
              className="gap-0 divide-y divide-rule overflow-hidden rounded-md border border-rule"
            >
              {[...FOLLOW_UP_PRESETS, OTHER].map((p) => {
                const id = `${ids}-${p}`;
                return (
                  <Label
                    key={p}
                    htmlFor={id}
                    className={cn(
                      'flex min-h-11 cursor-pointer items-center gap-3 px-3 text-sm font-normal',
                      preset === p && 'bg-secondary',
                    )}
                  >
                    <RadioGroupItem id={id} value={p} />
                    <span className={cn(preset === p && 'font-bold')}>{p === OTHER ? 'Something else' : p}</span>
                  </Label>
                );
              })}
            </RadioGroup>
            {preset === OTHER ? (
              <Field label="Title" error={errors.title ?? null}>
                <Input
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  maxLength={160}
                  autoComplete="off"
                  autoFocus
                />
              </Field>
            ) : null}
          </fieldset>

          <Field label="Detail (optional)" hint="What the nurse should check or say.">
            <Textarea value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={2000} rows={3} />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Due in">
              {(f) => (
                <Select value={dueIn} onValueChange={setDueIn}>
                  <SelectTrigger {...f} className="h-10 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DUE_CHOICES.map((d) => (
                      <SelectItem key={d.value} value={d.value}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            {dueIn === 'date' ? (
              <Field label="Due date" error={errors.date ?? null}>
                <Input type="date" min={tomorrow} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </Field>
            ) : null}
          </div>

          {create.error ? (
            <InlineAlert title="The follow-up was not created">{errorWords(create.error)}</InlineAlert>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={create.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create follow-up'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
