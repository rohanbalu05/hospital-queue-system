import type { ReactNode } from 'react';
import type { ArrivalResult, Doctor, Session, SessionStatus } from '@hqms/contracts';
import { CapacityBar, EmptyState, ErrorState, GroupTag, Lane, PressureNote, SkeletonRows, StaleBanner, TokenText } from '@/components/queue';
import { Skeleton } from '@/components/ui/skeleton';
import { useQueueSnapshot } from '@/live/useQueue';
import { sessionLabelWord, sessionTimes } from '@/components/scheduling/sessions';
import { StatusWord } from '@/components/scheduling/status';
import type { StaffAppointment } from '@/api/schemas';
import { formatIST } from '@/lib/format';
import { cn } from '@/lib/utils';
import { SessionBoardLive } from '@/live';
import { AvailabilityPanel } from './AvailabilityPanel';
import { useNow } from '@/lib/useNow';
import { lateWords, minutesLate, shortRef } from './model';
import type { QueueEntry } from '@hqms/contracts';

const SESSION_WORD: Record<SessionStatus, string> = {
  scheduled: 'Not started',
  open: 'Open',
  paused: 'Doctor away',
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
  /** Live queue board selection: the reception action panel acts on this entry. */
  selectedEntryId?: string | null;
  onSelectEntry?: (entry: QueueEntry) => void;
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
            <BoardStatus session={s} />
          </div>
        </div>
        <BoardCapacity session={s} />
        <BoardPressure sessionId={s.id} />
        <AvailabilityPanel session={s} />
        {/* The live board below carries the "Last updated" line; this one speaks up only when the arrivals list went stale. */}
        {p.stale ? <StaleBanner className="mt-3" status="reconnecting" lastUpdated={p.lastUpdated} /> : null}
      </div>

      <SessionBoardLive
        sessionId={s.id}
        hideCapacity
        selectedEntryId={p.selectedEntryId ?? null}
        {...(p.onSelectEntry ? { onSelectEntry: p.onSelectEntry } : {})}
      />

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
              <AppointmentRow key={a.id} a={a} tag late />
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

/** The session chip follows the live snapshot, so "Doctor away" and "Doctor unavailable" appear without a reload (PR-24). */
function BoardStatus({ session }: { session: Session }) {
  const { data } = useQueueSnapshot(session.id);
  const status = data?.view === 'staff' ? data.status : session.status;
  return (
    <p>
      <span data-testid="board-status" className={cn('font-bold', status === 'paused' || status === 'unavailable' ? 'text-ink' : 'text-muted-foreground')}>
        {SESSION_WORD[status]}
      </span>
    </p>
  );
}

/**
 * The capacity bar holds its place as a skeleton until the live board has its first snapshot, so the header and the lanes
 * appear together instead of the bar showing counts while the board below is still loading. The figures are the
 * session's own capacity, which the check-in and walk-in commands keep fresh.
 */
function BoardCapacity({ session }: { session: Session }) {
  const { isPending } = useQueueSnapshot(session.id);
  if (isPending) {
    return (
      <div className="mt-4 grid gap-3 sm:grid-cols-[2fr_1fr]" aria-busy="true" aria-label="Loading capacity" data-testid="capacity-skeleton">
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
      </div>
    );
  }
  const c = session.capacity;
  return (
    <CapacityBar
      className="mt-4"
      booked={c.bookedReserved}
      bookedCapacity={c.bookedCapacity}
      walkin={c.walkinUsed}
      walkinCapacity={c.walkinCapacity}
    />
  );
}

/** Workload pressure from the same snapshot the live board below reads (one cached query, no second connection). */
function BoardPressure({ sessionId }: { sessionId: string }) {
  const { data } = useQueueSnapshot(sessionId);
  if (!data || data.view !== 'staff') return null;
  return <PressureNote pressure={data.pressure} className="mt-3" />;
}

/** PR-26: a booked patient whose slot has passed is marked "Late 5 min", then "Late 20 min, past grace". Words, not colour. */
function LateMark({ scheduledAt }: { scheduledAt: string }) {
  const now = useNow(30_000);
  const mins = minutesLate(scheduledAt, now);
  if (mins === null) return null;
  return (
    <span data-testid="late-mark" className="shrink-0 rounded-xs border border-rule bg-paper px-1.5 py-0.5 text-xs font-bold tabular-nums">
      {lateWords(mins)}
    </span>
  );
}

function AppointmentRow({
  a,
  tag,
  muted,
  token,
  late,
}: {
  a: StaffAppointment;
  tag?: boolean;
  muted?: boolean;
  token?: ArrivalResult | undefined;
  late?: boolean;
}): ReactNode {
  return (
    <li className={cn('flex min-h-10 items-center gap-3 border-l-[3px] px-3 text-sm', muted ? 'border-l-rule text-muted-foreground' : 'border-l-appt')}>
      {tag ? <GroupTag group="A" className="min-w-6 justify-center" /> : null}
      <span className="w-[4.25rem] shrink-0 font-bold tabular-nums">{formatIST(a.scheduledAt)}</span>
      <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5 py-1">
        <span className="w-full truncate font-bold">{a.patientName ?? shortRef(a.patientId)}</span>
        {late ? <LateMark scheduledAt={a.scheduledAt} /> : null}
      </span>
      {a.patientMrn ? <span className="hidden shrink-0 text-xs text-muted-foreground tabular-nums sm:inline">{a.patientMrn}</span> : null}
      {token ? <TokenText token={token.token} size="md" className="shrink-0" /> : null}
      <StatusWord status={a.status} transferredTo={a.transferredTo} showToken className={cn('shrink-0 text-right', a.transferredTo ? 'w-40' : 'w-24')} />
    </li>
  );
}
