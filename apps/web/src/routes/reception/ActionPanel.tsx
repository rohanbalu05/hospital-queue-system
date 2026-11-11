import { useState, type FormEvent, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { RegisterPatientRequest, type ArrivalResult, type Session } from '@hqms/contracts';
import { GroupTag, TokenText } from '@/components/queue';
import { InlineAlert, StatusWord } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatIST } from '@/lib/format';
import { canAdmitWalkIn, canCheckIn, type ArrivalItem, type ArrivalOutcome, type PanelError } from './model';

interface ActionPanelProps {
  item: ArrivalItem | null;
  session: Session | null;
  knownToken: ArrivalResult | undefined;
  onCheckIn: () => void;
  checkInPending: boolean;
  onAdmit: () => void;
  admitPending: boolean;
  onRegister: (form: RegisterPatientRequest) => void;
  registerPending: boolean;
  outcome: ArrivalOutcome | null;
  onDismissOutcome: () => void;
  error: PanelError | null;
  /** Queue-entry actions (mark absent, re-enter skipped) for the entry selected on the live board. */
  entryPanel?: ReactNode;
}

export function ActionPanel(p: ActionPanelProps) {
  const appt = p.item?.appointment ?? null;
  const walkinFull = p.session ? p.session.capacity.walkinAvailable <= 0 : false;
  const sessionOff = p.session ? p.session.status === 'closed' || p.session.status === 'unavailable' : false;

  return (
    <section aria-label="Actions" className="flex min-w-0 flex-col gap-4">
      {p.outcome ? <Outcome outcome={p.outcome} onDone={p.onDismissOutcome} /> : null}

      {p.error ? (
        <InlineAlert title={p.error.title}>
          <p>{p.error.message}</p>
          {p.error.hint ? <p className="mt-1">{p.error.hint}</p> : null}
        </InlineAlert>
      ) : null}

      <div className="rounded-xl border border-rule bg-surface p-4">
        <h2 className="text-lg font-bold">Check in</h2>
        {!p.item ? (
          <p className="mt-1 text-muted-foreground">Choose someone in the list to check them in.</p>
        ) : (
          <>
            <div className="mt-2">
              <p className="text-base font-bold">{p.item.name}</p>
              <p className="text-muted-foreground tabular-nums">{[p.item.mrn, p.item.phone].filter(Boolean).join('  ') || 'No MRN or phone shown'}</p>
              {appt ? (
                <p className="mt-1 tabular-nums">
                  Appointment {formatIST(appt.scheduledAt)}, <StatusWord status={appt.status} />
                  {p.knownToken ? (
                    <>
                      , token <span className="font-bold">{p.knownToken.token}</span>
                    </>
                  ) : null}
                </p>
              ) : (
                <p className="mt-1">No appointment in this session.</p>
              )}
            </div>
            <Button size="lg" className="mt-3 w-full" disabled={!canCheckIn(p.item) || p.checkInPending || sessionOff} onClick={p.onCheckIn}>
              {p.checkInPending ? 'Checking in…' : 'Check in'}
            </Button>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {canCheckIn(p.item)
                ? 'Press Enter in the search box to check in.'
                : appt?.status === 'checked_in'
                  ? 'Already checked in.'
                  : appt
                    ? `This appointment is ${appt.status === 'completed' ? 'completed' : appt.status}. It cannot be checked in.`
                    : 'Only a booked appointment can be checked in. Use Admit walk-in below.'}
            </p>
          </>
        )}
      </div>

      <div className="rounded-xl border border-rule bg-surface p-4">
        <h2 className="text-lg font-bold">Admit walk-in</h2>
        <p className="mt-1 text-muted-foreground">
          Uses a walk-in place:{' '}
          <span className="font-bold tabular-nums">
            {p.session ? `${p.session.capacity.walkinUsed}/${p.session.capacity.walkinCapacity}` : '-'}
          </span>{' '}
          taken.
        </p>
        {p.item && canAdmitWalkIn(p.item) ? (
          <Button
            size="lg"
            variant="outline"
            className="mt-3 w-full"
            disabled={p.admitPending || walkinFull || sessionOff}
            onClick={p.onAdmit}
          >
            {p.admitPending ? 'Admitting…' : `Admit walk-in: ${p.item.name}`}
          </Button>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            {p.item ? 'This patient has a live appointment in this session. Check them in instead.' : 'Search for the patient first, or register a new one below.'}
          </p>
        )}
        {walkinFull ? <p className="mt-1.5 text-sm font-bold">Walk-in places are full for this session.</p> : null}

        <RegisterForm pending={p.registerPending} disabled={walkinFull || sessionOff || !p.session} onSubmit={p.onRegister} />
      </div>

      {p.entryPanel}
    </section>
  );
}

function Outcome({ outcome, onDone }: { outcome: ArrivalOutcome; onDone: () => void }) {
  const { result, name, verb } = outcome;
  const late = result.kind === 'late_admission';
  return (
    <div role="status" data-testid="arrival-outcome" className="rounded-xl border border-l-[3px] border-rule border-l-ink bg-surface p-4">
      <p className="text-lg font-bold">{verb}</p>
      <p className="mt-0.5 font-bold">{name}</p>
      <div className="mt-2 flex items-center gap-3">
        <TokenText token={result.token} size="xl" className="[&_[data-token]]:text-[72px] [&_[data-token]]:leading-none" />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <GroupTag group={result.group} showName />
        {late ? <span className="text-sm font-bold">Late arrival, walk-in order</span> : null}
      </div>
      <p className="mt-2 text-muted-foreground tabular-nums">Eligible to be called from {formatIST(result.eligibleAt)}. Tell the patient their token.</p>
      <Button variant="outline" className="mt-3" onClick={onDone}>
        Next arrival
      </Button>
    </div>
  );
}

function RegisterForm({ pending, disabled, onSubmit }: { pending: boolean; disabled: boolean; onSubmit: (form: RegisterPatientRequest) => void }) {
  const [open, setOpen] = useState(false);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [dob, setDob] = useState('');
  const [errors, setErrors] = useState<Partial<Record<'fullName' | 'phone' | 'dateOfBirth', string>>>({});

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = RegisterPatientRequest.safeParse({
      fullName: fullName.trim(),
      phone: phone.trim() === '' ? null : phone.trim(),
      dateOfBirth: dob === '' ? null : dob,
    });
    if (!parsed.success) {
      const next: typeof errors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (key === 'fullName') next.fullName = 'Enter the full name, at least 2 letters.';
        if (key === 'phone') next.phone = 'Enter 8 to 15 digits, with an optional + at the start.';
        if (key === 'dateOfBirth') next.dateOfBirth = 'Enter a valid date.';
      }
      setErrors(next);
      return;
    }
    setErrors({});
    onSubmit(parsed.data);
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-4 border-t border-rule pt-3">
      <CollapsibleTrigger className="flex min-h-10 w-full items-center justify-between rounded-md text-left font-bold    ">
        Register new patient
        <ChevronDown aria-hidden="true" className={open ? 'size-4 rotate-180' : 'size-4'} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <form onSubmit={submit} noValidate className="mt-2 space-y-3">
          <div className="space-y-1">
            <Label htmlFor="reg-name">Full name</Label>
            <Input id="reg-name" value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="off" aria-invalid={Boolean(errors.fullName)} aria-describedby={errors.fullName ? 'reg-name-err' : undefined} />
            {errors.fullName ? (
              <p id="reg-name-err" className="text-sm font-bold text-ink">
                {errors.fullName}
              </p>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor="reg-phone">Phone (optional)</Label>
            <Input id="reg-phone" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="off" aria-invalid={Boolean(errors.phone)} aria-describedby={errors.phone ? 'reg-phone-err' : undefined} />
            {errors.phone ? (
              <p id="reg-phone-err" className="text-sm font-bold text-ink">
                {errors.phone}
              </p>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor="reg-dob">Date of birth (optional)</Label>
            <Input id="reg-dob" type="date" value={dob} onChange={(e) => setDob(e.target.value)} aria-invalid={Boolean(errors.dateOfBirth)} />
            {errors.dateOfBirth ? <p className="text-sm font-bold text-ink">{errors.dateOfBirth}</p> : null}
          </div>
          <Button type="submit" size="lg" className="w-full" disabled={pending || disabled}>
            {pending ? 'Registering…' : 'Register and admit walk-in'}
          </Button>
        </form>
      </CollapsibleContent>
    </Collapsible>
  );
}
