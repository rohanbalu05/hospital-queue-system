import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiRequestError } from '@/lib/api';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  title: string;
  /** What this screen will hold, or what to do next. */
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, children, action, className }: EmptyStateProps) {
  return (
    <div className={cn('rounded-xl border border-dashed border-rule bg-surface px-4 py-8', className)}>
      <h2 className="text-lg font-bold">{title}</h2>
      {children ? <p className="mt-1 max-w-prose text-muted-foreground">{children}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

interface ErrorStateProps {
  /** What happened, in words. */
  title?: string;
  error?: unknown;
  /** How to fix it. */
  hint?: string;
  onRetry?: () => void;
  className?: string;
}

const HINTS: Partial<Record<string, string>> = {
  NETWORK: 'If the connection is fine, the server may be restarting. Try again in a minute.',
  FORBIDDEN: 'Your role does not have access to this. Ask an admin if you need it.',
  UNAUTHENTICATED: 'Your session has ended. Sign in again.',
};

export function ErrorState({ title = 'This could not be loaded', error, hint, onRetry, className }: ErrorStateProps) {
  const api = error instanceof ApiRequestError ? error : null;
  const message = api?.message ?? (error instanceof Error ? error.message : null);
  const fix = hint ?? (api ? HINTS[api.code] : undefined) ?? 'Try again. If it keeps failing, tell the front desk.';
  return (
    <div role="alert" className={cn('rounded-xl border border-l-[3px] border-rule border-l-priority bg-surface px-4 py-4', className)}>
      <h2 className="text-lg font-bold">{title}</h2>
      {message ? <p className="mt-1">{message}</p> : null}
      <p className="mt-1 text-muted-foreground">{fix}</p>
      {api?.correlationId ? <p className="mt-2 text-xs text-muted-foreground tabular-nums">Reference {api.correlationId}</p> : null}
      {onRetry ? (
        <Button variant="outline" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** Skeleton rows that match the 40px queue row, for loading states (not full-page spinners). */
export function SkeletonRows({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('divide-y divide-rule overflow-hidden rounded-xl border border-rule bg-surface', className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex h-10 items-center gap-3 border-l-[3px] border-l-rule px-3">
          <Skeleton className="h-5 w-6" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-12" />
        </div>
      ))}
    </div>
  );
}
