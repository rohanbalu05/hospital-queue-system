import type { FollowUpStatus } from '@hqms/contracts';
import { TASK_STATUS_WORD, taskTiming } from '@/lib/followup';
import { cn } from '@/lib/utils';

const TONE: Record<FollowUpStatus, string> = {
  open: 'text-ink',
  acknowledged: 'text-ink',
  resolved: 'text-done',
  cancelled: 'text-muted-foreground',
};

/** Task status as a word. Colour only reinforces it. */
export function TaskStatusWord({ status, className }: { status: FollowUpStatus; className?: string }) {
  return <span className={cn('font-bold', TONE[status], className)}>{TASK_STATUS_WORD[status]}</span>;
}

/** "Overdue 26 h" in the priority colour, or "Due in 3 h". Never colour-only: the word Overdue is always printed. */
export function TimingWord({ task, now, className }: { task: { status: FollowUpStatus; dueAt: string; overdue: boolean }; now: number; className?: string }) {
  const t = taskTiming(task, now);
  if (!t.label) return <span className={cn('text-muted-foreground', className)}>-</span>;
  return <span className={cn(t.overdue ? 'font-bold text-priority' : 'text-muted-foreground', className)}>{t.label}</span>;
}
