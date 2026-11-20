import { useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import type { CreateStaffRequest, Doctor, StaffCredentials, StaffMember } from '@hqms/contracts';
import { useCreateStaff, useResetPassword, useSetStaffActive } from '@/api';
import { Field } from '@/components/layout/Field';
import { InlineAlert } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ROLE_LABEL, useAuth } from '@/lib/auth';
import { ASSIGNABLE_ROLES, doctorsWithoutLogin, staffErrorWords, type StaffAction } from './staff-logic';

export interface IssuedPassword {
  member: StaffMember;
  temporaryPassword: string;
  /** Why this password exists: "Account created" or "Password reset". */
  heading: string;
}

/** The one-time temporary password. Shown once; it cannot be closed by clicking outside, so it is not lost by accident. */
export function PasswordDialog({ issued, onDone }: { issued: IssuedPassword | null; onDone: () => void }) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const copy = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.temporaryPassword);
      setCopied('yes');
      toast.success('Password copied');
    } catch {
      setCopied('failed');
    }
  };
  const done = () => {
    setCopied(null);
    onDone();
  };
  return (
    <Dialog open={issued !== null} onOpenChange={() => undefined}>
      <DialogContent showCloseButton={false} onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
        {issued ? (
          <>
            <DialogHeader>
              <DialogTitle>Temporary password</DialogTitle>
              <DialogDescription>
                {issued.heading} for {issued.member.displayName} ({issued.member.email}).
              </DialogDescription>
            </DialogHeader>
            <p data-testid="temp-password" className="select-all rounded-md border border-rule bg-paper px-3 py-3 text-xl font-bold tracking-wide tabular-nums break-all">
              {issued.temporaryPassword}
            </p>
            <p className="font-bold">Give this to the staff member. It is shown only once.</p>
            <p className="text-sm text-muted-foreground">They should change it after signing in. If it is lost, reset the password from the Staff list.</p>
            {copied === 'failed' ? <InlineAlert title="Could not copy">Select the password above and copy it by hand.</InlineAlert> : null}
            <DialogFooter>
              <Button variant="outline" size="lg" onClick={() => void copy()}>
                {copied === 'yes' ? 'Copied' : 'Copy password'}
              </Button>
              <Button size="lg" onClick={done}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

interface AddErrors {
  name?: string;
  email?: string;
  role?: string;
  doctor?: string;
  department?: string;
  room?: string;
}

const ROLE_OPTIONS: Array<{ value: StaffMember['role']; label: string }> = [
  { value: 'reception', label: ROLE_LABEL.reception },
  { value: 'doctor', label: ROLE_LABEL.doctor },
  { value: 'followup', label: ROLE_LABEL.followup },
  { value: 'admin', label: ROLE_LABEL.admin },
];

function AddStaffForm({
  doctors,
  staff,
  onClose,
  onCreated,
}: {
  doctors: Doctor[];
  staff: StaffMember[];
  onClose: () => void;
  onCreated: (c: StaffCredentials) => void;
}) {
  const create = useCreateStaff();
  const free = doctorsWithoutLogin(
    doctors.filter((d) => d.active),
    staff,
  );
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<StaffMember['role'] | ''>('');
  const [doctorMode, setDoctorMode] = useState<'existing' | 'new'>(free.length > 0 ? 'existing' : 'new');
  const [doctorId, setDoctorId] = useState('');
  const [department, setDepartment] = useState('');
  const [room, setRoom] = useState('');
  const [assigned, setAssigned] = useState<string[]>([]);
  const [errors, setErrors] = useState<AddErrors>({});

  const submit = () => {
    const e: AddErrors = {};
    if (name.trim().length < 2) e.name = 'Enter the staff member’s full name.';
    if (!z.string().email().safeParse(email.trim()).success) e.email = 'Enter a valid email address.';
    if (!role) e.role = 'Choose a role.';
    if (role === 'doctor') {
      if (doctorMode === 'existing' && !doctorId) e.doctor = 'Choose a doctor record.';
      if (doctorMode === 'new') {
        if (department.trim().length < 2) e.department = 'Enter the department.';
        if (!room.trim()) e.room = 'Enter the room.';
      }
    }
    setErrors(e);
    if (Object.keys(e).length > 0 || !role) return;

    const body: CreateStaffRequest = { displayName: name.trim(), email: email.trim().toLowerCase(), role };
    if (role === 'doctor') {
      if (doctorMode === 'existing') body.doctorId = doctorId;
      else body.newDoctor = { department: department.trim(), room: room.trim() };
    } else if (ASSIGNABLE_ROLES.includes(role) && assigned.length > 0) {
      body.doctorIds = assigned;
    }
    create.mutate(body, { onSuccess: onCreated });
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add staff member</DialogTitle>
        <DialogDescription>Creates a sign-in with a temporary password that you hand over in person.</DialogDescription>
      </DialogHeader>
      <form
        className="grid gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Name" error={errors.name ?? null}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Email" error={errors.email ?? null}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Role" error={errors.role ?? null}>
          {(p) => (
            <Select value={role} onValueChange={(v) => setRole(v as StaffMember['role'])}>
              <SelectTrigger {...p} className="w-full">
                <SelectValue placeholder="Choose a role" />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>

        {role === 'doctor' ? (
          <fieldset className="grid gap-3 rounded-md border border-rule p-3">
            <legend className="px-1 text-sm font-bold">Doctor record</legend>
            <RadioGroup value={doctorMode} onValueChange={(v) => setDoctorMode(v as 'existing' | 'new')} aria-label="How to set up the doctor">
              <div className="flex min-h-10 items-center gap-3">
                <RadioGroupItem value="existing" id="doctor-existing" disabled={free.length === 0} />
                <Label htmlFor="doctor-existing">Link an existing doctor</Label>
              </div>
              <div className="flex min-h-10 items-center gap-3">
                <RadioGroupItem value="new" id="doctor-new" />
                <Label htmlFor="doctor-new">Create a new doctor record</Label>
              </div>
            </RadioGroup>
            {doctorMode === 'existing' ? (
              <Field label="Doctor record" hint={free.length === 0 ? 'Every doctor already has a sign-in.' : 'Doctors who do not have a sign-in yet.'} error={errors.doctor ?? null}>
                {(p) => (
                  <Select value={doctorId} onValueChange={setDoctorId} disabled={free.length === 0}>
                    <SelectTrigger {...p} className="w-full">
                      <SelectValue placeholder="Choose a doctor" />
                    </SelectTrigger>
                    <SelectContent>
                      {free.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.fullName}, {d.department}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <Field label="Department" error={errors.department ?? null}>
                  <Input value={department} onChange={(e) => setDepartment(e.target.value)} />
                </Field>
                <Field label="Room" error={errors.room ?? null}>
                  <Input value={room} onChange={(e) => setRoom(e.target.value)} />
                </Field>
              </div>
            )}
          </fieldset>
        ) : null}

        {role === 'reception' || role === 'followup' ? (
          <fieldset className="grid gap-0 divide-y divide-rule overflow-hidden rounded-xl border border-rule">
            <legend className="sr-only">Assigned doctors (optional)</legend>
            <p className="bg-paper px-3 py-2 text-sm font-bold" aria-hidden="true">
              Assigned doctors (optional)
            </p>
            {doctors
              .filter((d) => d.active)
              .map((d) => (
                <label key={d.id} className="flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2 has-[[data-state=checked]]:bg-secondary">
                  <Checkbox checked={assigned.includes(d.id)} onCheckedChange={(c) => setAssigned((p) => (c === true ? [...new Set([...p, d.id])] : p.filter((x) => x !== d.id)))} />
                  <span className="min-w-0">
                    <span className="block font-bold">{d.fullName}</span>
                    <span className="block text-sm text-muted-foreground">{d.department}</span>
                  </span>
                </label>
              ))}
          </fieldset>
        ) : null}

        {create.isError ? <InlineAlert title="Account not created">{staffErrorWords(create.error)}</InlineAlert> : null}
        <DialogFooter>
          <Button type="button" variant="outline" size="lg" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" size="lg" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create account'}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

export function AddStaffDialog({
  open,
  doctors,
  staff,
  onClose,
  onCreated,
}: {
  open: boolean;
  doctors: Doctor[];
  staff: StaffMember[];
  onClose: () => void;
  onCreated: (c: StaffCredentials) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">{open ? <AddStaffForm doctors={doctors} staff={staff} onClose={onClose} onCreated={onCreated} /> : null}</DialogContent>
    </Dialog>
  );
}

const COPY: Record<StaffAction, { title: string; confirm: string; pending: string; failed: string; body: (m: StaffMember) => string }> = {
  deactivate: {
    title: 'Deactivate this account?',
    confirm: 'Deactivate account',
    pending: 'Deactivating…',
    failed: 'Account not deactivated',
    body: (m) => `${m.displayName} will be signed out at once and cannot sign in again until the account is activated.`,
  },
  activate: {
    title: 'Activate this account?',
    confirm: 'Activate account',
    pending: 'Activating…',
    failed: 'Account not activated',
    body: (m) => `${m.displayName} will be able to sign in again with their current password.`,
  },
  reset: {
    title: 'Reset password',
    confirm: 'Reset password',
    pending: 'Resetting…',
    failed: 'Password not reset',
    body: (m) => `${m.displayName} will be signed out and get a new temporary password. You will see it once.`,
  },
};

function ReasonForm({ member, action, onClose, onPassword }: { member: StaffMember; action: StaffAction; onClose: () => void; onPassword: (p: IssuedPassword) => void }) {
  const { me } = useAuth();
  const setActive = useSetStaffActive();
  const reset = useResetPassword();
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [selfError, setSelfError] = useState(false);
  const copy = COPY[action];
  const mutation = action === 'reset' ? reset : setActive;
  const pending = mutation.isPending;

  const submit = () => {
    setSelfError(false);
    if (reason.trim().length < 3) {
      setFieldError('Give a reason of at least 3 characters.');
      return;
    }
    setFieldError(null);
    if (action === 'deactivate' && me?.userId === member.userId) {
      setSelfError(true);
      return;
    }
    if (action === 'reset') {
      reset.mutate(
        { userId: member.userId, reason: reason.trim() },
        { onSuccess: (c) => onPassword({ member: c.member, temporaryPassword: c.temporaryPassword, heading: 'Password reset' }) },
      );
      return;
    }
    setActive.mutate(
      { userId: member.userId, active: action === 'activate', reason: reason.trim() },
      {
        onSuccess: () => {
          toast.success(action === 'activate' ? 'Account activated' : 'Account deactivated');
          onClose();
        },
      },
    );
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.body(member)}</DialogDescription>
      </DialogHeader>
      <form
        className="grid gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Reason" hint="Kept in the audit trail." error={fieldError}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={3} />
        </Field>
        {selfError ? <InlineAlert title={copy.failed}>You cannot deactivate your own account. Ask another admin to do it.</InlineAlert> : null}
        {mutation.isError ? <InlineAlert title={copy.failed}>{staffErrorWords(mutation.error)}</InlineAlert> : null}
        <DialogFooter>
          <Button type="button" variant="outline" size="lg" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" size="lg" variant={action === 'deactivate' ? 'destructive' : 'default'} disabled={pending}>
            {pending ? copy.pending : copy.confirm}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

/** Deactivate, activate or reset a password: each needs a reason, which goes to the audit trail. */
export function StaffReasonDialog({
  target,
  onClose,
  onPassword,
}: {
  target: { member: StaffMember; action: StaffAction } | null;
  onClose: () => void;
  onPassword: (p: IssuedPassword) => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        {target ? (
          <ReasonForm
            key={`${target.member.userId}-${target.action}`}
            member={target.member}
            action={target.action}
            onClose={onClose}
            onPassword={(p) => {
              onClose();
              onPassword(p);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
