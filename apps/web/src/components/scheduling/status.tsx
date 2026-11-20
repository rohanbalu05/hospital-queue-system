import type { ReactNode } from 'react';
import type { Appointment, AppointmentStatus } from '@hqms/contracts';
import { cn } from '@/lib/utils';

const WORDS: Record<AppointmentStatus, { word: string; className: string }> = {
  booked: { word: 'Booked', className: 'text-ink' },
  checked_in: { word: 'Checked in', className: 'text-ink' },
  completed: { word: 'Completed', className: 'text-done' },
  cancelled: { word: 'Cancelled', className: 'text-muted-foreground' },
  missed: { word: 'Missed', className: 'text-ink' },
  rescheduled: { word: 'Rescheduled', className: 'text-muted-foreground' },
};

/**
 * Status is always a word. Colour only reinforces it (done = green).
 * A checked-in patient reception moved to another doctor is no longer "Checked in" here: the original appointment reads
 * "Moved to Dr. Y" (staff also see the new token), in a neutral tone.
 */
export function StatusWord({
  status,
  transferredTo,
  showToken = false,
  className,
}: {
  status: AppointmentStatus;
  transferredTo?: Appointment['transferredTo'];
  showToken?: boolean;
  className?: string;
}) {
  if (transferredTo && status === 'checked_in') {
    return (
      <span className={cn('font-bold text-muted-foreground', className)}>
        Moved to {transferredTo.doctorName}
        {showToken ? ` (${transferredTo.token})` : ''}
      </span>
    );
  }
  const m = WORDS[status];
  return <span className={cn('font-bold', m.className, className)}>{m.word}</span>;
}

/** Inline message with an edge: ink edge for errors, rule edge for notices. Announced to screen readers. */
export function InlineAlert({
  tone = 'error',
  title,
  children,
  className,
}: {
  tone?: 'error' | 'notice';
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'rounded-md border border-l-[3px] border-rule bg-surface px-3 py-2.5',
        tone === 'error' ? 'border-l-ink' : 'border-l-rule',
        className,
      )}
    >
      <p className="font-bold">{title}</p>
      {children ? <div className="mt-0.5 text-muted-foreground">{children}</div> : null}
    </div>
  );
}
