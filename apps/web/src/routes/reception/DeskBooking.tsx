import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { Appointment, Session } from '@hqms/contracts';
import { useDoctorsQuery, useRescheduleAppointment, useSessionsQuery, useSlotsQuery } from '@/api';
import { useBookForPatient, useCancelForPatient } from '@/api/queue';
import { Field } from '@/components/layout/Field';
import { ErrorState, SkeletonRows } from '@/components/queue';
import { Choice, ChoiceList } from '@/components/scheduling/choice';
import {
  PlacesLeft,
  SessionChoiceList,
  bookability,
  placesLeft,
  sessionLabelWord,
  sessionTimes,
} from '@/components/scheduling/sessions';
import { InlineAlert } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiRequestError } from '@/lib/api';
import { addDays, formatLocalDate, istDate, nextDays } from '@/lib/dates';
import { formatIST } from '@/lib/format';
import type { DeskPatient } from './deskTypes';

/** Words for the errors a desk booking, cancel or reschedule can hit. */
export function bookingErrorWords(err: unknown, what: string): { title: string; message: string } {
  const title = `The appointment was not ${what}`;
  if (err instanceof ApiRequestError) {
    switch (err.code) {
      case 'CAPACITY_FULL':
        return { title, message: 'That session has no places left. Choose another session.' };
      case 'CONFLICT':
      case 'INVALID_TRANSITION':
        return {
          title,
          message:
            'The appointment changed while you were working. The list has been refreshed. Check it and try again.',
        };
      case 'NETWORK':
        return {
          title,
          message: `${err.message} Press the button again: the same request is sent, so nothing is done twice.`,
        };
      case 'FORBIDDEN':
        return { title, message: 'Your role cannot do this for this doctor.' };
      default:
        return { title, message: err.message };
    }
  }
  return { title, message: 'Something went wrong. Try again.' };
}

/** "Today", "Tomorrow" or "Fri, 21 Nov", for a hospital-local date. */
export function dayWord(date: string, today: string = istDate()): string {
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  return formatLocalDate(date);
}

const DAYS = 7;

/** Next free slot and places left for the chosen session, from GET /sessions/{id}/slots. */
function SlotSummary({ session }: { session: Session }) {
  const slots = useSlotsQuery(session.id);
  const next = slots.data?.slots.find((s) => s.available) ?? null;
  const { left, of } = placesLeft(session);
  return (
    <div
      className="rounded-md border border-l-[3px] border-rule border-l-appt bg-surface px-3 py-2.5"
      data-testid="slot-summary"
    >
      {slots.isPending ? (
        <p className="text-muted-foreground">Checking the next free slot…</p>
      ) : slots.isError ? (
        <p className="text-muted-foreground">The slot could not be checked. The server will give the next free one.</p>
      ) : next ? (
        <p className="tabular-nums">
          Next free slot: <span className="font-bold">{formatIST(next.scheduledAt)}</span>
        </p>
      ) : (
        <p className="font-bold">No free slot is left in this session.</p>
      )}
      <p className="text-muted-foreground tabular-nums">{`${left} of ${of} places left.`}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Book appointment
// ---------------------------------------------------------------------------------------------------------------------

export function BookPanel({
  patient,
  onBack,
  onDone,
}: {
  patient: DeskPatient;
  onBack: () => void;
  onDone: () => void;
}) {
  const doctorsQ = useDoctorsQuery();
  const doctors = useMemo(() => (doctorsQ.data ?? []).filter((d) => d.active), [doctorsQ.data]);
  const departments = useMemo(() => [...new Set(doctors.map((d) => d.department))].sort(), [doctors]);
  const [department, setDepartment] = useState('');
  const [doctorId, setDoctorId] = useState('');
  const [date, setDate] = useState('');
  const [sessionId, setSessionId] = useState('');
  const bookRef = useRef<HTMLButtonElement>(null);

  const days = useMemo(() => nextDays(DAYS), []);
  const sessionsQ = useSessionsQuery(
    { doctorId, from: days[0] as string, to: days[DAYS - 1] as string },
    { enabled: doctorId !== '' },
  );
  const sessions = useMemo(() => sessionsQ.data ?? [], [sessionsQ.data]);
  const onDay = sessions.filter((s) => s.sessionDate === date);
  const session = sessions.find((s) => s.id === sessionId) ?? null;
  const doctor = doctors.find((d) => d.id === doctorId) ?? null;

  const book = useBookForPatient();
  const error = book.error ? bookingErrorWords(book.error, 'booked') : null;

  if (doctorsQ.isPending) return <SkeletonRows count={4} />;
  if (doctorsQ.isError)
    return (
      <ErrorState title="Doctors could not be loaded" error={doctorsQ.error} onRetry={() => void doctorsQ.refetch()} />
    );

  const confirm = () => {
    if (!session || book.isPending) return;
    book.mutate(
      { sessionId: session.id, patientId: patient.id },
      {
        onSuccess: (appt) => {
          toast.success('Booked', {
            description: `${patient.name} with ${appt.doctorName}, ${dayWord(istDate(appt.scheduledAt))}, about ${formatIST(appt.scheduledAt)}`,
          });
          onDone();
        },
      },
    );
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Department">
          {(f) => (
            <Select
              value={department}
              onValueChange={(v) => {
                setDepartment(v);
                if (doctor && doctor.department !== v) {
                  setDoctorId('');
                  setDate('');
                  setSessionId('');
                }
              }}
            >
              <SelectTrigger {...f} className="h-10 w-full">
                <SelectValue placeholder="Choose a department" />
              </SelectTrigger>
              <SelectContent>
                {departments.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
        <Field label="Doctor">
          {(f) => (
            <Select
              value={doctorId}
              disabled={department === ''}
              onValueChange={(v) => {
                setDoctorId(v);
                setDate('');
                setSessionId('');
              }}
            >
              <SelectTrigger {...f} className="h-10 w-full">
                <SelectValue placeholder={department === '' ? 'Choose a department first' : 'Choose a doctor'} />
              </SelectTrigger>
              <SelectContent>
                {doctors
                  .filter((d) => d.department === department)
                  .map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.fullName}, room {d.room}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          )}
        </Field>
      </div>

      {doctorId !== '' ? (
        sessionsQ.isPending ? (
          <SkeletonRows count={3} />
        ) : sessionsQ.isError ? (
          <ErrorState
            title="Sessions could not be loaded"
            error={sessionsQ.error}
            onRetry={() => void sessionsQ.refetch()}
          />
        ) : sessions.length === 0 ? (
          <InlineAlert tone="notice" title={`No sessions for ${doctor?.fullName ?? 'this doctor'} in the next 7 days`}>
            Choose another doctor, or ask an admin to add sessions.
          </InlineAlert>
        ) : (
          <Field label="Day">
            {(f) => (
              <Select
                value={date}
                onValueChange={(v) => {
                  setDate(v);
                  setSessionId('');
                }}
              >
                <SelectTrigger {...f} className="h-10 w-full">
                  <SelectValue placeholder="Choose a day" />
                </SelectTrigger>
                <SelectContent>
                  {days.map((d) => {
                    const day = sessions.filter((s) => s.sessionDate === d);
                    const open = day.filter((s) => bookability(s).ok);
                    return (
                      <SelectItem key={d} value={d} disabled={open.length === 0}>
                        {d === days[0] || d === days[1] ? `${dayWord(d)} (${formatLocalDate(d)})` : dayWord(d)}
                        {day.length === 0 ? ' (no sessions)' : open.length === 0 ? ' (full)' : ''}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            )}
          </Field>
        )
      ) : null}

      {date !== '' && onDay.length > 0 ? (
        <SessionChoiceList
          sessions={onDay}
          value={sessionId}
          onValueChange={setSessionId}
          onEnter={() => bookRef.current?.focus()}
        />
      ) : null}

      {session ? <SlotSummary session={session} /> : null}
      {error ? <InlineAlert title={error.title}>{error.message}</InlineAlert> : null}

      <div className="flex flex-wrap gap-2">
        <Button ref={bookRef} size="lg" disabled={!session || book.isPending} onClick={confirm}>
          {book.isPending ? 'Booking…' : 'Book appointment'}
        </Button>
        <Button size="lg" variant="outline" disabled={book.isPending} onClick={onBack}>
          Back to appointments
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Reschedule
// ---------------------------------------------------------------------------------------------------------------------

export function ReschedulePanel({
  appointment,
  onBack,
  onDone,
}: {
  appointment: Appointment;
  onBack: () => void;
  onDone: () => void;
}) {
  const days = useMemo(() => nextDays(DAYS), []);
  const sessionsQ = useSessionsQuery({
    department: appointment.department,
    from: days[0] as string,
    to: days[DAYS - 1] as string,
  });
  const options = useMemo(
    () =>
      (sessionsQ.data ?? [])
        .filter((s) => s.id !== appointment.sessionId && bookability(s).ok)
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    [sessionsQ.data, appointment.sessionId],
  );
  const [sessionId, setSessionId] = useState('');
  const target = options.find((s) => s.id === sessionId) ?? null;
  const confirmRef = useRef<HTMLButtonElement>(null);
  const move = useRescheduleAppointment();
  const error = move.error ? bookingErrorWords(move.error, 'rescheduled') : null;

  const confirm = () => {
    if (!target || move.isPending) return;
    move.mutate(
      { appointmentId: appointment.id, targetSessionId: target.id, expectedVersion: appointment.version },
      {
        onSuccess: (done) => {
          toast.success('Rescheduled', {
            description: `${done.doctorName}, ${dayWord(istDate(done.scheduledAt))}, about ${formatIST(done.scheduledAt)}`,
          });
          onDone();
        },
      },
    );
  };

  return (
    <div className="grid gap-4">
      <p className="text-muted-foreground">
        Now with {appointment.doctorName}, {dayWord(istDate(appointment.scheduledAt))},{' '}
        {formatIST(appointment.scheduledAt)}. Other {appointment.department} sessions with a place, for the next 7 days.
      </p>
      {sessionsQ.isPending ? (
        <SkeletonRows count={4} />
      ) : sessionsQ.isError ? (
        <ErrorState
          title="Sessions could not be loaded"
          error={sessionsQ.error}
          onRetry={() => void sessionsQ.refetch()}
        />
      ) : options.length === 0 ? (
        <InlineAlert tone="notice" title={`No other ${appointment.department} session has a place in the next 7 days`}>
          Cancel the appointment instead, or ask an admin to add sessions.
        </InlineAlert>
      ) : (
        <div className="max-h-80 overflow-y-auto rounded-xl">
          <ChoiceList
            label="Session"
            value={sessionId}
            onValueChange={setSessionId}
            onEnter={() => confirmRef.current?.focus()}
          >
            {options.map((s) => (
              <Choice
                key={s.id}
                value={s.id}
                title={`${dayWord(s.sessionDate)}, ${sessionLabelWord(s)}`}
                detail={`${s.doctorName}, room ${s.room}, ${sessionTimes(s)}`}
                aside={<PlacesLeft session={s} />}
              />
            ))}
          </ChoiceList>
        </div>
      )}
      {target ? <SlotSummary session={target} /> : null}
      {error ? <InlineAlert title={error.title}>{error.message}</InlineAlert> : null}
      <div className="flex flex-wrap gap-2">
        <Button ref={confirmRef} size="lg" disabled={!target || move.isPending} onClick={confirm}>
          {move.isPending ? 'Rescheduling…' : 'Reschedule'}
        </Button>
        <Button size="lg" variant="outline" disabled={move.isPending} onClick={onBack}>
          Keep appointment
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------------------------------------------------

export function CancelPanel({
  appointment,
  onBack,
  onDone,
}: {
  appointment: Appointment;
  onBack: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const cancel = useCancelForPatient();
  const error = cancel.error ? bookingErrorWords(cancel.error, 'cancelled') : null;
  return (
    <div className="grid gap-4">
      <p>
        {appointment.doctorName}, {dayWord(istDate(appointment.scheduledAt))}, {formatIST(appointment.scheduledAt)}. The
        place is released so another patient can book it.
      </p>
      <Field label="Reason (optional)">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoComplete="off" />
      </Field>
      {error ? <InlineAlert title={error.title}>{error.message}</InlineAlert> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="lg" variant="outline" disabled={cancel.isPending} onClick={onBack}>
          Keep appointment
        </Button>
        <Button
          size="lg"
          variant="destructive"
          disabled={cancel.isPending}
          onClick={() =>
            cancel.mutate(
              {
                appointmentId: appointment.id,
                expectedVersion: appointment.version,
                ...(reason.trim() ? { reason: reason.trim() } : {}),
              },
              {
                onSuccess: () => {
                  toast.success('Cancelled', {
                    description: `${appointment.doctorName}, ${dayWord(istDate(appointment.scheduledAt))}, ${formatIST(appointment.scheduledAt)}`,
                  });
                  onDone();
                },
              },
            )
          }
        >
          {cancel.isPending ? 'Cancelling…' : 'Cancel appointment'}
        </Button>
      </div>
    </div>
  );
}
