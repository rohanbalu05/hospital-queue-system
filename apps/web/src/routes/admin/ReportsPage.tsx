import { useState, type ReactNode } from 'react';
import type { Metric, OperationsReport } from '@hqms/contracts';
import { useOperationsReport } from '@/api';
import { GroupTag } from '@/components/queue';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/queue';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { addDays, istDate } from '@/lib/dates';
import { reasonWord } from '@/lib/followup';
import { formatIST } from '@/lib/format';
import { cn } from '@/lib/utils';

/** FR-15-b: every figure says whether it was measured from data or is a target from the report. Never colour only. */
export function KindTag({ kind }: { kind: Metric['kind'] }) {
  return (
    <span
      data-kind={kind}
      className={cn(
        'inline-flex h-5 items-center rounded-xs px-1.5 text-xs leading-none font-bold',
        kind === 'measured' ? 'bg-ink/10 text-ink' : 'border border-rule bg-surface text-muted-foreground',
      )}
    >
      {kind === 'measured' ? 'Measured' : 'Target'}
    </span>
  );
}

export function metricValue(m: Pick<Metric, 'value' | 'unit'>): string {
  if (m.value === null) return 'Not enough data';
  const n = Number.isInteger(m.value) ? String(m.value) : m.value.toFixed(1);
  return m.unit === 'count' ? n : `${n} ${m.unit}`;
}

const minutes = (v: number | null) => (v === null ? 'Not enough data' : `${v.toFixed(1)} min`);
const GROUP_WORD: Record<string, string> = { A: 'Appointment', W: 'Walk-in', P: 'Priority', all: 'All patients' };

function Block({ id, title, kind, children }: { id: string; title: string; kind?: Metric['kind']; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="overflow-hidden rounded-xl border border-rule bg-surface">
      <header className="flex h-10 items-center gap-3 border-b border-rule px-3">
        <h3 id={id} className="font-bold">
          {title}
        </h3>
        {kind ? <KindTag kind={kind} /> : null}
      </header>
      {children}
    </section>
  );
}

function ReportBody({ report }: { report: OperationsReport }) {
  // Metrics grouped by name so a target sits directly under its measured figure.
  const names = [...new Set(report.metrics.map((m) => m.name))];
  const noSamples = report.throughput.completedVisits === 0;
  return (
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <Block id="throughput-h" title="Throughput" kind="measured">
        <Table>
          <TableBody>
            <TableRow className="h-10">
              <TableCell className="pl-3">Completed visits</TableCell>
              <TableCell className="pr-3 text-right font-bold tabular-nums">{report.throughput.completedVisits}</TableCell>
            </TableRow>
            <TableRow className="h-10">
              <TableCell className="pl-3">Sessions held</TableCell>
              <TableCell className="pr-3 text-right font-bold tabular-nums">{report.throughput.sessions}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Block>

      <Block id="waits-h" title="Waiting time by group" kind="measured">
        <Table>
          <TableHeader className="bg-paper">
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-3">Group</TableHead>
              <TableHead className="text-right">Median</TableHead>
              <TableHead className="text-right">95th percentile</TableHead>
              <TableHead className="pr-3 text-right">Patients</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.waitsByGroup.map((w) => (
              <TableRow key={w.group} className="h-10">
                <TableCell className="pl-3">
                  <span className="flex items-center gap-2">
                    {w.group !== 'all' ? <GroupTag group={w.group} /> : null}
                    <span className="font-bold">{GROUP_WORD[w.group]}</span>
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{minutes(w.medianMinutes)}</TableCell>
                <TableCell className="text-right tabular-nums">{minutes(w.p95Minutes)}</TableCell>
                <TableCell className="pr-3 text-right tabular-nums">{w.n}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Block>

      <Block id="decisions-h" title="Call decisions by reason" kind="measured">
        {report.decisionsByReason.length === 0 ? (
          <p className="px-3 py-4 text-muted-foreground">No call decisions in this period.</p>
        ) : (
          <Table>
            <TableBody>
              {report.decisionsByReason.map((d) => (
                <TableRow key={d.reason} className="h-10">
                  <TableCell className="pl-3 font-bold">{reasonWord(d.reason)}</TableCell>
                  <TableCell className="pr-3 text-right tabular-nums">{d.count}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Block>

      <Block id="metrics-h" title="Measured against target">
        {report.metrics.length === 0 ? (
          <p className="px-3 py-4 text-muted-foreground">No metrics were reported for this period.</p>
        ) : (
          <Table>
            <TableHeader className="bg-paper">
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-3">Metric</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead className="pr-3 text-right">Samples</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {names.flatMap((name) =>
                report.metrics
                  .filter((m) => m.name === name)
                  .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'measured' ? -1 : 1))
                  .map((m, i) => (
                    <TableRow key={`${name}-${m.kind}`} className="h-10" data-kind={m.kind}>
                      <TableCell className="pl-3 whitespace-normal">
                        {i === 0 ? <span className="font-bold">{name}</span> : <span className="sr-only">{name}</span>}
                        {m.note ? <span className="block text-sm text-muted-foreground">{m.note}</span> : null}
                      </TableCell>
                      <TableCell>
                        <KindTag kind={m.kind} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{metricValue(m)}</TableCell>
                      <TableCell className="pr-3 text-right tabular-nums">{m.sampleSize ?? '-'}</TableCell>
                    </TableRow>
                  )),
              )}
            </TableBody>
          </Table>
        )}
      </Block>
      {noSamples ? (
        <p className="text-muted-foreground xl:col-span-2">No visits were completed in this period, so waiting times and measured figures are empty. Targets are shown for reference only.</p>
      ) : null}
    </div>
  );
}

export default function ReportsPage() {
  const today = istDate();
  const [from, setFrom] = useState(addDays(today, -6));
  const [to, setTo] = useState(today);
  const valid = from <= to;
  const q = useOperationsReport(valid ? from : to, to);

  return (
    <section aria-labelledby="reports-h" className="grid gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h2 id="reports-h" className="text-lg font-bold">
            Operations report
          </h2>
          <p className="text-muted-foreground">
            Every figure is labelled Measured (from visits in this period) or Target (from the design report). Targets are never shown as results.
          </p>
        </div>
        <div className="ml-auto flex items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="report-from">From</Label>
            <Input id="report-from" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="w-44" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="report-to">To</Label>
            <Input id="report-to" type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} className="w-44" />
          </div>
        </div>
      </div>
      {!valid ? <p role="alert" className="font-bold">The start date is after the end date. Showing a single day instead.</p> : null}
      {q.isPending ? (
        <SkeletonRows count={8} />
      ) : q.isError ? (
        <ErrorState title="The report could not be loaded" error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.throughput.sessions === 0 && q.data.metrics.length === 0 ? (
        <EmptyState title="No sessions in this period">Choose a wider date range. Reports count sessions that ran between the two dates.</EmptyState>
      ) : (
        <>
          <p className="text-sm text-muted-foreground tabular-nums">
            {q.data.from} to {q.data.to}. Generated {formatIST(q.data.generatedAt, 'date-time')}.
          </p>
          <ReportBody report={q.data} />
        </>
      )}
    </section>
  );
}
