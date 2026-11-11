import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { ChevronDown } from 'lucide-react';
import type { Appointment } from '@hqms/contracts';
import { useAppointmentsQuery, useCancelAppointment, useRescheduleAppointment, useSessionsQuery } from '@/api';
import { PatientPage } from '@/components/layout/PatientPage';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/queue';
import { SessionChoiceList } from '@/components/scheduling/sessions';
import { InlineAlert, StatusWord } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ApiRequestError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatLocalDate, istDate, nextDays } from '@/lib/dates';
import { formatIST } from '@/lib/format';

/** Booked or checked in, from today onwards (IST), is upcoming. Everything else is past or cancelled. */
export function splitAppointments(list: Appointment[], today: string) {
  const upcoming: Appointment[] = [];
  const past: Appointment[] = [];
  for (const a of list) {
    const live = a.status === 'booked' || a.status === 'checked_in';
    (live && istDate(a.scheduledAt) >= today ? upcoming : past).push(a);
  }
  upcoming.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  past.sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt));
  return { upcoming, past };
}

export default function VisitsPage() {
  const { me } = useAuth();
  const location = useLocation();
  const patientId = me?.patientId ?? undefined;
  const q = useAppointmentsQuery({ patientId }, { enabled: Boolean(patientId) });
  const today = istDate();
  const { upcoming, past } = useMemo(() => splitAppointments(q.data ?? [], today), [q.data, today]);

  const [cancelling, setCancelling] = useState<Appointment | null>(null);
  const [moving, setMoving] = useState<Appointment | null>(null);
  const [pastOpen, setPastOpen] = useState(false);

  const bookedId = (location.state as { bookedId?: string } | null)?.bookedId;
  const justBooked = bookedId ? (q.data ?? []).find((a) => a.id === bookedId) : undefined;

  return (
    <PatientPage title="My visits" description="Your appointments at the hospital. Times are Bengaluru time.">
      {justBooked ? (
        <InlineAlert tone="notice" title="Booked" className="mb-4">
          {formatLocalDate(istDate(justBooked.scheduledAt))}, {formatIST(justBooked.scheduledAt)} with {justBooked.doctorName}. Arrive 10 minutes early and check in at reception.
        </InlineAlert>
      ) : null}

      {q.isPending && patientId ? <SkeletonRows count={3} /> : null}
      {!patientId ? (
        <EmptyState title="No patient record is linked to this sign-in">Ask reception to link your record so your appointments show here.</EmptyState>
      ) : null}
      {q.isError ? <ErrorState title="Your appointments could not be loaded" error={q.error} onRetry={() => void q.refetch()} /> : null}

      {q.data ? (
        <div className="space-y-6">
          <section aria-labelledby="upcoming-h">
            <h2 id="upcoming-h" className="mb-2 text-lg font-bold">
              Upcoming
            </h2>
            {upcoming.length === 0 ? (
              <EmptyState
                title="No upcoming appointments"
                action={
                  <Button asChild size="lg">
                    <Link to="/patient/book">Book appointment</Link>
                  </Button>
                }
              >
                Book a session with a doctor and it will appear here.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-rule overflow-hidden rounded-xl border border-rule bg-surface">
                {upcoming.map((a) => (
                  <li key={a.id} className="border-l-[3px] border-l-appt px-4 py-3">
                    <AppointmentLine a={a} />
                    {a.status === 'booked' ? (
                      <div className="mt-3 flex gap-3">
                        <Button variant="outline" size="lg" className="flex-1 sm:flex-none" onClick={() => setMoving(a)}>
                          Reschedule
                        </Button>
                        <Button variant="outline" size="lg" className="flex-1 sm:flex-none" onClick={() => setCancelling(a)}>
                          Cancel
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {past.length > 0 ? (
            <Collapsible open={pastOpen} onOpenChange={setPastOpen}>
              <CollapsibleTrigger className="flex min-h-12 w-full items-center justify-between rounded-md px-1 text-left text-lg font-bold outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                <span>
                  Past and cancelled <span className="tabular-nums">({past.length})</span>
                </span>
                <ChevronDown aria-hidden="true" className={pastOpen ? 'size-5 rotate-180' : 'size-5'} />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="mt-2 divide-y divide-rule overflow-hidden rounded-xl border border-rule bg-surface">
                  {past.map((a) => (
                    <li key={a.id} className="border-l-[3px] border-l-rule px-4 py-3">
                      <AppointmentLine a={a} />
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </div>
      ) : null}

      <CancelDialog appointment={cancelling} onClose={() => setCancelling(null)} />
      <RescheduleDialog appointment={moving} onClose={() => setMoving(null)} />
    </PatientPage>
  );
}

function AppointmentLine({ a }: { a: Appointment }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="font-bold tabular-nums">
          {formatLocalDate(istDate(a.scheduledAt))}, {formatIST(a.scheduledAt)}
        </p>
        <p>{a.doctorName}</p>
        <p className="text-sm text-muted-foreground">{a.department}</p>
      </div>
      <StatusWord status={a.status} className="shrink-0" />
    </div>
  );
}

function CancelDialog({ appointment, onClose }: { appointment: Appointment | null; onClose: () => void }) {
  const cancel = useCancelAppointment();
  const err = cancel.error instanceof ApiRequestError ? cancel.error : null;
  const close = () => {
    cancel.reset();
    onClose();
  };
  return (
    <Dialog open={appointment !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>Cancel this appointment?</DialogTitle>
          <DialogDescription className="text-base">
            {appointment ? (
              <>
                {appointment.doctorName}, {formatLocalDate(istDate(appointment.scheduledAt))}, {formatIST(appointment.scheduledAt)}. Your place is released so another patient can book it.
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        {err ? <InlineAlert title="The appointment was not cancelled">{err.message}</InlineAlert> : null}
        <DialogFooter>
          <Button variant="outline" size="lg" onClick={close} disabled={cancel.isPending}>
            Keep appointment
          </Button>
          <Button
            variant="destructive"
            size="lg"
            disabled={cancel.isPending}
            onClick={() =>
              appointment &&
              cancel.mutate(
                { appointmentId: appointment.id },
                {
                  onSuccess: () => {
                    toast.success('Cancelled', { description: 'Your place has been released.' });
                    close();
                  },
                },
              )
            }
          >
            {cancel.isPending ? 'Cancelling…' : 'Cancel appointment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RescheduleDialog({ appointment, onClose }: { appointment: Appointment | null; onClose: () => void }) {
  const [target, setTarget] = useState('');
  const days = useMemo(() => nextDays(7), []);
  const sessionsQ = useSessionsQuery(
    { doctorId: appointment?.doctorId ?? '', from: days[0] as string, to: days[6] as string },
    { enabled: appointment !== null },
  );
  const options = (sessionsQ.data ?? []).filter((s) => s.id !== appointment?.sessionId);
  const move = useRescheduleAppointment();
  const err = move.error instanceof ApiRequestError ? move.error : null;

  const close = () => {
    move.reset();
    setTarget('');
    onClose();
  };
  const submit = () => {
    if (!appointment || !target || move.isPending) return;
    move.mutate(
      { appointmentId: appointment.id, targetSessionId: target },
      {
        onSuccess: (next) => {
          toast.success('Rescheduled', { description: `${formatIST(next.scheduledAt, 'date-time')} with ${next.doctorName}` });
          close();
        },
      },
    );
  };

  return (
    <Dialog open={appointment !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>Choose another session</DialogTitle>
          <DialogDescription className="text-base">
            {appointment ? `${appointment.doctorName}, now ${formatLocalDate(istDate(appointment.scheduledAt))}, ${formatIST(appointment.scheduledAt)}. Your current appointment stays until the new one is confirmed.` : null}
          </DialogDescription>
        </DialogHeader>

        {sessionsQ.isPending ? <SkeletonRows count={3} /> : null}
        {sessionsQ.isError ? <ErrorState title="Sessions could not be loaded" error={sessionsQ.error} onRetry={() => void sessionsQ.refetch()} /> : null}
        {sessionsQ.data && options.length === 0 ? (
          <InlineAlert tone="notice" title="No other sessions in the next 7 days">
            Keep your appointment, or call the front desk.
          </InlineAlert>
        ) : null}
        {options.length > 0 ? (
          <SessionChoiceList
            sessions={options}
            value={target}
            onValueChange={(v) => {
              setTarget(v);
              move.reset();
            }}
            onEnter={submit}
            showDate={(s) => formatLocalDate(s.sessionDate)}
          />
        ) : null}

        {err?.code === 'CAPACITY_FULL' ? (
          <InlineAlert title="That session is full">Your original appointment is unchanged. Choose another session.</InlineAlert>
        ) : err ? (
          <InlineAlert title="The appointment was not moved">
            <p>{err.message}</p>
            <p className="mt-1">Your original appointment is unchanged.</p>
          </InlineAlert>
        ) : null}

        <DialogFooter>
          <Button variant="outline" size="lg" onClick={close} disabled={move.isPending}>
            Keep current time
          </Button>
          <Button size="lg" onClick={submit} disabled={!target || move.isPending}>
            {move.isPending ? 'Moving…' : 'Move appointment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
