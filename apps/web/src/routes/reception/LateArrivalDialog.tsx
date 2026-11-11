import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { InlineAlert } from '@/components/scheduling/status';
import { formatIST } from '@/lib/format';
import type { ArrivalItem, PanelError } from './model';

interface LateArrivalDialogProps {
  open: boolean;
  item: ArrivalItem | null;
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
export function LateArrivalDialog({ open, item, minutesLate, graceMin = 15, pending, error, onAdmit, onClose, onClosed }: LateArrivalDialogProps) {
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
          <DialogTitle>Arrived {minutesLate} min late</DialogTitle>
          <DialogDescription className="text-base text-ink">
            {item ? (
              <>
                {item.name} had an appointment at <span className="tabular-nums">{item.appointment ? formatIST(item.appointment.scheduledAt) : '-'}</span>. This is after the{' '}
                {graceMin} min grace. Admitting uses a walk-in place and walk-in order.
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
