import { useState } from 'react';
import { toast } from 'sonner';
import type { LocalDate } from '@hqms/contracts';
import { useCreateSession, useCurrentPolicy, useDoctorsQuery } from '@/api';
import { Field } from '@/components/layout/Field';
import { InlineAlert } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { plainErrorMessage } from '@/components/queue/states';
import { ApiRequestError } from '@/lib/api';
import { createFailureWords, dayWords, istInstant, labelWordFor, overlapOf, overlapWords, repeatDates } from './sessions-logic';

export const MAX_REPEAT_DAYS = 13;

interface DayResult {
  date: LocalDate;
  ok: boolean;
  words: string;
}

interface FormErrors {
  doctor?: string;
  date?: string;
  end?: string;
  capacity?: string;
  repeat?: string;
}

const WHOLE = /^\d{1,3}$/;

function NewSessionForm({ defaultDate, onClose }: { defaultDate: LocalDate; onClose: (firstCreated: LocalDate | null) => void }) {
  const doctors = useDoctorsQuery();
  const policy = useCurrentPolicy();
  const create = useCreateSession();

  const [doctorId, setDoctorId] = useState('');
  const [date, setDate] = useState<LocalDate>(defaultDate);
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('13:00');
  // null = untouched: follow the current policy's defaults once they arrive.
  const [booked, setBooked] = useState<string | null>(null);
  const [walkin, setWalkin] = useState<string | null>(null);
  const [repeat, setRepeat] = useState('0');

  const [errors, setErrors] = useState<FormErrors>({});
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);
  const [singleFailure, setSingleFailure] = useState<{ title: string; text: string } | null>(null);
  const [results, setResults] = useState<DayResult[] | null>(null);

  const bookedValue = booked ?? String(policy.data?.defaultBookedCapacity ?? 10);
  const walkinValue = walkin ?? String(policy.data?.defaultWalkinCapacity ?? 5);
  const activeDoctors = (doctors.data ?? []).filter((d) => d.active);
  const doctor = activeDoctors.find((d) => d.id === doctorId);
  const label = start ? labelWordFor(istInstant(date || defaultDate, start)) : null;
  const extraDays = /^\d{1,2}$/.test(repeat.trim()) ? Number(repeat) : 0;
  const total = extraDays + 1;

  const validate = (): FormErrors => {
    const e: FormErrors = {};
    if (!doctor) e.doctor = 'Choose a doctor.';
    if (!date) e.date = 'Choose a date.';
    if (!start || !end || end <= start) e.end = 'The end time must be after the start time.';
    if (!WHOLE.test(bookedValue.trim()) || !WHOLE.test(walkinValue.trim()) || Number(bookedValue) > 100 || Number(walkinValue) > 100) {
      e.capacity = 'Enter whole numbers from 0 to 100.';
    }
    if (!/^\d{1,2}$/.test(repeat.trim()) || Number(repeat) > MAX_REPEAT_DAYS) e.repeat = `Repeat for 0 to ${MAX_REPEAT_DAYS} days.`;
    return e;
  };

  const submit = async () => {
    const found = validate();
    setErrors(found);
    setSingleFailure(null);
    if (Object.keys(found).length > 0 || !doctor) return;

    const dates = repeatDates(date, Number(repeat));
    const collected: DayResult[] = [];
    setRunning({ done: 0, total: dates.length });
    for (const day of dates) {
      const startsAt = istInstant(day, start);
      try {
        await create.mutateAsync({
          doctorId: doctor.id,
          sessionDate: day,
          label: labelWordFor(startsAt).toLowerCase() as 'morning' | 'afternoon' | 'evening' | 'night',
          startsAt,
          endsAt: istInstant(day, end),
          bookedCapacity: Number(bookedValue),
          walkinCapacity: Number(walkinValue),
        });
        collected.push({ date: day, ok: true, words: 'created' });
      } catch (err) {
        if (dates.length === 1) {
          const overlap = overlapOf(err);
          setSingleFailure({
            title: 'Session not created',
            text: overlap ? overlapWords(overlap, doctor.fullName) : (err instanceof ApiRequestError ? plainErrorMessage(err) : null) ?? 'Something went wrong. Try again.',
          });
          setRunning(null);
          return;
        }
        collected.push({ date: day, ok: false, words: createFailureWords(err) });
      }
      setRunning({ done: collected.length, total: dates.length });
    }
    setRunning(null);
    const created = collected.filter((r) => r.ok);
    const firstCreated = created[0]?.date ?? null;
    if (created.length === collected.length) {
      toast.success(created.length === 1 ? 'Session created' : `${created.length} sessions created`);
      onClose(firstCreated);
      return;
    }
    setResults(collected);
  };

  if (results) {
    const ok = results.filter((r) => r.ok).length;
    const skipped = results.length - ok;
    const firstCreated = results.find((r) => r.ok)?.date ?? null;
    return (
      <>
        <DialogHeader>
          <DialogTitle>New session</DialogTitle>
          <DialogDescription>
            {ok} of {results.length} sessions created. {skipped} {skipped === 1 ? 'was' : 'were'} skipped.
          </DialogDescription>
        </DialogHeader>
        <ul className="grid gap-0 divide-y divide-rule overflow-hidden rounded-md border border-rule">
          {results.map((r) => (
            <li key={r.date} data-testid="create-result" data-ok={r.ok} className="flex min-h-10 items-center px-3 py-2">
              <p>
                <span className="font-bold tabular-nums">{dayWords(r.date)}:</span> <span className={r.ok ? 'text-done' : undefined}>{r.words}</span>
              </p>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">Skipped days were left as they were. Change the times and create them again if you still need them.</p>
        <DialogFooter>
          <Button size="lg" onClick={() => onClose(firstCreated)}>
            Done
          </Button>
        </DialogFooter>
      </>
    );
  }

  const busy = running !== null;
  return (
    <>
      <DialogHeader>
        <DialogTitle>New session</DialogTitle>
        <DialogDescription>A doctor’s clinic for part of one day. Times are Bengaluru time.</DialogDescription>
      </DialogHeader>
      <form
        className="grid gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Doctor" error={errors.doctor ?? null}>
          {(p) => (
            <Select value={doctorId} onValueChange={setDoctorId}>
              <SelectTrigger {...p} className="w-full">
                <SelectValue placeholder={doctors.isPending ? 'Loading doctors…' : 'Choose a doctor'} />
              </SelectTrigger>
              <SelectContent>
                {activeDoctors.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.fullName}, {d.department}, room {d.room}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
        {doctors.isError ? <InlineAlert title="Doctors could not be loaded">Close this dialog and try again.</InlineAlert> : null}

        <Field label="Date" hint={date ? dayWords(date) : undefined} error={errors.date ?? null}>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Start time">
            <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="End time" error={errors.end ?? null}>
            <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <p className="text-sm">
          <span className="text-muted-foreground">Session label </span>
          <span className="font-bold" data-testid="new-session-label">
            {label ?? '-'}
          </span>
          <span className="text-muted-foreground">, set from the start time.</span>
        </p>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Booked places" error={errors.capacity ?? null}>
            <Input type="number" inputMode="numeric" min={0} max={100} value={bookedValue} onChange={(e) => setBooked(e.target.value)} />
          </Field>
          <Field label="Walk-in places">
            <Input type="number" inputMode="numeric" min={0} max={100} value={walkinValue} onChange={(e) => setWalkin(e.target.value)} />
          </Field>
        </div>

        <Field
          label="Repeat for the next days"
          hint={extraDays > 0 ? `Creates ${total} sessions: ${dayWords(date)} to ${dayWords(repeatDates(date, extraDays).at(-1) ?? date)}.` : '0 creates this date only. Up to 13.'}
          error={errors.repeat ?? null}
        >
          <Input type="number" inputMode="numeric" min={0} max={MAX_REPEAT_DAYS} value={repeat} onChange={(e) => setRepeat(e.target.value)} className="w-28" />
        </Field>

        {singleFailure ? <InlineAlert title={singleFailure.title}>{singleFailure.text}</InlineAlert> : null}

        <DialogFooter>
          <Button type="button" variant="outline" size="lg" onClick={() => onClose(null)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" size="lg" disabled={busy}>
            {busy ? `Creating ${Math.min(running.done + 1, running.total)} of ${running.total}…` : total > 1 ? `Create ${total} sessions` : 'Create session'}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

/** Admin: create one session, or the same session on the next N days (one request per day; days that fail are skipped and listed). */
export function NewSessionDialog({ open, defaultDate, onClose }: { open: boolean; defaultDate: LocalDate; onClose: (firstCreated: LocalDate | null) => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose(null)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">{open ? <NewSessionForm defaultDate={defaultDate} onClose={onClose} /> : null}</DialogContent>
    </Dialog>
  );
}
