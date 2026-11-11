import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { UpdateCapacityRequest, type Session } from '@hqms/contracts';
import { useSessionsQuery, useUpdateCapacity } from '@/api';
import { Field } from '@/components/layout/Field';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/queue';
import { sessionLabelWord, sessionTimes } from '@/components/scheduling/sessions';
import { InlineAlert } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiRequestError } from '@/lib/api';
import { addDays, formatLocalDate, istDate } from '@/lib/dates';

const STATUS_WORD: Record<Session['status'], string> = {
  scheduled: 'Not started',
  open: 'Open',
  paused: 'Paused',
  unavailable: 'Doctor unavailable',
  closed: 'Closed',
};

function CapacityDialog({ session, onClose }: { session: Session | null; onClose: () => void }) {
  const update = useUpdateCapacity();
  const [booked, setBooked] = useState('');
  const [walkin, setWalkin] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const { reset } = update;

  useEffect(() => {
    if (session) {
      setBooked(String(session.capacity.bookedCapacity));
      setWalkin(String(session.capacity.walkinCapacity));
      setFieldError(null);
      reset();
    }
  }, [session, reset]);

  const submit = () => {
    if (!session) return;
    const body = { expectedVersion: session.version, bookedCapacity: Number(booked), walkinCapacity: Number(walkin) };
    if (booked.trim() === '' || walkin.trim() === '' || !UpdateCapacityRequest.safeParse(body).success) {
      setFieldError('Enter whole numbers from 0 to 100 for both places.');
      return;
    }
    setFieldError(null);
    update.mutate(
      { sessionId: session.id, ...body },
      {
        onSuccess: () => {
          toast.success('Capacity saved');
          onClose();
        },
      },
    );
  };

  const reduction = update.error instanceof ApiRequestError && update.error.code === 'INVALID_CAPACITY_REDUCTION';
  const conflict = update.error instanceof ApiRequestError && update.error.code === 'CONFLICT';

  return (
    <Dialog open={session !== null} onOpenChange={(o) => !o && !update.isPending && onClose()}>
      <DialogContent>
        {session ? (
          <>
            <DialogHeader>
              <DialogTitle>Edit capacity</DialogTitle>
              <DialogDescription>
                {session.doctorName}, {sessionLabelWord(session)} {formatLocalDate(session.sessionDate)}. Already used: {session.capacity.bookedReserved} booked, {session.capacity.walkinUsed} walk-in. Capacity cannot go below these.
              </DialogDescription>
            </DialogHeader>
            <form
              className="grid gap-4"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <div className="grid grid-cols-2 gap-4">
                <Field label="Booked places" error={fieldError}>
                  <Input type="number" inputMode="numeric" min={0} max={100} value={booked} onChange={(e) => setBooked(e.target.value)} />
                </Field>
                <Field label="Walk-in places">
                  <Input type="number" inputMode="numeric" min={0} max={100} value={walkin} onChange={(e) => setWalkin(e.target.value)} />
                </Field>
              </div>
              {reduction ? (
                <InlineAlert title="Capacity not reduced">
                  {update.error?.message} Nothing was changed. Cancel or move those bookings first, or choose a higher number.
                </InlineAlert>
              ) : conflict ? (
                <InlineAlert title="This session changed">Someone else updated it. Close this dialog, then open it again to see the latest numbers.</InlineAlert>
              ) : update.isError ? (
                <InlineAlert title="Capacity not saved">{update.error?.message}</InlineAlert>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="outline" size="lg" onClick={onClose} disabled={update.isPending}>
                  Cancel
                </Button>
                <Button type="submit" size="lg" disabled={update.isPending}>
                  {update.isPending ? 'Saving…' : 'Save capacity'}
                </Button>
              </DialogFooter>
            </form>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export default function SessionsPage() {
  const [date, setDate] = useState(istDate());
  const q = useSessionsQuery({ date });
  const sessions = useMemo(
    () => [...(q.data ?? [])].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.doctorName.localeCompare(b.doctorName)),
    [q.data],
  );
  const [editing, setEditing] = useState<Session | null>(null);

  return (
    <section aria-labelledby="sessions-h" className="grid gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h2 id="sessions-h" className="text-lg font-bold">
            Sessions and capacity
          </h2>
          <p className="text-muted-foreground">Default capacity is 10 booked and 5 walk-in places per session.</p>
        </div>
        <div className="ml-auto flex items-end gap-2">
          <Button variant="outline" onClick={() => setDate(addDays(date, -1))}>
            Previous day
          </Button>
          <div className="grid gap-1.5">
            <Label htmlFor="session-date">Date</Label>
            <Input id="session-date" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="w-44" />
          </div>
          <Button variant="outline" onClick={() => setDate(addDays(date, 1))}>
            Next day
          </Button>
        </div>
      </div>

      {q.isPending ? (
        <SkeletonRows count={8} />
      ) : q.isError && !q.data ? (
        <ErrorState title="Sessions could not be loaded" error={q.error} onRetry={() => void q.refetch()} />
      ) : sessions.length === 0 ? (
        <EmptyState title={`No sessions on ${formatLocalDate(date)}`}>Choose another date. Sessions are created from the doctor schedule.</EmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl border border-rule bg-surface">
          <Table>
            <TableHeader className="bg-paper">
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-3">Doctor</TableHead>
                <TableHead>Department, room</TableHead>
                <TableHead>Session</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Booked</TableHead>
                <TableHead className="text-right">Walk-in</TableHead>
                <TableHead className="text-right">Policy</TableHead>
                <TableHead className="pr-3 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((s) => (
                <TableRow key={s.id} className="h-10" data-testid="session-row">
                  <TableCell className="pl-3 font-bold">{s.doctorName}</TableCell>
                  <TableCell>
                    {s.department}, room {s.room}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {sessionLabelWord(s)}, {sessionTimes(s)}
                  </TableCell>
                  <TableCell className="font-bold">{STATUS_WORD[s.status]}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    <span className="font-bold">{s.capacity.bookedReserved}</span>/{s.capacity.bookedCapacity}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <span className="font-bold">{s.capacity.walkinUsed}</span>/{s.capacity.walkinCapacity}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">v{s.policyVersion}</TableCell>
                  <TableCell className="pr-3 text-right">
                    <Button variant="outline" size="sm" onClick={() => setEditing(s)} aria-label={`Edit capacity, ${s.doctorName}, ${sessionLabelWord(s)}`}>
                      Edit capacity
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <CapacityDialog session={editing} onClose={() => setEditing(null)} />
    </section>
  );
}
