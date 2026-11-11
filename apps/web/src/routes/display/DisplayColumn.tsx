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
    const becameToken = value !== null;
    previous.current = value;
    if (!becameToken) {
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

interface DisplayColumnProps {
  column: Column;
  /** Smaller token when five or more doctors share the screen. */
  dense: boolean;
}

/** One doctor's column. Tokens only: no names, no patient detail, ever. */
export function DisplayColumn({ column, dense }: DisplayColumnProps) {
  const highlight = useJustChanged(column.nowCalling);
  const showToken = column.nowCalling !== null && column.status !== 'unavailable' && column.status !== 'closed';
  const showNext = column.next.length > 0 && column.status !== 'unavailable' && column.status !== 'closed';

  return (
    <section
      aria-label={`${column.room}, ${column.doctorLabel}`}
      data-testid="display-column"
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-rule bg-surface"
    >
      <header className="border-b border-rule px-8 py-5">
        <h2 className="truncate text-4xl font-bold">{column.room}</h2>
        <p className="truncate text-2xl text-muted-foreground">{column.doctorLabel}</p>
      </header>

      <div className={cn('flex flex-1 flex-col justify-center border-l-[10px] px-8 py-6', showToken ? edgeFor(column.nowCalling) : 'border-l-rule')}>
        <p className="text-2xl font-bold text-muted-foreground">Now calling</p>
        {/* A live region so screen readers announce a new call; the highlight is the 300 ms motion moment. */}
        <div aria-live="polite" className="mt-1 min-h-[9rem]">
          {showToken ? (
            <p
              key={column.nowCalling}
              data-testid="now-calling"
              data-token={column.nowCalling}
              className={cn(
                '-mx-3 inline-block rounded-md px-3 font-bold tracking-tighter whitespace-nowrap tabular-nums',
                dense ? 'text-[96px] leading-[1.15]' : 'text-[clamp(5rem,8vw,8.75rem)] leading-[1.1]',
                highlight && 'animate-token-called',
              )}
            >
              {column.nowCalling}
            </p>
          ) : (
            <p data-testid="now-calling-idle" className="pt-6 text-4xl font-bold">
              {idleWords(column.status)}
            </p>
          )}
        </div>
        {showToken && column.status === 'paused' ? <p className="mt-2 text-2xl">Doctor has paused</p> : null}
      </div>

      <div className="border-t border-rule px-8 py-5">
        <p className="text-2xl font-bold text-muted-foreground">Next</p>
        {showNext ? (
          <ol className="mt-2 flex flex-wrap gap-x-8 gap-y-1" data-testid="next-tokens">
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
    </section>
  );
}
