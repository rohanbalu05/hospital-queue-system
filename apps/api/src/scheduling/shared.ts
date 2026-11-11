import type { Appointment, QueuePolicy } from '@hqms/contracts';
import type { AppointmentRecord, Queryable, SessionLockRow, Tx } from '@hqms/db';
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

/**
 * First slot of the session not held by an active appointment and still worth booking: a slot whose
 * late-grace window has already closed (`slot + lateGraceMin <= now`) would be marked missed at once, so
 * it is skipped (D-022). None left -> CAPACITY_FULL. Call with the session lock held.
 */
export async function firstFreeSlot(tx: Tx, session: SessionLockRow, now: Date, lateGraceMin: number): Promise<string> {
  const res = await tx.query<{ scheduled_at: string }>(
    `SELECT scheduled_at FROM appointments WHERE session_id = $1 AND status IN ('booked','checked_in','completed')`,
    [session.id],
  );
  const taken = new Set(res.rows.map((r) => new Date(r.scheduled_at).getTime()));
  const free = slotTimes(session).find(
    (at) => !taken.has(new Date(at).getTime()) && new Date(at).getTime() + lateGraceMin * 60_000 > now.getTime(),
  );
  if (!free)
    throw conflict('CAPACITY_FULL', 'No free appointment slot is left in this session', { sessionId: session.id });
  return free;
}

/** One active (booked or checked-in) appointment per patient per session; the unique index is the backstop. */
export async function assertNoActiveAppointment(tx: Tx, patientId: string, sessionId: string): Promise<void> {
  const res = await tx.query(
    `SELECT 1 FROM appointments WHERE patient_id = $1 AND session_id = $2 AND status IN ('booked','checked_in') LIMIT 1`,
    [patientId, sessionId],
  );
  if ((res.rowCount ?? 0) > 0) {
    throw conflict('CONFLICT', 'This patient already has an active appointment in this session', { sessionId });
  }
}

/** The timer that would mark a no-show as missed is no longer needed once the booking is settled. */
export async function cancelReservationReleaseJob(tx: Tx, appointmentId: string): Promise<void> {
  await tx.query(
    `UPDATE jobs SET state = 'cancelled', finished_at = now(), updated_at = now()
      WHERE dedupe_key = $1 AND state = 'pending'`,
    [`reservation_release:${appointmentId}`],
  );
}

/**
 * Read projection of appointments (GET /appointments, GET /appointments/:id): adds queueEntryId + token
 * once checked in (staff and the owning patient) and, for STAFF callers only, the patient's name, MRN
 * and phone (D-021). Two batched queries regardless of list size. Patients never receive patient fields.
 */
export async function enrichAppointments(
  db: Queryable,
  recs: AppointmentRecord[],
  includePatient: boolean,
): Promise<Appointment[]> {
  if (recs.length === 0) return [];
  const ids = recs.map((r) => r.id);
  const entries = await db.query<{ appointment_id: string; queue_entry_id: string; token: string }>(
    `SELECT v.appointment_id, qe.id AS queue_entry_id, qe.token
       FROM visits v JOIN queue_entries qe ON qe.visit_id = v.id
      WHERE v.appointment_id = ANY($1::uuid[])`,
    [ids],
  );
  const entryByAppt = new Map(entries.rows.map((r) => [r.appointment_id, r]));
  const patientById = new Map<string, { name: string; mrn: string; phone: string | null }>();
  if (includePatient) {
    const pids = [...new Set(recs.map((r) => r.patientId))];
    const ps = await db.query<{ id: string; full_name: string; mrn: string; phone: string | null }>(
      `SELECT id, full_name, mrn, phone FROM patients WHERE id = ANY($1::uuid[])`,
      [pids],
    );
    for (const p of ps.rows) patientById.set(p.id, { name: p.full_name, mrn: p.mrn, phone: p.phone });
  }
  return recs.map((rec) => {
    const base = toAppointment(rec);
    const entry = entryByAppt.get(rec.id);
    const patient = patientById.get(rec.patientId);
    return {
      ...base,
      queueEntryId: entry?.queue_entry_id ?? null,
      token: entry?.token ?? null,
      ...(patient ? { patientName: patient.name, patientMrn: patient.mrn, patientPhone: patient.phone } : {}),
    };
  });
}
