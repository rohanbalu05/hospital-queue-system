import { useState } from 'react';
import type { Session, SessionAvailability } from '@hqms/contracts';
import { useAffectedPatients } from '@/api/queue';
import { AvailabilityButtons, AvailabilityStrip, useAvailabilityControls } from '@/components/queue';
import { Button } from '@/components/ui/button';
import { useQueueSnapshot } from '@/live/useQueue';
import { AffectedDialog } from './AffectedDialog';

const UNKNOWN: SessionAvailability = { state: 'available', since: null, expectedBackAt: null, overdue: false, reason: null };

/**
 * The doctor's availability for the session on the reception board (B1, B3): a live banner when the doctor is away or
 * unavailable, the Step away / I'm back / Unavailable commands for a doctor in scope, and the way into the affected-patients
 * list. The state comes from the same live snapshot as the board, so SSE keeps it current.
 */
export function AvailabilityPanel({ session }: { session: Session }) {
  const { data } = useQueueSnapshot(session.id);
  const availability = data?.view === 'staff' ? data.availability : (session.availability ?? UNKNOWN);
  const controls = useAvailabilityControls({
    sessionId: session.id,
    sessionDate: session.sessionDate,
    sessionEndsAt: session.endsAt,
    availability,
    subject: session.doctorName,
    role: 'reception',
  });
  const [affectedOpen, setAffectedOpen] = useState(false);
  const needsMove = availability.state === 'away' || availability.state === 'unavailable';
  const affected = useAffectedPatients(session.id, needsMove);
  const count = affected.data ? affected.data.notArrived.length + affected.data.inQueue.length : null;
  const urgent = availability.state === 'unavailable';

  // Nothing to show before the first snapshot, or for a session that has not started or has ended.
  if (!data && !session.availability) return null;
  if (!needsMove && !controls.canStepAway) return null;

  return (
    <div className="mt-3 grid gap-2" data-testid="availability-panel">
      {needsMove ? (
        <AvailabilityStrip availability={availability} who={session.doctorName}>
          {controls.away ? <AvailabilityButtons controls={controls} /> : null}
          <Button type="button" variant={urgent ? 'default' : 'outline'} onClick={() => setAffectedOpen(true)}>
            {count === null ? 'Affected patients' : `Affected patients (${count})`}
          </Button>
        </AvailabilityStrip>
      ) : (
        <AvailabilityButtons controls={controls} />
      )}
      {controls.dialogs}
      <AffectedDialog open={affectedOpen} onOpenChange={setAffectedOpen} sessionId={session.id} />
    </div>
  );
}
