import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ROLE_LABEL } from '@/lib/auth';
import type { StaffMember } from '@hqms/contracts';
import { useDoctorsQuery, useSetAssignments, useStaffDirectory } from '@/api';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/queue';
import { InlineAlert } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { AddStaffDialog, PasswordDialog, StaffReasonDialog, type IssuedPassword } from './StaffDialogs';
import { ASSIGNABLE_ROLES, isActive, type StaffAction } from './staff-logic';
import { useNarrow } from './useNarrow';

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

interface RowActions {
  onAssign: (m: StaffMember) => void;
  onAction: (m: StaffMember, a: StaffAction) => void;
}

function StaffActions({ member: m, actions }: { member: StaffMember; actions: RowActions }) {
  const active = isActive(m);
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {ASSIGNABLE_ROLES.includes(m.role) ? (
        <Button variant="outline" size="sm" onClick={() => actions.onAssign(m)} aria-label={`Edit assignments, ${m.displayName}`}>
          Edit assignments
        </Button>
      ) : null}
      <Button variant="outline" size="sm" onClick={() => actions.onAction(m, 'reset')} aria-label={`Reset password, ${m.displayName}`}>
        Reset password
      </Button>
      {active ? (
        <Button variant="outline" size="sm" onClick={() => actions.onAction(m, 'deactivate')} aria-label={`Deactivate, ${m.displayName}`}>
          Deactivate
        </Button>
      ) : (
        <Button size="sm" onClick={() => actions.onAction(m, 'activate')} aria-label={`Activate, ${m.displayName}`}>
          Activate
        </Button>
      )}
    </div>
  );
}

const StatusWord = ({ member }: { member: StaffMember }) =>
  isActive(member) ? <span className="font-bold">Active</span> : <span className="font-bold text-muted-foreground">Deactivated</span>;

function assignedText(m: StaffMember, nameOf: (id: string) => string): string | null {
  if (m.role === 'admin') return 'Sees everything';
  if (m.role === 'doctor') return m.doctorId ? `Signs in as ${nameOf(m.doctorId)}` : 'No doctor record linked';
  return m.doctorIds.length === 0 ? null : m.doctorIds.map(nameOf).join(', ');
}

export default function StaffPage() {
  const staff = useStaffDirectory();
  const doctors = useDoctorsQuery();
  const narrow = useNarrow();
  const [editing, setEditing] = useState<StaffMember | null>(null);
  const [adding, setAdding] = useState(false);
  const [target, setTarget] = useState<{ member: StaffMember; action: StaffAction } | null>(null);
  const [issued, setIssued] = useState<IssuedPassword | null>(null);
  const nameOf = (id: string) => doctors.data?.find((d) => d.id === id)?.fullName ?? 'Unknown doctor';
  const actions: RowActions = { onAssign: setEditing, onAction: (member, action) => setTarget({ member, action }) };

  return (
    <section aria-labelledby="staff-h" className="grid gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h2 id="staff-h" className="text-lg font-bold">
            Staff
          </h2>
          <p className="text-muted-foreground">Sign-ins for reception, doctors, follow-up staff and admins. Reception and follow-up staff work only with the doctors assigned to them.</p>
        </div>
        <Button className="sm:ml-auto" onClick={() => setAdding(true)} disabled={staff.isPending || doctors.isPending}>
          Add staff member
        </Button>
      </div>
      {staff.isPending || doctors.isPending ? (
        <SkeletonRows count={5} />
      ) : staff.isError ? (
        <ErrorState title="Staff could not be loaded" error={staff.error} onRetry={() => void staff.refetch()} />
      ) : doctors.isError ? (
        <ErrorState title="Doctors could not be loaded" error={doctors.error} onRetry={() => void doctors.refetch()} />
      ) : staff.data.length === 0 ? (
        <EmptyState title="No staff accounts" action={<Button onClick={() => setAdding(true)}>Add staff member</Button>}>
          Create reception or follow-up accounts first. Then assign them to doctors here.
        </EmptyState>
      ) : narrow ? (
        <ul className="grid gap-2">
          {staff.data.map((m) => (
            <li key={m.userId} data-testid="staff-row" data-active={isActive(m)} className={cn('grid gap-1.5 rounded-xl border border-rule bg-surface p-3', !isActive(m) && 'bg-paper')}>
              <p className={cn('font-bold', !isActive(m) && 'text-muted-foreground')}>{m.displayName}</p>
              <p className="break-all text-muted-foreground">{m.email}</p>
              <p>
                {ROLE_LABEL[m.role]}, <StatusWord member={m} />
              </p>
              <p className="text-muted-foreground">{assignedText(m, nameOf) ?? 'No doctors assigned'}</p>
              <StaffActions member={m} actions={actions} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="overflow-hidden rounded-xl border border-rule bg-surface">
          <Table>
            <TableHeader className="bg-paper">
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-3">Staff member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Doctors</TableHead>
                <TableHead className="pr-3 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {staff.data.map((m) => (
                <TableRow key={m.userId} className={cn('h-10', !isActive(m) && 'bg-paper text-muted-foreground')} data-testid="staff-row" data-active={isActive(m)}>
                  <TableCell className="pl-3">
                    <span className={cn('block font-bold', isActive(m) && 'text-ink')}>{m.displayName}</span>
                    <span className="block text-sm">{m.email}</span>
                  </TableCell>
                  <TableCell>{ROLE_LABEL[m.role]}</TableCell>
                  <TableCell>
                    <StatusWord member={m} />
                  </TableCell>
                  <TableCell className="whitespace-normal">{assignedText(m, nameOf) ?? 'No doctors assigned'}</TableCell>
                  <TableCell className="pr-3 py-1.5">
                    <StaffActions member={m} actions={actions} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <AssignDialog member={editing} doctors={doctors.data ?? []} onClose={() => setEditing(null)} />
      <AddStaffDialog
        open={adding}
        doctors={doctors.data ?? []}
        staff={staff.data ?? []}
        onClose={() => setAdding(false)}
        onCreated={(c) => {
          setAdding(false);
          setIssued({ member: c.member, temporaryPassword: c.temporaryPassword, heading: 'Account created' });
        }}
      />
      <StaffReasonDialog target={target} onClose={() => setTarget(null)} onPassword={setIssued} />
      <PasswordDialog issued={issued} onDone={() => setIssued(null)} />
    </section>
  );
}
