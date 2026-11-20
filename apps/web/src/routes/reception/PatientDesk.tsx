import { useEffect, useMemo, useRef, useState } from 'react';
import type { Appointment, Id } from '@hqms/contracts';
import { useAppointmentsQuery } from '@/api';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/queue';
import { StatusWord } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { istDate } from '@/lib/dates';
import { formatIST } from '@/lib/format';
import { BookPanel, CancelPanel, ReschedulePanel, dayWord } from './DeskBooking';

/** The person the desk is working with. Taken from the arrival row, so it needs no extra request. */
export interface DeskPatient {
  id: Id;
  name: string;
  mrn: string | null;
  phone: string | null;
}

type Mode = { kind: 'list' } | { kind: 'book' } | { kind: 'cancel'; appointment: Appointment } | { kind: 'reschedule'; appointment: Appointment };

const HEADINGS: Record<Mode['kind'], string> = {
  list: 'Upcoming appointments',
  book: 'Book an appointment',
  cancel: 'Cancel this appointment?',
  reschedule: 'Reschedule appointment',
};

/** Booked or checked-in appointments from today on, soonest first. */
export function upcoming(appointments: Appointment[], today: string = istDate()): Appointment[] {
  return appointments
    .filter((a) => (a.status === 'booked' || a.status === 'checked_in') && istDate(a.scheduledAt) >= today)
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

/**
 * Patient desk (PR-21): one patient's upcoming appointments with Cancel and Reschedule, and Book appointment.
 * It works for patients registered at the desk, who have no login and so could never book for themselves.
 * Everything is keyboard-operable: the panel heading takes focus each time the view changes.
 */
export function PatientDesk({ patient, onClose }: { patient: DeskPatient | null; onClose: () => void }) {
  // Keep the last patient while the sheet slides out.
  const last = useRef<DeskPatient | null>(patient);
  if (patient) last.current = patient;
  const shown = patient ?? last.current;

  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [mode.kind]);
  useEffect(() => {
    if (patient) setMode({ kind: 'list' });
  }, [patient?.id]);

  const apptQ = useAppointmentsQuery({ patientId: shown?.id }, { enabled: patient !== null });
  const list = useMemo(() => upcoming(apptQ.data ?? []), [apptQ.data]);
  const today = istDate();
  const back = () => setMode({ kind: 'list' });

  return (
    <Sheet open={patient !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-xl" data-testid="patient-desk">
        <SheetHeader className="border-b border-rule pr-12">
          <SheetTitle className="text-lg font-bold">{shown?.name ?? 'Patient'}</SheetTitle>
          <SheetDescription className="tabular-nums">
            {[shown?.mrn, shown?.phone].filter(Boolean).join('  ') || 'No MRN or phone on file'}
          </SheetDescription>
        </SheetHeader>

        {shown ? (
          <div className="grid gap-4 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <h3 ref={headingRef} tabIndex={-1} className="text-lg font-bold outline-none">
                {HEADINGS[mode.kind]}
              </h3>
              {mode.kind === 'list' ? (
                <Button size="lg" className="ml-auto" onClick={() => setMode({ kind: 'book' })}>
                  Book appointment
                </Button>
              ) : null}
            </div>

            {mode.kind === 'list' ? (
              apptQ.isPending ? (
                <SkeletonRows count={3} />
              ) : apptQ.isError && !apptQ.data ? (
                <ErrorState title="Appointments could not be loaded" error={apptQ.error} onRetry={() => void apptQ.refetch()} />
              ) : list.length === 0 ? (
                <EmptyState title="No upcoming appointments">
                  {shown.name} has nothing booked from today on. Use Book appointment to give them a place.
                </EmptyState>
              ) : (
                <ul aria-label="Upcoming appointments" className="divide-y divide-rule overflow-hidden rounded-xl border border-rule bg-surface">
                  {list.map((a) => {
                    const date = istDate(a.scheduledAt);
                    const when = `${dayWord(date, today)}, ${formatIST(a.scheduledAt)}`;
                    return (
                      <li
                        key={a.id}
                        aria-label={`${a.doctorName}, ${when}`}
                        className="flex flex-wrap items-center gap-x-3 gap-y-2 border-l-[3px] border-l-appt px-3 py-2.5"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="font-bold tabular-nums">{when}</p>
                          <p className="text-muted-foreground">
                            {a.doctorName}, {a.department}
                          </p>
                        </div>
                        <StatusWord status={a.status} />
                        {a.status === 'booked' ? (
                          <div className="flex w-full gap-2 sm:w-auto">
                            <Button variant="outline" aria-label={`Reschedule appointment with ${a.doctorName}, ${when}`} onClick={() => setMode({ kind: 'reschedule', appointment: a })}>
                              Reschedule
                            </Button>
                            <Button variant="outline" aria-label={`Cancel appointment with ${a.doctorName}, ${when}`} onClick={() => setMode({ kind: 'cancel', appointment: a })}>
                              Cancel
                            </Button>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )
            ) : null}

            {mode.kind === 'book' ? <BookPanel patient={shown} onBack={back} onDone={back} /> : null}
            {mode.kind === 'cancel' ? <CancelPanel appointment={mode.appointment} onBack={back} onDone={back} /> : null}
            {mode.kind === 'reschedule' ? <ReschedulePanel appointment={mode.appointment} onBack={back} onDone={back} /> : null}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
