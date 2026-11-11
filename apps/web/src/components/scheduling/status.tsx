import type { ReactNode } from 'react';
import type { AppointmentStatus } from '@hqms/contracts';
import { cn } from '@/lib/utils';

const WORDS: Record<AppointmentStatus, { word: string; className: string }> = {
  booked: { word: 'Booked', className: 'text-ink' },
  checked_in: { word: 'Checked in', className: 'text-ink' },
  completed: { word: 'Completed', className: 'text-done' },
  cancelled: { word: 'Cancelled', className: 'text-muted-foreground' },
  missed: { word: 'Missed', className: 'text-priority' },
  rescheduled: { word: 'Rescheduled', className: 'text-muted-foreground' },
};

/** Status is always a word. Colour only reinforces it (done = green, missed = red). */
export function StatusWord({ status, className }: { status: AppointmentStatus; className?: string }) {
  const m = WORDS[status];
  return <span className={cn('font-bold', m.className, className)}>{m.word}</span>;
}

/** Inline message with an edge: priority red for errors, ink for notices. Announced to screen readers. */
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
        tone === 'error' ? 'border-l-priority' : 'border-l-ink',
        className,
      )}
    >
      <p className="font-bold">{title}</p>
      {children ? <div className="mt-0.5 text-muted-foreground">{children}</div> : null}
    </div>
  );
}
