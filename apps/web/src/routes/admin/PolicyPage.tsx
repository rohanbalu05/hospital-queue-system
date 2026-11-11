import type { QueuePolicy } from '@hqms/contracts';
import { useCurrentPolicy } from '@/api';
import { ErrorState, SkeletonRows } from '@/components/queue';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatIST } from '@/lib/format';

export function policyRows(p: QueuePolicy): Array<{ setting: string; value: string; purpose: string }> {
  return [
    { setting: 'Group rotation', value: p.rotation.join(', '), purpose: 'Order in which waiting groups are called when nobody is overdue or prioritised.' },
    { setting: 'Early eligibility', value: `${p.earlyEligibilityMin} min`, purpose: 'An appointment patient may be called this long before the booked time.' },
    { setting: 'Late grace', value: `${p.lateGraceMin} min`, purpose: 'After this, a late arrival needs review and is admitted as a walk-in.' },
    { setting: 'Aging trigger', value: `${p.agingTriggerMin} min`, purpose: 'A patient who has waited this long is called ahead of the rotation.' },
    { setting: 'Called timeout', value: `${p.calledTimeoutSec / 60} min`, purpose: 'A called patient who does not arrive is skipped after this.' },
    { setting: 'EWMA smoothing', value: String(p.ewmaAlpha), purpose: 'Weight of the latest consultation in the waiting-time estimate.' },
    { setting: 'Initial estimate', value: `${p.initialEstimateMin} min`, purpose: 'Consultation length assumed before any consultation is recorded.' },
    { setting: 'Booked capacity', value: `${p.defaultBookedCapacity} per session`, purpose: 'Default booked places for a new session.' },
    { setting: 'Walk-in capacity', value: `${p.defaultWalkinCapacity} per session`, purpose: 'Default walk-in places for a new session.' },
  ];
}

/** Read-only view of the current queue policy (report Table 7). Sessions keep the version they were created with. */
export default function PolicyPage() {
  const q = useCurrentPolicy();
  return (
    <section aria-labelledby="policy-h" className="grid gap-3">
      <div>
        <h2 id="policy-h" className="text-lg font-bold">
          Current queue policy
        </h2>
        <p className="text-muted-foreground">Read only. A change creates a new version; existing sessions keep the version they started with.</p>
      </div>
      {q.isPending ? (
        <SkeletonRows count={9} />
      ) : q.isError ? (
        <ErrorState title="The policy could not be loaded" error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <p className="font-bold tabular-nums" data-testid="policy-version">
            Policy version {q.data.version}
            <span className="ml-3 font-normal text-muted-foreground">Created {formatIST(q.data.createdAt, 'date-time')}</span>
          </p>
          <div className="overflow-hidden rounded-xl border border-rule bg-surface">
            <Table>
              <TableHeader className="bg-paper">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-3">Setting</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>What it does</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {policyRows(q.data).map((r) => (
                  <TableRow key={r.setting} className="h-10">
                    <TableCell className="pl-3 font-bold">{r.setting}</TableCell>
                    <TableCell className="tabular-nums">{r.value}</TableCell>
                    <TableCell className="whitespace-normal text-muted-foreground">{r.purpose}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </section>
  );
}
