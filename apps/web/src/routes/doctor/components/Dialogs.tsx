import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { SetPriorityRequest, type QueueEntry } from '@hqms/contracts';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm font-bold text-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Reset local form state every time a dialog opens. */
function useResetOnOpen(open: boolean, reset: () => void) {
  useEffect(() => {
    if (open) reset();
  }, [open]);
}

/** Keeps the last non-null value so dialog text does not blank out during the close animation. */
function useRemembered<T>(value: T | null): T | null {
  const ref = useRef<T | null>(value);
  if (value !== null) ref.current = value;
  return value ?? ref.current;
}

interface DialogBase {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// Set priority (doctor only)
// ---------------------------------------------------------------------------------------------------------------------

const PRIORITY_OPTIONS = [
  { value: '1', label: 'Class 1, most urgent' },
  { value: '2', label: 'Class 2' },
  { value: '3', label: 'Class 3' },
  { value: 'none', label: 'No priority (clear)' },
] as const;

interface PriorityDialogProps extends DialogBase {
  entry: QueueEntry | null;
  onSubmit: (vars: { priorityClass: number | null; reason: string }) => void;
}

export function PriorityDialog({ open, onOpenChange, pending, entry: entryProp, onSubmit }: PriorityDialogProps) {
  const ids = useId();
  const entry = useRemembered(entryProp);
  const [value, setValue] = useState<string>('1');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  useResetOnOpen(open, () => {
    setValue(entry?.priorityClass ? String(entry.priorityClass) : '1');
    setReason('');
    setError(null);
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const priorityClass = value === 'none' ? null : Number(value);
    const parsed = SetPriorityRequest.safeParse({ priorityClass, reason: reason.trim() });
    if (!parsed.success) {
      setError('Give a reason of at least 3 characters. It is recorded with your name.');
      return;
    }
    setError(null);
    onSubmit({ priorityClass, reason: reason.trim() });
  }

  const reasonId = `${ids}-reason`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Set priority for {entry?.token}</DialogTitle>
            <DialogDescription>
              Priority is a clinical decision. The patient keeps their token and is called ahead of the rotation. Your name and reason are
              recorded.
            </DialogDescription>
          </DialogHeader>
          <Field id={`${ids}-class`} label="Priority class">
            <Select value={value} onValueChange={setValue}>
              <SelectTrigger id={`${ids}-class`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIORITY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id={reasonId} label="Reason" hint="For example: chest pain, post-operative review." error={error}>
            <Input
              id={reasonId}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={300}
              autoComplete="off"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${reasonId}-error` : `${reasonId}-hint`}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {value === 'none' ? 'Clear priority' : 'Set priority'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Mark absent
// ---------------------------------------------------------------------------------------------------------------------

interface AbsentDialogProps extends DialogBase {
  entry: QueueEntry | null;
  onSubmit: (reason: string) => void;
}

export function AbsentDialog({ open, onOpenChange, pending, entry: entryProp, onSubmit }: AbsentDialogProps) {
  const id = useId();
  const entry = useRemembered(entryProp);
  const [reason, setReason] = useState('');
  useResetOnOpen(open, () => setReason(''));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(reason.trim());
          }}
          className="grid gap-4"
        >
          <DialogHeader>
            <DialogTitle>Mark {entry?.token} absent</DialogTitle>
            <DialogDescription>
              {entry?.patientName} leaves the waiting list. You or reception can re-enter them from the skipped list if they return.
            </DialogDescription>
          </DialogHeader>
          <Field id={id} label="Reason (optional)">
            <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoComplete="off" />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={pending}>
              Mark absent
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
