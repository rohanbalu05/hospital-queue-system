import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ROLE_LABEL } from '@/lib/auth';
import { useDoctorsQuery, useSetAssignments, useStaffDirectory, type StaffMember } from '@/api';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/queue';
import { InlineAlert } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function AssignDialog({ member, doctors, onClose }: { member: StaffMember | null; doctors: Array<{ id: string; fullName: string; department: string }>; onClose: () => void }) {
  const save = useSetAssignments();
  const [picked, setPicked] = useState<string[]>([]);
  const { reset } = save;
  useEffect(() => {
    if (member) {
      setPicked(member.doctorIds);
      reset();
    }
  }, [member, reset]);

  const toggle = (id: string, on: boolean) => setPicked((p) => (on ? [...new Set([...p, id])] : p.filter((x) => x !== id)));

  return (
    <Dialog open={member !== null} onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent>
        {member ? (
          <>
            <DialogHeader>
              <DialogTitle>Assign doctors</DialogTitle>
              <DialogDescription>
                {member.displayName} ({ROLE_LABEL[member.role]}) sees queues, arrivals and tasks only for the doctors ticked here.
              </DialogDescription>
            </DialogHeader>
            <fieldset className="grid gap-0 divide-y divide-rule overflow-hidden rounded-xl border border-rule">
              <legend className="sr-only">Doctors</legend>
              {doctors.map((d) => (
                <label key={d.id} className="flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2 has-[[data-state=checked]]:bg-secondary">
                  <Checkbox checked={picked.includes(d.id)} onCheckedChange={(c) => toggle(d.id, c === true)} />
                  <span className="min-w-0">
                    <span className="block font-bold">{d.fullName}</span>
                    <span className="block text-sm text-muted-foreground">{d.department}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {save.isError ? <InlineAlert title="Assignments not saved">{save.error.message}</InlineAlert> : null}
            <DialogFooter>
              <Button variant="outline" size="lg" onClick={onClose} disabled={save.isPending}>
                Cancel
              </Button>
              <Button
                size="lg"
                disabled={save.isPending}
                onClick={() =>
                  save.mutate(
                    { userId: member.userId, doctorIds: picked },
                    {
                      onSuccess: () => {
                        toast.success('Assignments saved');
                        onClose();
                      },
                    },
                  )
                }
              >
                {save.isPending ? 'Saving…' : 'Save assignments'}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export default function StaffPage() {
  const staff = useStaffDirectory();
  const doctors = useDoctorsQuery();
  const [editing, setEditing] = useState<StaffMember | null>(null);
  const nameOf = (id: string) => doctors.data?.find((d) => d.id === id)?.fullName ?? 'Unknown doctor';

  return (
    <section aria-labelledby="staff-h" className="grid gap-3">
      <div>
        <h2 id="staff-h" className="text-lg font-bold">
          Staff assignments
        </h2>
        <p className="text-muted-foreground">Reception and follow-up staff work only with the doctors assigned to them.</p>
      </div>
      {staff.isPending || doctors.isPending ? (
        <SkeletonRows count={5} />
      ) : staff.isError ? (
        <ErrorState title="Staff could not be loaded" error={staff.error} onRetry={() => void staff.refetch()} />
      ) : doctors.isError ? (
        <ErrorState title="Doctors could not be loaded" error={doctors.error} onRetry={() => void doctors.refetch()} />
      ) : staff.data.length === 0 ? (
        <EmptyState title="No staff accounts">Create reception or follow-up accounts first. Then assign them to doctors here.</EmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl border border-rule bg-surface">
          <Table>
            <TableHeader className="bg-paper">
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-3">Staff member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Assigned doctors</TableHead>
                <TableHead className="pr-3 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {staff.data.map((m) => (
                <TableRow key={m.userId} className="h-10" data-testid="staff-row">
                  <TableCell className="pl-3 font-bold">{m.displayName}</TableCell>
                  <TableCell>{ROLE_LABEL[m.role]}</TableCell>
                  <TableCell className="whitespace-normal">
                    {m.doctorIds.length === 0 ? <span className="text-muted-foreground">No doctors assigned</span> : m.doctorIds.map(nameOf).join(', ')}
                  </TableCell>
                  <TableCell className="pr-3 text-right">
                    <Button variant="outline" size="sm" onClick={() => setEditing(m)} aria-label={`Edit assignments, ${m.displayName}`}>
                      Edit assignments
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <AssignDialog member={editing} doctors={doctors.data ?? []} onClose={() => setEditing(null)} />
    </section>
  );
}
