import { useId, type KeyboardEvent, type ReactNode } from 'react';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';

interface ChoiceListProps {
  /** Names the group for screen readers, e.g. "Department". */
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  /** Enter on a chosen option moves on (Space or the arrow keys choose). */
  onEnter?: () => void;
  children: ReactNode;
  className?: string;
}

/** One-of-many list with 48px rows: arrow keys move and choose, Tab leaves the group. */
export function ChoiceList({ label, value, onValueChange, onEnter, children, className }: ChoiceListProps) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && value && onEnter) {
      e.preventDefault();
      onEnter();
    }
  };
  return (
    <RadioGroup
      aria-label={label}
      value={value}
      onValueChange={onValueChange}
      onKeyDown={onKeyDown}
      className={cn('gap-0 divide-y divide-rule overflow-hidden rounded-xl border border-rule bg-surface', className)}
    >
      {children}
    </RadioGroup>
  );
}

interface ChoiceProps {
  value: string;
  disabled?: boolean;
  /** Primary line. */
  title: ReactNode;
  /** Secondary line under the title. */
  detail?: ReactNode;
  /** Right-aligned note, e.g. "6 of 10 places left". Always words, never colour only. */
  aside?: ReactNode;
}

export function Choice({ value, disabled, title, detail, aside }: ChoiceProps) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={cn(
        'grid min-h-12 cursor-pointer grid-cols-[auto_1fr] items-center gap-x-3 px-4 py-2.5 has-[[data-state=checked]]:bg-secondary sm:grid-cols-[auto_1fr_auto]',
        disabled && 'cursor-not-allowed text-muted-foreground',
      )}
    >
      <RadioGroupItem id={id} value={value} disabled={disabled} className="row-span-2 self-center" />
      <span className="min-w-0">
        <span className="block font-bold">{title}</span>
        {detail ? <span className="block text-base text-muted-foreground">{detail}</span> : null}
      </span>
      {aside ? (
        <span className="col-start-2 text-base tabular-nums sm:col-start-3 sm:row-span-2 sm:row-start-1 sm:text-right">{aside}</span>
      ) : null}
    </label>
  );
}
