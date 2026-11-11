import type { QueuePressure } from '@hqms/contracts';
import { cn } from '@/lib/utils';

const WORD: Record<Exclude<QueuePressure['level'], 'normal'>, string> = {
  high: 'Workload: High',
  overloaded: 'Workload: Overloaded',
};

interface PressureNoteProps {
  pressure: QueuePressure;
  className?: string;
}

/**
 * Workload pressure of a session (report 6.6). Nothing when normal. Otherwise the level in bold ink and the server's
 * reasons as a short list, behind an ink left edge. It is a notice, not an alarm: red stays for P and destructive actions.
 */
export function PressureNote({ pressure, className }: PressureNoteProps) {
  if (pressure.level === 'normal') return null;
  return (
    <div
      role="status"
      data-testid="pressure-note"
      data-level={pressure.level}
      className={cn('rounded-md border border-l-[3px] border-rule border-l-ink bg-surface px-3 py-2', className)}
    >
      <p className="font-bold text-ink">{WORD[pressure.level]}</p>
      {pressure.reasons.length > 0 ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
          {pressure.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
