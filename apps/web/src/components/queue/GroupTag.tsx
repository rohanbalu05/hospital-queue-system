import { cn } from '@/lib/utils';
import { GROUPS, type TagGroup } from './group';

interface GroupTagProps {
  group: TagGroup;
  /** Also print the word ("Appointment") after the letter. */
  showName?: boolean;
  className?: string;
}

/** Letter tag for a queue group. Never colour-only: the letter is always present. */
export function GroupTag({ group, showName = false, className }: GroupTagProps) {
  const meta = GROUPS[group];
  return (
    <span
      data-group={group}
      title={meta.name}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-xs px-1.5 text-xs leading-none font-bold tabular-nums',
        meta.tag,
        className,
      )}
    >
      <span aria-hidden={showName ? undefined : true}>{meta.letter}</span>
      {showName ? <span>{meta.name}</span> : <span className="sr-only">{meta.name}</span>}
    </span>
  );
}
