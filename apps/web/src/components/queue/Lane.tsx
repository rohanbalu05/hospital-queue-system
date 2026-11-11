import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface LaneProps {
  /** Lane title in words, e.g. "Waiting, appointment". */
  title: string;
  count?: number;
  /** Shown beside the title, e.g. a GroupTag. */
  badge?: ReactNode;
  /** Shown when there are no rows; say what happens next. */
  empty?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/** A bordered list of queue rows with a 40px header. Rows are <li>; the lane is the <ul>. */
export function Lane({ title, count, badge, empty, children, className }: LaneProps) {
  const id = useId();
  const hasRows = count === undefined ? Boolean(children) : count > 0;
  return (
    <section aria-labelledby={id} className={cn('overflow-hidden rounded-xl border border-rule bg-surface', className)}>
      <header className="flex h-10 items-center gap-2 border-b border-rule px-3">
        <h3 id={id} className="text-sm font-bold">
          {title}
        </h3>
        {badge}
        {count !== undefined ? <span className="ml-auto text-sm text-muted-foreground tabular-nums">{count}</span> : null}
      </header>
      {hasRows ? (
        <ul className="divide-y divide-rule">{children}</ul>
      ) : (
        <p className="px-3 py-4 text-sm text-muted-foreground">{empty ?? 'Nothing here.'}</p>
      )}
    </section>
  );
}
