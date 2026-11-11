import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { GROUPS } from './group';
import { GroupTag } from './GroupTag';
import { TokenText } from './TokenText';

interface QueueRowProps {
  token: string;
  group: 'A' | 'W';
  /** Authorized clinical priority: red edge and a P tag beside the original token. */
  priority?: boolean;
  /** Primary line, e.g. patient name (staff screens only; never on the public display). */
  title?: ReactNode;
  /** Secondary text, e.g. "Checked in 10:12 am". */
  detail?: ReactNode;
  /** Right-aligned content, e.g. wait time or a row action. */
  trailing?: ReactNode;
  selected?: boolean;
  /** When set the row is a button: focusable and operable with Enter or Space. */
  onSelect?: () => void;
  className?: string;
}

/** 40px staff row with a 3px left edge in the group colour (priority overrides). */
export function QueueRow({
  token,
  group,
  priority = false,
  title,
  detail,
  trailing,
  selected = false,
  onSelect,
  className,
}: QueueRowProps) {
  const edge = priority ? GROUPS.P.edge : GROUPS[group].edge;
  const base = cn(
    'flex min-h-10 w-full items-center gap-3 border-l-[3px] bg-surface px-3 text-left text-sm',
    edge,
    selected && 'bg-secondary',
    className,
  );
  const content = (
    <>
      <GroupTag group={group} className="min-w-6 justify-center" />
      <TokenText token={token} size="md" priority={priority} className="w-[5.5rem] shrink-0 sm:w-28" />
      {title ? <span className="min-w-0 flex-1 truncate font-bold">{title}</span> : <span className="flex-1" />}
      {detail ? <span className="hidden shrink-0 text-muted-foreground sm:inline">{detail}</span> : null}
      {trailing ? <span className="shrink-0 tabular-nums">{trailing}</span> : null}
    </>
  );
  if (onSelect) {
    return (
      <li className="list-none">
        <button type="button" onClick={onSelect} aria-pressed={selected} className={cn(base, 'hover:bg-secondary')}>
          {content}
        </button>
      </li>
    );
  }
  return (
    <li className="list-none">
      <div className={base}>{content}</div>
    </li>
  );
}
