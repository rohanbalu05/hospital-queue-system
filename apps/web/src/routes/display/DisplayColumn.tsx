import { useEffect, useRef, useState } from 'react';
import type { DisplaySnapshot } from '@hqms/contracts';
import { GROUPS } from '@/components/queue/group';
import { cn } from '@/lib/utils';

type Column = DisplaySnapshot['columns'][number];

/** True for a short moment after `value` changes to something new (not on first render). Drives the one motion moment. */
export function useJustChanged(value: string | null, holdMs = 700): boolean {
  const previous = useRef(value);
  const [flag, setFlag] = useState(false);
  useEffect(() => {
    if (value === previous.current) return;
    previous.current = value;
    if (value === null) {
      setFlag(false);
      return;
    }
    setFlag(true);
    const id = setTimeout(() => setFlag(false), holdMs);
    return () => clearTimeout(id);
  }, [value, holdMs]);
  return flag;
}

const edgeFor = (token: string | null) => (token?.startsWith('W') ? GROUPS.W.edge : token?.startsWith('A') ? GROUPS.A.edge : 'border-l-rule');

/** What the "now calling" area says when no token is shown. */
function idleWords(status: Column['status']): string {
  switch (status) {
    case 'paused':
      return 'Doctor has paused';
    case 'unavailable':
      return 'Doctor is unavailable';
    case 'closed':
      return 'Session closed';
    case 'scheduled':
      return 'Session not started';
    case 'open':
      return 'No one is being called';
  }
}

export type DisplayVariant = 'tall' | 'wide';

interface DisplayColumnProps {
  column: Column;
  /** tall: one column per doctor (up to 3 doctors). wide: a landscape card, for 4 or more doctors. */
  variant: DisplayVariant;
  /** Smaller token when five or more doctors share the screen. */
  dense?: boolean;
}

/** One doctor's column. Tokens only: no names, no patient detail, ever. */
export function DisplayColumn({ column, variant, dense = false }: DisplayColumnProps) {
  const highlight = useJustChanged(column.nowCalling);
  const showToken = column.nowCalling !== null && column.status !== 'unavailable' && column.status !== 'closed';
  const showNext = column.next.length > 0 && column.status !== 'unavailable' && column.status !== 'closed';
  const wide = variant === 'wide';

  const now = (
    <div
      className={cn(
        'flex min-w-0 flex-1 flex-col justify-center border-l-[10px] px-8',
        wide ? 'py-4' : 'py-6',
        showToken ? edgeFor(column.nowCalling) : 'border-l-rule',
      )}
    >
      <p className="text-2xl font-bold text-muted-foreground">Now calling</p>
      {/* A live region so screen readers announce a new call; the highlight is the 300 ms motion moment. */}
      <div aria-live="polite" className={cn('mt-1', wide ? 'min-h-[7rem]' : 'min-h-[9rem]')}>
        {showToken ? (
          <p
            key={column.nowCalling}
            data-testid="now-calling"
            data-token={column.nowCalling}
            className={cn(
              '-mx-3 inline-block rounded-md px-3 font-bold tracking-tighter whitespace-nowrap tabular-nums',
              dense ? 'text-[96px] leading-[1.15]' : 'text-[140px] leading-[1.1]',
              highlight && 'animate-token-called',
            )}
          >
            {column.nowCalling}
          </p>
        ) : (
          <p data-testid="now-calling-idle" className="pt-4 text-4xl font-bold">
            {idleWords(column.status)}
          </p>
        )}
      </div>
      {showToken && column.status === 'paused' ? <p className="text-2xl">Doctor has paused</p> : null}
    </div>
  );

  const next = (
    <div className={cn(wide ? 'w-56 shrink-0 border-l border-rule px-6 py-4' : 'border-t border-rule px-8 py-5')}>
      <p className="text-2xl font-bold text-muted-foreground">Next</p>
      {showNext ? (
        <ol className={cn('mt-2 flex gap-x-8 gap-y-1', wide ? 'flex-col' : 'flex-wrap')} data-testid="next-tokens">
          {column.next.slice(0, 3).map((t) => (
            <li key={t} className={cn('list-none border-l-[6px] pl-3 text-4xl font-bold tabular-nums', edgeFor(t))}>
              {t}
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-2xl text-muted-foreground">No one is waiting</p>
      )}
    </div>
  );

  return (
    <section
      aria-label={`${column.room}, ${column.doctorLabel}`}
      data-testid="display-column"
      className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-rule bg-surface"
    >
      <header className={cn('border-b border-rule px-8', wide ? 'py-3' : 'py-5')}>
        <h2 className="truncate text-4xl font-bold">{column.room}</h2>
        <p className={cn('text-2xl text-muted-foreground', wide ? 'truncate' : 'line-clamp-2 min-h-[3.4rem]')}>{column.doctorLabel}</p>
      </header>
      {wide ? (
        <div className="flex min-h-0 flex-1">
          {now}
          {next}
        </div>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col">{now}</div>
          {next}
        </>
      )}
    </section>
  );
}
