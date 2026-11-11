import type { Appointment, QueuePolicy } from '@hqms/contracts';
import type { AppointmentRecord, SessionLockRow, Tx } from '@hqms/db';
import type { Policy } from '@hqms/domain';
import { conflict } from '../common/errors.js';
import { slotTimes } from './slots.js';

/** Strip the internal allocation id before an appointment goes to a client. */
export function toAppointment(rec: AppointmentRecord): Appointment {
  const { allocationId: _allocationId, ...appointment } = rec;
  return appointment;
}

/** Contract policy row -> the pure domain Policy. */
export function toDomainPolicy(p: QueuePolicy): Policy {
  return {
    version: p.version,
    rotation: p.rotation,
    earlyEligibilityMin: p.earlyEligibilityMin,
    lateGraceMin: p.lateGraceMin,
    agingTriggerMin: p.agingTriggerMin,
    calledTimeoutSec: p.calledTimeoutSec,
    ewmaAlpha: p.ewmaAlpha,
    initialEstimateMin: p.initialEstimateMin,
    defaultBookedCapacity: p.defaultBookedCapacity,
    defaultWalkinCapacity: p.defaultWalkinCapacity,
  };
}

/** A session accepts new bookings while it is scheduled or open and has not ended. */
export function assertBookable(session: SessionLockRow, now: Date): void {
  if (session.status !== 'scheduled' && session.status !== 'open') {
    throw conflict('CONFLICT', 'This session is not open for booking', { status: session.status });
  }
  if (new Date(session.endsAt).getTime() <= now.getTime()) {
    throw conflict('CONFLICT', 'This session has already ended', { endsAt: session.endsAt });
  }
}

/** First slot of the session not held by an active appointment. Call with the session lock held. */
export async function firstFreeSlot(tx: Tx, session: SessionLockRow): Promise<string> {
  const res = await tx.query<{ scheduled_at: string }>(
    `SELECT scheduled_at FROM appointments WHERE session_id = $1 AND status IN ('booked','checked_in','completed')`,
    [session.id],
  );
  const taken = new Set(res.rows.map((r) => new Date(r.scheduled_at).getTime()));
  const free = slotTimes(session).find((at) => !taken.has(new Date(at).getTime()));
  if (!free)
    throw conflict('CAPACITY_FULL', 'No free appointment slot is left in this session', { sessionId: session.id });
  return free;
}

/** The timer that would mark a no-show as missed is no longer needed once the booking is settled. */
export async function cancelReservationReleaseJob(tx: Tx, appointmentId: string): Promise<void> {
  await tx.query(
    `UPDATE jobs SET state = 'cancelled', finished_at = now(), updated_at = now()
      WHERE dedupe_key = $1 AND state = 'pending'`,
    [`reservation_release:${appointmentId}`],
  );
}
