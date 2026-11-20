import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import type { Appointment, AlternativeSession } from '@hqms/contracts';
import { useAppointmentAlternatives, useRescheduleAppointment } from '@/api';
import { ErrorState, SkeletonRows } from '@/components/queue';
import { CancelDialog } from '@/components/scheduling/CancelDialog';
import { sessionLabelWord, sessionTimes } from '@/components/scheduling/sessions';
import { InlineAlert } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { ApiRequestError } from '@/lib/api';
import { HOSPITAL_FRONT_DESK_PHONE } from '@/lib/config';
import { formatLocalDate, istDate } from '@/lib/dates';
import { formatIST } from '@/lib/format';

/** The label on the one primary button of an option: "Book 11:20 am with Dr. Farah Siddiqui". */
export function bookLabel(option: Pick<AlternativeSession, 'nextSlotAt' | 'doctorName'>): string {
  return option.nextSlotAt ? `Book ${formatIST(option.nextSlotAt)} with ${option.doctorName}` : `No free slot with ${option.doctorName}`;
}

function dayWord(date: string): string {
  return date === istDate() ? `Today, ${formatLocalDate(date)}` : formatLocalDate(date);
}

function Option({
  option,
  busy,
  pendingHere,
  onBook,
}: {
  option: AlternativeSession;
  busy: boolean;
  pendingHere: boolean;
  onBook: (o: AlternativeSession) => void;
}) {
  return (
    <li data-testid="rebook-option" className="border-b border-rule px-4 py-4 last:border-b-0">
      <p className="text-lg font-bold">{option.doctorName}</p>
      <p className="text-muted-foreground">
        {option.department}, Room {option.room.replace(/^Room\s+/i, '')}
      </p>
      <p className="mt-1">
        {dayWord(option.sessionDate)}, {sessionLabelWord(option)} session, {sessionTimes(option)}
      </p>
      <p className="tabular-nums">
        {option.nextSlotAt ? (
          <>
            Next slot <span className="font-bold">{formatIST(option.nextSlotAt)}</span>
          </>
        ) : (
          'No slot free'
        )}
        , <span className="font-bold">{option.bookedAvailable}</span> {option.bookedAvailable === 1 ? 'place' : 'places'} left
      </p>
      <Button size="lg" className="mt-3 w-full sm:w-auto" disabled={busy || option.nextSlotAt === null} onClick={() => onBook(option)}>
        {pendingHere ? 'Booking…' : bookLabel(option)}
      </Button>
    </li>
  );
}

/**
 * /patient/visits?rebook=:appointmentId: the doctor is not available, so offer up to six other doctors in the same department.
 * One click books (reschedule reserves the new slot first, so a full slot leaves the original appointment alone); cancel stays one step away.
 */
export function RebookPanel({ appointmentId, appointment, onClose }: { appointmentId: string; appointment: Appointment | undefined; onClose: () => void }) {
  const live = appointment?.status === 'booked' ? appointment : undefined;
  const alt = useAppointmentAlternatives(live ? appointmentId : null);
  const move = useRescheduleAppointment();
  const [booked, setBooked] = useState<Appointment | null>(null);
  const [cancelling, setCancelling] = useState<Appointment | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
    heading.current?.scrollIntoView?.({ block: 'start' });
  }, []);

  const err = move.error instanceof ApiRequestError ? move.error : null;
  const taken = err !== null && (err.code === 'CAPACITY_FULL' || err.code === 'CONFLICT' || err.status === 409);

  const book = (o: AlternativeSession) => {
    if (!live || move.isPending) return;
    move.mutate(
      { appointmentId: live.id, targetSessionId: o.sessionId, expectedVersion: live.version },
      {
        onSuccess: (next) => {
          setBooked(next);
          toast.success('Booked', { description: `${formatIST(next.scheduledAt, 'date-time')} with ${next.doctorName}` });
        },
      },
    );
  };

  const intro = (children: ReactNode) => (
    <div className="border-b border-rule px-4 py-4">
      <h2 id="rebook-h" ref={heading} tabIndex={-1} className="text-xl font-bold">
        Rebook with another doctor
      </h2>
      {children}
    </div>
  );
  const frame = 'mb-6 overflow-hidden rounded-xl border border-l-[6px] border-rule border-l-ink bg-surface';

  if (booked) {
    return (
      <section aria-labelledby="rebooked-h" data-testid="rebook-done" className="mb-6 rounded-xl border border-l-[6px] border-rule border-l-done bg-surface px-4 py-4">
        <h2 id="rebooked-h" ref={heading} tabIndex={-1} className="text-xl font-bold">
          Booked
        </h2>
        <p role="status" className="mt-1 text-lg">
          <span className="font-bold tabular-nums">
            {formatLocalDate(istDate(booked.scheduledAt))}, {formatIST(booked.scheduledAt)}
          </span>{' '}
          with {booked.doctorName}, {booked.department}.
        </p>
        <p className="mt-1 text-muted-foreground">Arrive 10 minutes early and check in at reception. Your earlier appointment has been released.</p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <Button size="lg" onClick={onClose}>
            See my visits
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link to="/patient">Back to Today</Link>
          </Button>
        </div>
      </section>
    );
  }

  if (cancelled) {
    return (
      <section aria-labelledby="rebook-h" className="mb-6 rounded-xl border border-l-[6px] border-rule border-l-ink bg-surface px-4 py-4">
        <h2 id="rebook-h" ref={heading} tabIndex={-1} className="text-xl font-bold">
          Appointment cancelled
        </h2>
        <p role="status" className="mt-1">Your place has been released. You can book another appointment at any time.</p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <Button asChild size="lg">
            <Link to="/patient/book">Book appointment</Link>
          </Button>
          <Button variant="outline" size="lg" onClick={onClose}>
            Close
          </Button>
        </div>
      </section>
    );
  }

  if (!live) {
    return (
      <section aria-labelledby="rebook-h" data-testid="rebook-panel" className={frame}>
        {intro(
          <>
            <p className="mt-1">
              {appointment ? 'This appointment can no longer be rebooked here.' : 'We could not find this appointment among your visits.'}
            </p>
            <p className="mt-1 text-muted-foreground">It may already be moved, cancelled or completed. Your visits list shows where it stands.</p>
            <Button variant="outline" size="lg" className="mt-3" onClick={onClose}>
              Close
            </Button>
          </>,
        )}
      </section>
    );
  }

  const source = alt.data?.sourceAvailability;
  const options = alt.data?.alternatives ?? [];
  return (
    <section aria-labelledby="rebook-h" data-testid="rebook-panel" className={frame}>
      {intro(
        <>
          <p className="mt-1">
            {source?.state === 'unavailable'
              ? `${live.doctorName} is not available for the rest of this session.`
              : source?.state === 'away'
                ? `${live.doctorName} has stepped away.`
                : `Your appointment is with ${live.doctorName}.`}{' '}
            Choose another doctor in {live.department}. Your appointment stays until the new one is confirmed.
          </p>
          <p className="mt-1 text-muted-foreground tabular-nums">
            Now: {formatLocalDate(istDate(live.scheduledAt))}, {formatIST(live.scheduledAt)} with {live.doctorName}
          </p>
        </>,
      )}
      {err ? (
        <div className="border-b border-rule p-4">
          <InlineAlert title={taken ? 'That slot was just taken' : 'The appointment was not moved'}>
            {taken ? 'The list has been refreshed with what is free now. Your original appointment is unchanged.' : `${err.message} Your original appointment is unchanged.`}
          </InlineAlert>
        </div>
      ) : null}
      {alt.isPending ? (
        <div className="p-4">
          <SkeletonRows count={3} />
        </div>
      ) : alt.isError ? (
        <div className="p-4">
          <ErrorState title="Other doctors could not be loaded" error={alt.error} onRetry={() => void alt.refetch()} />
        </div>
      ) : options.length === 0 ? (
        <div className="p-4" data-testid="rebook-empty">
          <p className="text-lg font-bold">No other doctor has a free slot in the next 7 days</p>
          <p className="mt-1 text-muted-foreground">
            Keep your appointment, cancel it, or call the hospital front desk on <span className="font-bold tabular-nums">{HOSPITAL_FRONT_DESK_PHONE}</span> and they will find a time with you.
          </p>
        </div>
      ) : (
        <ul aria-label="Other doctors" data-testid="rebook-options">
          {options.slice(0, 6).map((o) => (
            <Option key={o.sessionId} option={o} busy={move.isPending} pendingHere={move.isPending && move.variables?.targetSessionId === o.sessionId} onBook={book} />
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-3 border-t border-rule bg-paper px-4 py-3 sm:flex-row">
        <Button variant="outline" size="lg" disabled={move.isPending} onClick={() => setCancelling(live)}>
          Cancel appointment
        </Button>
        <Button variant="outline" size="lg" disabled={move.isPending} onClick={onClose}>
          Keep my appointment
        </Button>
      </div>
      <CancelDialog appointment={cancelling} onClose={() => setCancelling(null)} onCancelled={() => setCancelled(true)} />
    </section>
  );
}
