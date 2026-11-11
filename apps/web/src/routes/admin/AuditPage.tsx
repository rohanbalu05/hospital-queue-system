import { useState } from 'react';
import { useAuditEvents } from '@/api';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/queue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatIST } from '@/lib/format';
import { entityLabel, operationSentence, roleWord } from '@/lib/audit';
import { reasonWord } from '@/lib/followup';

export const ENTITY_TYPES: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'Everything' },
  { value: 'appointment', label: 'Appointments' },
  { value: 'session', label: 'Sessions' },
  { value: 'queue_entry', label: 'Queue entries' },
  { value: 'visit', label: 'Visits' },
  { value: 'follow_up_task', label: 'Follow-up tasks' },
  { value: 'document', label: 'Documents' },
  { value: 'instruction', label: 'Instructions' },
  { value: 'policy', label: 'Policies' },
];

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who did what, when, under which policy version and why. Filter by entity; times are Bengaluru time. */
export default function AuditPage() {
  const [entityType, setEntityType] = useState('all');
  const [entityIdText, setEntityIdText] = useState('');
  const [applied, setApplied] = useState<{ entityType?: string; entityId?: string }>({});
  const [idError, setIdError] = useState<string | null>(null);
  const q = useAuditEvents(applied);

  const apply = () => {
    const id = entityIdText.trim();
    if (id && !ID_PATTERN.test(id)) {
      setIdError('An entity id looks like 3f2a1c9e-0b7d-4c1a-9a55-2f6e8d1b7c40.');
      return;
    }
    setIdError(null);
    setApplied({ ...(entityType !== 'all' ? { entityType } : {}), ...(id ? { entityId: id } : {}) });
  };

  return (
    <section aria-labelledby="audit-h" className="grid gap-3">
      <div>
        <h2 id="audit-h" className="text-lg font-bold">
          Audit trail
        </h2>
        <p className="text-muted-foreground">Every state change is recorded with who made it, when, the policy version in force and the reason.</p>
      </div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
        noValidate
      >
        <div className="grid gap-1.5">
          <Label htmlFor="audit-entity">Entity</Label>
          <Select value={entityType} onValueChange={setEntityType}>
            <SelectTrigger id="audit-entity" className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ENTITY_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="audit-id">Entity id (optional)</Label>
          <Input id="audit-id" value={entityIdText} onChange={(e) => setEntityIdText(e.target.value)} className="w-96" aria-invalid={idError ? true : undefined} aria-describedby={idError ? 'audit-id-error' : undefined} />
        </div>
        <Button type="submit">Apply filter</Button>
        {idError ? (
          <p id="audit-id-error" role="alert" className="basis-full font-bold">
            {idError}
          </p>
        ) : null}
      </form>

      {q.isPending ? (
        <SkeletonRows count={8} />
      ) : q.isError && !q.data ? (
        <ErrorState title="The audit trail could not be loaded" error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState title="No audit events match">Widen the filter, or clear the entity id. Events appear as soon as something changes.</EmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl border border-rule bg-surface">
          <Table>
            <TableHeader className="bg-paper">
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-3">Time</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Operation</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead className="text-right">Policy</TableHead>
                <TableHead className="pr-3">Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((e) => (
                <TableRow key={e.id} className="h-10" data-testid="audit-row">
                  <TableCell className="pl-3 tabular-nums">{formatIST(e.occurredAt, 'time-seconds')} <span className="text-muted-foreground">{formatIST(e.occurredAt, 'date')}</span></TableCell>
                  <TableCell title={e.actorId ?? undefined}>
                    <span className="font-bold">{e.actorName ?? 'System'}</span>{' '}
                    <span className="text-muted-foreground">{roleWord(e.actorRole)}</span>
                  </TableCell>
                  <TableCell className="font-bold" title={e.operation}>
                    {operationSentence(e.operation)}
                  </TableCell>
                  <TableCell title={e.entityId}>
                    {entityLabel(e.entityType)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{e.policyVersion === null ? '-' : `v${e.policyVersion}`}</TableCell>
                  <TableCell className="pr-3 whitespace-normal">{e.reason ? reasonWord(e.reason) : <span className="text-muted-foreground">-</span>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
