import type { InstructionVersion } from '@hqms/contracts';
import { useInstructions } from '@/api';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/queue';
import { formatIST } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Current / Superseded as a tag with a word, never colour only. */
export function VersionTag({ status }: { status: InstructionVersion['status'] }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-xs px-1.5 text-xs leading-none font-bold',
        status === 'current' ? 'bg-done/10 text-done' : 'bg-muted text-muted-foreground',
      )}
    >
      {status === 'current' ? 'Current' : 'Superseded'}
    </span>
  );
}

/** Versions of every verified instruction for one patient, newest first. */
export function InstructionHistory({ patientId, patientName }: { patientId: string; patientName: string }) {
  const q = useInstructions(patientId);
  return (
    <section aria-labelledby="history-h" className="rounded-xl border border-rule bg-surface">
      <header className="flex h-10 items-center border-b border-rule px-3">
        <h3 id="history-h" className="font-bold">
          Verified instructions for {patientName}
        </h3>
      </header>
      {q.isPending ? (
        <SkeletonRows count={2} className="rounded-none border-0" />
      ) : q.isError ? (
        <div className="p-3">
          <ErrorState title="Instruction history could not be loaded" error={q.error} onRetry={() => void q.refetch()} />
        </div>
      ) : q.data.length === 0 ? (
        <div className="p-3">
          <EmptyState title="Nothing verified yet">The first instruction you verify from a document becomes version 1.</EmptyState>
        </div>
      ) : (
        <ul className="divide-y divide-rule">
          {[...q.data]
            .sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt))
            .map((v) => (
              <li key={v.id} className={cn('flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-l-[3px] px-3 py-2', v.status === 'current' ? 'border-l-done' : 'border-l-rule')}>
                <span className="font-bold">{v.title}</span>
                <span className="tabular-nums text-muted-foreground">Version {v.version}</span>
                <VersionTag status={v.status} />
                <span className="ml-auto text-muted-foreground tabular-nums">
                  {v.verifiedByName}, {formatIST(v.verifiedAt, 'date-time')}
                </span>
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}
