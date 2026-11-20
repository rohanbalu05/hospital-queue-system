import { useId } from 'react';
import type { AlternativeSession, Patient, Session } from '@hqms/contracts';
import { useAppointmentsQuery } from '@/api';
import { useSessionAlternatives } from '@/api/queue';
import { sessionLabelWord, sessionTimes } from '@/components/scheduling/sessions';
import { Button } from '@/components/ui/button';
import { formatLocalDate, istDate } from '@/lib/dates';
import { formatIST } from '@/lib/format';
import { canAdmitWalkIn, type ArrivalItem } from './model';

/**
 * PR-22: registration looked like an existing patient. The desk chooses: use that patient, or create a new record anyway.
 * The panel is the 409's `details.candidates` (name, MRN, phone, date of birth) and nothing else.
 */
export function DuplicatePanel({
  candidates,
  pending,
  onUse,
  onCreateAnyway,
  onDismiss,
}: {
  candidates: Patient[];
  pending: boolean;
  onUse: (p: Patient) => void;
  onCreateAnyway: () => void;
  onDismiss: () => void;
}) {
  const headingId = useId();
  return (
    <div
      role="alert"
      aria-labelledby={headingId}
      className="mt-3 rounded-md border border-l-[3px] border-rule border-l-ink bg-surface p-3"
    >
      <p id={headingId} className="font-bold">
        This may be an existing patient
      </p>
      <p className="mt-0.5 text-muted-foreground">Check these records before creating another one.</p>
      <ul className="mt-2 divide-y divide-rule rounded-md border border-rule">
        {candidates.map((c) => (
          <li key={c.id} className="flex flex-col gap-2 px-3 py-2.5">
            <div className="min-w-0">
              <p className="font-bold">{c.fullName}</p>
              <p className="text-sm text-muted-foreground tabular-nums">{c.mrn}</p>
              <p className="text-sm text-muted-foreground tabular-nums">{c.phone ?? 'No phone on file'}</p>
              <p className="text-sm text-muted-foreground tabular-nums">
                {c.dateOfBirth ? `Born ${formatLocalDate(c.dateOfBirth, 'date')}` : 'Date of birth not on file'}
              </p>
            </div>
            <Button
              variant="outline"
              className="w-full"
              disabled={pending}
              aria-label={`Use this patient: ${c.fullName}`}
              onClick={() => onUse(c)}
            >
              Use this patient
            </Button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="outline" disabled={pending} onClick={onCreateAnyway}>
          {pending ? 'Creating…' : 'Create new record anyway'}
        </Button>
        <Button variant="ghost" disabled={pending} onClick={onDismiss}>
          Edit the details
        </Button>
      </div>
    </div>
  );
}

/**
 * PR-23: this session has no walk-in place left (or the doctor is unavailable). Other doctors in the department with a free
 * walk-in place today are listed, each with "Admit to Dr X". There is no over-capacity override (D-038): the last resort is
 * to ask an admin to raise the capacity.
 */
export function AlternativesPanel({
  session,
  item,
  pending,
  onAdmitTo,
}: {
  session: Session;
  item: ArrivalItem | null;
  pending: boolean;
  onAdmitTo: (alt: AlternativeSession) => void;
}) {
  const q = useSessionAlternatives(session.id, true);
  const free = (q.data ?? []).filter((a) => a.walkinAvailable > 0);
  const canAdmit = item !== null && canAdmitWalkIn(item);
  return (
    <div className="mt-3 border-t border-rule pt-3" data-testid="alternatives">
      <h3 className="font-bold">Other doctors in {session.department} today</h3>
      {q.isPending ? (
        <p className="mt-1 text-muted-foreground">Looking for free walk-in places…</p>
      ) : q.isError ? (
        <p role="alert" className="mt-1">
          <span className="font-bold">The other doctors could not be loaded.</span>{' '}
          <button type="button" className="font-bold underline underline-offset-2" onClick={() => void q.refetch()}>
            Try again
          </button>
        </p>
      ) : free.length === 0 ? (
        <p className="mt-1">No other doctor in {session.department} has a free walk-in place today.</p>
      ) : (
        <ul className="mt-2 divide-y divide-rule rounded-md border border-rule">
          {free.map((a) => (
            <li key={a.sessionId} className="flex flex-col gap-2 px-3 py-2.5">
              <div className="min-w-0">
                <p className="font-bold">{a.doctorName}</p>
                <p className="text-sm text-muted-foreground tabular-nums">
                  Room {a.room}, {sessionLabelWord(a)}, {sessionTimes(a)}
                </p>
                <p className="text-sm tabular-nums">{`${a.walkinAvailable} walk-in ${a.walkinAvailable === 1 ? 'place' : 'places'} left`}</p>
              </div>
              <Button variant="outline" className="w-full" disabled={!canAdmit || pending} onClick={() => onAdmitTo(a)}>
                {`Admit to ${a.doctorName}`}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!canAdmit && free.length > 0 ? (
        <p className="mt-1.5 text-sm text-muted-foreground">
          {item
            ? 'This patient has a live appointment in this session, so they are not a walk-in.'
            : 'Choose or register a patient first, then admit them to one of these doctors.'}
        </p>
      ) : null}
      <p className="mt-2 text-sm text-muted-foreground">
        No doctor can take them? Ask an admin to raise capacity for this session.
      </p>
    </div>
  );
}

/**
 * PR-25: the patient already holds a booking or a place in another doctor's queue today. Built from the patient's own
 * appointment list, so it covers bookings and check-ins, not a walk-in admitted elsewhere.
 */
export function OtherQueueNote({ item, session }: { item: ArrivalItem | null; session: Session | null }) {
  const enabled = item !== null && session !== null && canAdmitWalkIn(item);
  const q = useAppointmentsQuery({ patientId: item?.patientId }, { enabled });
  if (!enabled || !session) return null;
  const today = istDate();
  const elsewhere = (q.data ?? []).filter(
    (a) =>
      (a.status === 'booked' || a.status === 'checked_in') &&
      a.sessionId !== session.id &&
      istDate(a.scheduledAt) === today,
  );
  if (elsewhere.length === 0) return null;
  return (
    <div
      role="status"
      aria-label="Already in another queue"
      className="mt-3 rounded-md border border-l-[3px] border-rule border-l-ink bg-surface px-3 py-2"
    >
      <p className="font-bold">{item.name} already has a place with another doctor today</p>
      <ul className="mt-0.5 tabular-nums">
        {elsewhere.map((a) => (
          <li key={a.id}>
            {a.status === 'checked_in' ? 'Checked in with' : 'Booked with'} {a.doctorName} at {formatIST(a.scheduledAt)}
          </li>
        ))}
      </ul>
      <p className="mt-0.5 text-muted-foreground">Admit them here only if they also need to see this doctor.</p>
    </div>
  );
}
