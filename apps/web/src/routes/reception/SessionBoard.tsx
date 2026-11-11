import type { ReactNode } from 'react';
import type { ArrivalResult, Doctor, Session, SessionStatus } from '@hqms/contracts';
import { CapacityBar, EmptyState, ErrorState, GroupTag, Lane, SkeletonRows, StaleBanner, TokenText } from '@/components/queue';
import { sessionLabelWord, sessionTimes } from '@/components/scheduling/sessions';
import { StatusWord } from '@/components/scheduling/status';
import type { StaffAppointment } from '@/api/schemas';
import { formatIST } from '@/lib/format';
import { cn } from '@/lib/utils';
import { shortRef } from './model';

const SESSION_WORD: Record<SessionStatus, string> = {
  scheduled: 'Not started',
  open: 'Open',
  paused: 'Paused',
  unavailable: 'Doctor unavailable',
  closed: 'Closed',
};

interface SessionBoardProps {
  doctor: Doctor | null;
  session: Session | null;
  sessionsLoading: boolean;
  sessionsError: unknown;
  onRetrySessions: () => void;
  appointments: StaffAppointment[] | undefined;
  appointmentsLoading: boolean;
  appointmentsError: unknown;
  /** A refetch failed but older data is on screen. */
  stale: boolean;
  lastUpdated: number | null;
  onRetry: () => void;
  /** Tokens issued at this desk, by appointment id (the Appointment contract carries no token). */
  tokens: Record<string, ArrivalResult>;
}

/**
 * Session board. W1 shows capacity and today's appointments by status. W2 adds the live queue lanes
 * (waiting A and W, called, in service) in the empty region below, fed by the SSE snapshot.
 */
export function SessionBoard(p: SessionBoardProps) {
  if (p.sessionsLoading) return <SkeletonRows count={6} />;
  if (p.sessionsError) return <ErrorState title="Today's sessions could not be loaded" error={p.sessionsError} onRetry={p.onRetrySessions} />;
  if (!p.doctor) {
    return <EmptyState title="No doctor selected">Choose one of your doctors to see their session.</EmptyState>;
  }
  if (!p.session) {
    return (
      <EmptyState title={`No session today for ${p.doctor.fullName}`}>
        Sessions are set up by an admin. Check another doctor, or ask an admin to add today's session.
      </EmptyState>
    );
  }
  const s = p.session;
  const appts = p.appointments ?? [];
  const expected = appts.filter((a) => a.status === 'booked');
  const checkedIn = appts.filter((a) => a.status === 'checked_in' || a.status === 'completed');
  const missed = appts.filter((a) => a.status === 'missed' || a.status === 'cancelled' || a.status === 'rescheduled');
  const byTime = (a: StaffAppointment, b: StaffAppointment) => a.scheduledAt.localeCompare(b.scheduledAt);

  return (
    <section aria-label="Session board" className="flex min-w-0 flex-col gap-4">
      <div className="rounded-xl border border-rule bg-surface p-4">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-1">
          <div className="min-w-0">
            <h2 className="text-lg font-bold">{s.doctorName}</h2>
            <p className="text-muted-foreground">
              {s.department}, room {s.room}
            </p>
          </div>
          <div className="ml-auto text-right">
            <p className="font-bold tabular-nums">
              {sessionLabelWord(s)}, {sessionTimes(s)}
            </p>
            <p>
              <span className={cn('font-bold', s.status === 'open' ? 'text-done' : s.status === 'paused' || s.status === 'unavailable' ? 'text-priority' : 'text-ink')}>
                {SESSION_WORD[s.status]}
              </span>
            </p>
          </div>
        </div>
        <CapacityBar
          className="mt-4"
          booked={s.capacity.bookedReserved}
          bookedCapacity={s.capacity.bookedCapacity}
          walkin={s.capacity.walkinUsed}
          walkinCapacity={s.capacity.walkinCapacity}
        />
        <StaleBanner className="mt-3" status={p.stale ? 'reconnecting' : 'live'} lastUpdated={p.lastUpdated} />
      </div>

      {p.appointmentsLoading ? <SkeletonRows count={5} /> : null}
      {p.appointmentsError && !p.appointments ? <ErrorState title="Appointments could not be loaded" error={p.appointmentsError} onRetry={p.onRetry} /> : null}

      {p.appointments ? (
        <div className="flex flex-col gap-4">
          <Lane
            title="Expected"
            count={expected.length}
            empty="No one is waiting to arrive. Booked patients show here until they check in."
          >
            {[...expected].sort(byTime).map((a) => (
              <AppointmentRow key={a.id} a={a} tag />
            ))}
          </Lane>
          <Lane title="Checked in" count={checkedIn.length} empty="No one has checked in yet.">
            {[...checkedIn].sort(byTime).map((a) => (
              <AppointmentRow key={a.id} a={a} tag token={p.tokens[a.id]} />
            ))}
          </Lane>
          <Lane title="Missed or cancelled" count={missed.length} empty="No missed or cancelled appointments.">
            {[...missed].sort(byTime).map((a) => (
              <AppointmentRow key={a.id} a={a} muted />
            ))}
          </Lane>
        </div>
      ) : null}
    </section>
  );
}

function AppointmentRow({ a, tag, muted, token }: { a: StaffAppointment; tag?: boolean; muted?: boolean; token?: ArrivalResult | undefined }): ReactNode {
  return (
    <li className={cn('flex min-h-10 items-center gap-3 border-l-[3px] px-3 text-sm', muted ? 'border-l-rule text-muted-foreground' : 'border-l-appt')}>
      {tag ? <GroupTag group="A" className="min-w-6 justify-center" /> : null}
      <span className="w-[4.25rem] shrink-0 font-bold tabular-nums">{formatIST(a.scheduledAt)}</span>
      <span className="min-w-0 flex-1 truncate font-bold">{a.patientName ?? shortRef(a.patientId)}</span>
      {a.patientMrn ? <span className="hidden shrink-0 text-xs text-muted-foreground tabular-nums sm:inline">{a.patientMrn}</span> : null}
      {token ? <TokenText token={token.token} size="md" className="shrink-0" /> : null}
      <StatusWord status={a.status} className="w-24 shrink-0 text-right" />
    </li>
  );
}
