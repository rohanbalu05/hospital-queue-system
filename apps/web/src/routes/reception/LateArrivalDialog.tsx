import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { InlineAlert } from '@/components/scheduling/status';
import { formatIST } from '@/lib/format';
import type { PanelError } from './model';

/** Who is late and when their appointment was. The check-in path passes an arrival; the re-enter path a queue entry. */
export interface LateSubject {
  name: string;
  scheduledAt: string | null;
  /** check-in: the arrival is late. re-enter: a skipped or absent patient comes back after their grace. */
  mode?: 'check-in' | 're-enter';
}

interface LateArrivalDialogProps {
  open: boolean;
  subject: LateSubject | null;
  minutesLate: number;
  graceMin?: number;
  pending: boolean;
  error: PanelError | null;
  onAdmit: () => void;
  onClose: () => void;
  /** After the dialog has closed: put focus back where the next arrival is typed. */
  onClosed: () => void;
}

/** 409 LATE_ARRIVAL_REQUIRES_REVIEW: staff decide. Default focus is "Not now" so Enter never admits by accident. */
export function LateArrivalDialog({ open, subject, minutesLate, graceMin = 15, pending, error, onAdmit, onClose, onClosed }: LateArrivalDialogProps) {
  const returning = subject?.mode === 're-enter';
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          onClosed();
        }}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector<HTMLElement>('[data-autofocus]')?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{returning ? `Returned ${minutesLate} min after the appointment` : `Arrived ${minutesLate} min late`}</DialogTitle>
          <DialogDescription className="text-base text-ink">
            {subject ? (
              <>
                {subject.name} had an appointment at <span className="tabular-nums">{subject.scheduledAt ? formatIST(subject.scheduledAt) : '-'}</span>. This is after the{' '}
                {graceMin} min grace.{' '}
                {returning ? 'Re-entering them puts them back in walk-in order.' : 'Admitting uses a walk-in place and walk-in order.'}
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <InlineAlert title={error.title}>
            <p>{error.message}</p>
            {error.hint ? <p className="mt-1">{error.hint}</p> : null}
          </InlineAlert>
        ) : null}
        <DialogFooter>
          <Button data-autofocus variant="outline" size="lg" onClick={onClose} disabled={pending}>
            Not now
          </Button>
          <Button size="lg" onClick={onAdmit} disabled={pending}>
            {pending ? 'Admitting…' : 'Admit as late arrival'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
