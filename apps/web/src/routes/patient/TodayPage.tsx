import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Appointment, MyTodayVisit, QueueEntryState, SessionAvailability, VisitKind } from '@hqms/contracts';
import { useAppointmentsQuery, useMyTodayVisits } from '@/api';
import { PatientPage } from '@/components/layout/PatientPage';
import { EmptyState, ErrorState, GroupTag, SkeletonRows, TokenText } from '@/components/queue';
import { GROUPS } from '@/components/queue/group';
import { AvailabilityBanner } from '@/components/scheduling/AvailabilityBanner';
import { BookedAvailability } from '@/components/scheduling/BookedAvailability';
import { CancelDialog } from '@/components/scheduling/CancelDialog';
import { InlineAlert, StatusWord } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import { istDate } from '@/lib/dates';
import { formatIST } from '@/lib/format';
import { useQueueSnapshot } from '@/live';
import { CancelledNotice, ReturnVisitTag, isReturnVisit } from './VisitBits';

/** Today's live appointments (booked or checked in), earliest first. Dates are hospital-local (IST). */
export function todaysAppointments(list: Appointment[], today: string): Appointment[] {
  return list
    .filter((a) => (a.status === 'booked' || a.status === 'checked_in') && istDate(a.scheduledAt) === today)
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

/** Appointments completed today (IST), earliest first: the visit is over, so Today says so instead of "No visit today". */
export function completedToday(list: Appointment[], today: string): Appointment[] {
  return list.filter((a) => a.status === 'completed' && istDate(a.scheduledAt) === today).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

/**
 * Today's visits that no appointment card already shows: walk-ins, late admissions, transfers, and any appointment
 * visit whose appointment is not in the list. A visit that belongs to a listed appointment is merged into that card.
 */
export function visitsWithoutCard(visits: MyTodayVisit[], appointments: Appointment[]): MyTodayVisit[] {
  const shown = new Set(appointments.map((a) => a.id));
  return visits.filter((v) => v.appointmentId === null || !shown.has(v.appointmentId)).sort((a, b) => a.checkedInAt.localeCompare(b.checkedInAt));
}

/** "See my place in the queue": the route to the live visit page (token, position, estimate). */
export function QueueLink({ sessionId, className }: { sessionId: string; className?: string }) {
  return (
    <Button asChild size="lg" className={className}>
      <Link to={`/patient/visit/${sessionId}`}>See my place in the queue</Link>
    </Button>
  );
}

const KIND_WORDS: Record<VisitKind, string> = {
  appointment: 'Appointment',
  walkin: 'Walk-in',
  late_admission: 'Late arrival',
  transfer: 'Moved from another doctor',
};

function queueStateWords(state: QueueEntryState, room: string): string {
  switch (state) {
    case 'waiting':
      return 'In the queue';
    case 'called':
      return `Your turn: go to Room ${room}`;
    case 'in_service':
      return 'With the doctor';
    case 'skipped':
      return 'Called and not here: see the front desk';
    case 'absent':
      return 'Marked not present: see the front desk';
    case 'completed':
      return 'Visit complete';
    case 'cancelled':
      return 'Cancelled';
  }
}

/** Availability and ETA for one session: the patient snapshot when it has loaded, the value the list carried until then. */
function useSessionNotice(sessionId: string, fallback: SessionAvailability | undefined, fallbackDoctor: string, enabled = true) {
  const { data } = useQueueSnapshot(enabled ? sessionId : null);
  const snap = data?.view === 'patient' ? data : null;
  return {
    availability: snap?.availability ?? fallback,
    doctorName: snap?.doctorName ?? fallbackDoctor,
    eta: snap?.myEntry?.eta ?? null,
  };
}

function AppointmentCard({ a, visit, onCancel }: { a: Appointment; visit: MyTodayVisit | undefined; onCancel: (a: Appointment) => void }) {
  // Before check-in there is no queue entry, so there is no queue to look at yet: no link, and the session read supplies the banner.
  const booked = a.status === 'booked' && !visit;
  const notice = useSessionNotice(a.sessionId, visit?.availability, a.doctorName, !booked);
  return (
    <li data-testid="today-appointment" className="rounded-xl border border-l-[3px] border-rule border-l-appt bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-2xl font-bold tabular-nums">{formatIST(a.scheduledAt)}</p>
          <p className="font-bold">{a.doctorName}</p>
          <p className="text-muted-foreground">{a.department}</p>
          {isReturnVisit(a) ? <ReturnVisitTag className="mt-1" /> : null}
          {visit ? (
            <p className="mt-1 flex items-center gap-2">
              <TokenText token={visit.token} size="md" />
              <span>{queueStateWords(visit.queueState, visit.room)}</span>
            </p>
          ) : null}
        </div>
        <StatusWord status={a.status} className="shrink-0" />
      </div>
      {booked ? (
        <BookedAvailability appointment={a} onCancel={onCancel} className="mt-4" />
      ) : notice.availability ? (
        <AvailabilityBanner availability={notice.availability} doctorName={notice.doctorName} placement="in_queue" eta={notice.eta} className="mt-4" />
      ) : null}
      {booked ? (
        <p className="mt-4 text-muted-foreground">Check in at reception when you arrive. Your token and estimated wait appear here after you check in.</p>
      ) : (
        <>
          <QueueLink sessionId={a.sessionId} className="mt-4 w-full" />
          <p className="mt-2 text-muted-foreground">You are checked in. The next screen shows your token, your place and the estimated wait.</p>
        </>
      )}
    </li>
  );
}

/** A visit that is over today: what happened and where the next steps are. */
function CompletedCard({ a }: { a: Appointment }) {
  return (
    <li data-testid="today-completed" className="rounded-xl border border-l-[3px] border-rule border-l-done bg-surface p-4">
      <p className="text-lg font-bold">
        Visit completed at <span className="tabular-nums">{formatIST(a.scheduledAt)}</span> with {a.doctorName}
      </p>
      <p className="text-muted-foreground">{a.department}</p>
      {isReturnVisit(a) ? <ReturnVisitTag className="mt-1" /> : null}
      <p className="mt-3 text-muted-foreground">Replies from the care team and any return visit are in your follow-ups.</p>
      <Button asChild variant="outline" size="lg" className="mt-3 w-full sm:w-auto">
        <Link to="/patient/follow-ups">See your follow-ups</Link>
      </Button>
    </li>
  );
}

function VisitCard({ v }: { v: MyTodayVisit }) {
  const notice = useSessionNotice(v.sessionId, v.availability, v.doctorName);
  const group = v.token.startsWith('A') ? 'A' : 'W';
  return (
    <li data-testid="today-visit" className={`rounded-xl border border-l-[3px] border-rule bg-surface p-4 ${GROUPS[group].edge}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base text-muted-foreground">Your token</p>
          <p className="flex items-center gap-2">
            <TokenText token={v.token} size="xl" />
            <GroupTag group={group} showName />
          </p>
          <p className="mt-2 font-bold">{v.doctorName}</p>
          <p className="text-muted-foreground">
            {v.department}, Room {v.room}
          </p>
          <p className="text-muted-foreground">
            {KIND_WORDS[v.kind]}, checked in {formatIST(v.checkedInAt)}
          </p>
        </div>
      </div>
      <p className="mt-3 text-lg font-bold">{queueStateWords(v.queueState, v.room)}</p>
      {notice.availability ? (
        <AvailabilityBanner
          availability={notice.availability}
          doctorName={notice.doctorName}
          placement="in_queue"
          eta={notice.eta}
          className="mt-4"
        />
      ) : null}
      <QueueLink sessionId={v.sessionId} className="mt-4 w-full" />
    </li>
  );
}

/** The patient home: today's appointments and visits, each with a prominent link to the live queue position. */
export default function TodayPage() {
  const { me } = useAuth();
  const patientId = me?.patientId ?? undefined;
  const q = useAppointmentsQuery({ patientId }, { enabled: Boolean(patientId) });
  const vq = useMyTodayVisits({ enabled: Boolean(patientId) });
  const [cancelling, setCancelling] = useState<Appointment | null>(null);
  const [cancelled, setCancelled] = useState<Appointment | null>(null);
  const today = istDate();
  const todays = todaysAppointments(q.data ?? [], today);
  const visits = vq.data ?? [];
  const extra = visitsWithoutCard(visits, todays);
  const finished = completedToday(q.data ?? [], today);
  const visitFor = (a: Appointment) => visits.find((v) => v.appointmentId === a.id);
  const pending = Boolean(patientId) && (q.isPending || vq.isPending);
  const nothing = todays.length === 0 && extra.length === 0 && finished.length === 0;

  return (
    <PatientPage title="Today" {...(me ? { description: `Signed in as ${me.displayName}.` } : {})}>
      {cancelled ? <CancelledNotice appointment={cancelled} className="mb-4" /> : null}
      {pending && nothing ? (
        <SkeletonRows count={2} />
      ) : q.isError && nothing ? (
        <ErrorState
          title="Your appointments could not be loaded"
          error={q.error}
          onRetry={() => {
            void q.refetch();
            void vq.refetch();
          }}
        />
      ) : nothing ? (
        <>
          {vq.isError ? (
            <InlineAlert title="Walk-in visits could not be loaded" className="mb-4">
              Your appointments are shown below. Ask the front desk if you checked in without one.
            </InlineAlert>
          ) : null}
          <EmptyState
            title="No visit today"
            action={
              <Button asChild size="lg">
                <Link to="/patient/book">Book appointment</Link>
              </Button>
            }
          >
            Your token, your place in the queue and the estimated wait appear here once you check in at the hospital.
          </EmptyState>
        </>
      ) : (
        <section aria-labelledby="today-h" className="grid gap-4">
          <h2 id="today-h" className="text-lg font-bold">
            Your visits today
          </h2>
          {vq.isError ? (
            <InlineAlert title="Some visits could not be loaded">
              Appointments are shown. A walk-in visit may be missing until this refreshes.
            </InlineAlert>
          ) : null}
          <ul className="grid gap-4">
            {extra.map((v) => (
              <VisitCard key={v.visitId} v={v} />
            ))}
            {todays.map((a) => (
              <AppointmentCard key={a.id} a={a} visit={visitFor(a)} onCancel={setCancelling} />
            ))}
            {finished.map((a) => (
              <CompletedCard key={a.id} a={a} />
            ))}
          </ul>
        </section>
      )}
      <CancelDialog appointment={cancelling} onClose={() => setCancelling(null)} onCancelled={setCancelled} />
    </PatientPage>
  );
}
