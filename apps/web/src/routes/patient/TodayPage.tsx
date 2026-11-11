import { Link } from 'react-router-dom';
import type { Appointment } from '@hqms/contracts';
import { useAppointmentsQuery } from '@/api';
import { PatientPage } from '@/components/layout/PatientPage';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/queue';
import { StatusWord } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import { istDate } from '@/lib/dates';
import { formatIST } from '@/lib/format';

/** Today's live appointments (booked or checked in), earliest first. Dates are hospital-local (IST). */
export function todaysAppointments(list: Appointment[], today: string): Appointment[] {
  return list
    .filter((a) => (a.status === 'booked' || a.status === 'checked_in') && istDate(a.scheduledAt) === today)
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

/** "See my place in the queue": the route to the live visit page (token, position, estimate). */
export function QueueLink({ sessionId, className }: { sessionId: string; className?: string }) {
  return (
    <Button asChild size="lg" className={className}>
      <Link to={`/patient/visit/${sessionId}`}>See my place in the queue</Link>
    </Button>
  );
}

/** The patient home: today's appointment(s), each with a prominent link to the live queue position. */
export default function TodayPage() {
  const { me } = useAuth();
  const patientId = me?.patientId ?? undefined;
  const q = useAppointmentsQuery({ patientId }, { enabled: Boolean(patientId) });
  const today = istDate();
  const todays = todaysAppointments(q.data ?? [], today);

  return (
    <PatientPage title="My visit" {...(me ? { description: `Signed in as ${me.displayName}.` } : {})}>
      {q.isPending && patientId ? (
        <SkeletonRows count={2} />
      ) : q.isError ? (
        <ErrorState title="Your appointments could not be loaded" error={q.error} onRetry={() => void q.refetch()} />
      ) : todays.length === 0 ? (
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
      ) : (
        <section aria-labelledby="today-h" className="grid gap-4">
          <h2 id="today-h" className="text-lg font-bold">
            Today
          </h2>
          <ul className="grid gap-4">
            {todays.map((a) => (
              <li key={a.id} data-testid="today-appointment" className="rounded-xl border border-l-[3px] border-rule border-l-appt bg-surface p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-2xl font-bold tabular-nums">{formatIST(a.scheduledAt)}</p>
                    <p className="font-bold">{a.doctorName}</p>
                    <p className="text-muted-foreground">{a.department}</p>
                  </div>
                  <StatusWord status={a.status} className="shrink-0" />
                </div>
                <QueueLink sessionId={a.sessionId} className="mt-4 w-full" />
                <p className="mt-2 text-muted-foreground">
                  {a.status === 'booked'
                    ? 'Check in at reception when you arrive. Your token and estimated wait appear on the next screen.'
                    : 'You are checked in. The next screen shows your token, your place and the estimated wait.'}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PatientPage>
  );
}
