import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  CapacityBar,
  DecisionReason,
  EmptyState,
  ErrorState,
  GroupTag,
  Lane,
  QueueRow,
  SkeletonRows,
  StaleBanner,
  TokenText,
} from '@/components/queue';
import { ApiRequestError } from '@/lib/api';

/** Dev-only gallery of the shared queue primitives. Not linked from navigation; absent from production builds. */
export default function Primitives() {
  const [selected, setSelected] = useState('A-014');
  return (
    <div className="min-h-dvh bg-paper px-4 py-6 text-sm">
      <div className="mx-auto max-w-[1360px]">
        <h1 className="text-xl font-bold">Queue primitives</h1>
        <p className="text-muted-foreground">Development reference. Names below are sample data.</p>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <section aria-labelledby="g-tags" className="space-y-3">
            <h2 id="g-tags" className="text-lg font-bold">
              Tags and tokens
            </h2>
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-rule bg-surface p-4">
              <GroupTag group="A" />
              <GroupTag group="W" />
              <GroupTag group="P" />
              <GroupTag group="A" showName />
              <GroupTag group="W" showName />
              <GroupTag group="P" showName />
            </div>
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 rounded-xl border border-rule bg-surface p-4">
              <TokenText token="A-014" size="sm" />
              <TokenText token="W-005" size="md" />
              <TokenText token="A-021" size="lg" priority />
              <TokenText token="W-012" size="xl" />
            </div>
            <div className="overflow-hidden rounded-xl border border-rule bg-surface px-4">
              <TokenText token="A-014" size="display" />
            </div>
          </section>

          <section aria-labelledby="g-decisions" className="space-y-3">
            <h2 id="g-decisions" className="text-lg font-bold">
              Decision reason
            </h2>
            <DecisionReason reason="ROTATION" explanation="Called by rotation: 2nd appointment of A, A, W" />
            <DecisionReason reason="AGING" explanation="Aging: waited 47 min, over the 45 min limit" />
            <DecisionReason reason="CLINICAL_PRIORITY" explanation="Clinical priority: class 1, set by Dr. Meenakshi Rao" />
            <section aria-labelledby="g-capacity" className="space-y-3 pt-2">
              <h2 id="g-capacity" className="text-lg font-bold">
                Capacity
              </h2>
              <div className="space-y-4 rounded-xl border border-rule bg-surface p-4">
                <CapacityBar booked={7} bookedCapacity={10} walkin={2} walkinCapacity={5} />
                <CapacityBar booked={10} bookedCapacity={10} walkin={5} walkinCapacity={5} />
              </div>
            </section>
          </section>

          <section aria-labelledby="g-lanes" className="space-y-3">
            <h2 id="g-lanes" className="text-lg font-bold">
              Lane and rows
            </h2>
            <Lane title="Waiting" count={4} badge={<GroupTag group="A" showName />}>
              <QueueRow
                token="A-014"
                group="A"
                title="Ananya Iyer"
                detail="Checked in 10:12 am"
                trailing="18 min"
                selected={selected === 'A-014'}
                onSelect={() => setSelected('A-014')}
              />
              <QueueRow
                token="A-015"
                group="A"
                priority
                title="Lakshmi Narayanan"
                detail="Checked in 10:20 am"
                trailing="10 min"
                selected={selected === 'A-015'}
                onSelect={() => setSelected('A-015')}
              />
              <QueueRow
                token="W-005"
                group="W"
                title="Mohammed Irfan"
                detail="Walk-in 10:31 am"
                trailing="47 min"
                selected={selected === 'W-005'}
                onSelect={() => setSelected('W-005')}
              />
              <QueueRow
                token="W-006"
                group="W"
                title="Kavitha Reddy"
                detail="Walk-in 10:40 am"
                trailing="12 min"
                selected={selected === 'W-006'}
                onSelect={() => setSelected('W-006')}
              />
            </Lane>
            <Lane title="Called" count={0} empty="Nobody is called. Use Call next when the doctor is ready." />
          </section>

          <section aria-labelledby="g-states" className="space-y-3">
            <h2 id="g-states" className="text-lg font-bold">
              Live status and states
            </h2>
            <div className="space-y-3 rounded-xl border border-rule bg-surface p-4">
              <StaleBanner status="live" lastUpdated="2026-11-11T10:42:08+05:30" />
              <StaleBanner status="reconnecting" lastUpdated="2026-11-11T10:42:08+05:30" />
            </div>
            <SkeletonRows count={3} />
            <EmptyState title="No one is waiting">Arrivals appear here after check-in. Admit a walk-in from the action panel.</EmptyState>
            <ErrorState
              title="The queue could not be loaded"
              error={new ApiRequestError({ status: 0, code: 'NETWORK', message: 'Cannot reach the server. Check the connection and try again.' })}
              onRetry={() => undefined}
            />
            <div className="flex flex-wrap items-end gap-3 rounded-xl border border-rule bg-surface p-4">
              <div className="space-y-1">
                <Label htmlFor="demo-input">Search arrivals</Label>
                <Input id="demo-input" placeholder="Name, phone or appointment" className="w-64" />
              </div>
              <Button onClick={() => toast.success('Checked in')}>Check in</Button>
              <Button variant="outline">Mark absent</Button>
              <Button variant="destructive">Cancel appointment</Button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
