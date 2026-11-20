import { Link } from 'react-router-dom';
import type { Appointment } from '@hqms/contracts';
import { Button } from '@/components/ui/button';
import { formatLocalDate, istDate } from '@/lib/dates';
import { formatIST } from '@/lib/format';
import { cn } from '@/lib/utils';

/** An appointment booked from a follow-up task is a return visit (PR-15). A word, not a colour. */
export const isReturnVisit = (a: Pick<Appointment, 'followUpTaskId'>): boolean => a.followUpTaskId !== null;

export function ReturnVisitTag({ className }: { className?: string }) {
  return (
    <span data-testid="return-visit-tag" className={cn('inline-block rounded-sm border border-ink px-1.5 py-0.5 text-sm font-bold text-ink', className)}>
      Return visit
    </span>
  );
}

/** After a cancellation: say what happened and offer the next step, so the patient is not left on a dead end (PR-19). */
export function CancelledNotice({ appointment, className }: { appointment: Appointment; className?: string }) {
  return (
    <div role="status" data-testid="cancelled-notice" className={cn('rounded-md border border-l-[3px] border-rule border-l-ink bg-surface px-4 py-3', className)}>
      <p className="font-bold">Appointment cancelled</p>
      <p className="mt-0.5 text-muted-foreground tabular-nums">
        {appointment.doctorName}, {formatLocalDate(istDate(appointment.scheduledAt))}, {formatIST(appointment.scheduledAt)}. Your place has been released.
      </p>
      <Button asChild size="lg" className="mt-3 w-full sm:w-auto">
        <Link to="/patient/book">Book a new time</Link>
      </Button>
    </div>
  );
}
