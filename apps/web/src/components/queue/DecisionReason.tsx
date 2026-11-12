import type { DecisionReason as Reason } from '@hqms/contracts';
import { cn } from '@/lib/utils';
import { REASONS } from './group';

interface DecisionReasonProps {
  reason: Reason;
  /** Plain-words explanation from the server, e.g. "Called by rotation: 2nd appointment of A, A, W". */
  explanation: string;
  className?: string;
}

/**
 * The reason is the feature: shown after every call, in plain words with the reason colour on the left edge.
 * The explanation already names the reason ("Called by rotation", "Aging: waited 47 min"), so no second label repeats it.
 */
export function DecisionReason({ reason, explanation, className }: DecisionReasonProps) {
  const meta = REASONS[reason];
  return (
    <div
      role="status"
      data-reason={reason}
      className={cn('rounded-md border border-l-[3px] border-rule bg-surface px-3 py-2', meta.edge, className)}
    >
      <p className={cn('text-base', meta.text)}>{explanation}</p>
    </div>
  );
}
