import type { AffectedAppointment, AffectedQueueEntry, AlternativeSession } from '@hqms/contracts';
import { getPolicyById, listDoctors, listSessionRecords, type Queryable, type Tx } from '@hqms/db';
import { one } from '../common/rows.js';
import { nextAssignableSlot } from '../scheduling/shared.js';
import type { SlotRule } from '../scheduling/shared.js';

/** SQL for the affected-patients feature (B3, D-033). Services own authorization, transactions, audit and outbox. */

const addDays = (date: string, n: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface AlternativeQuery {
  /** The affected doctor: never offered as an alternative. */
  sourceDoctorId: string;
  department: string;
  now: Date;
  /** Hospital-local calendar date of `now` (YYYY-MM-DD). */
  today: string;
  /** Minutes the late-grace rule needs: the arrival window of D-035. */
  minArrivalWindowMin: number;
  /** Skip sessions where this patient already holds an active appointment. */
  excludePatientId?: string | null;
  /** Doctors the caller may see (reception: their assignments); null or absent = every doctor. */
  scopeDoctorIds?: readonly string[] | null;
  limit?: number;
}

/** Candidate sessions examined before the per-session slot query: the earliest few are all a list of 6 can ever need. */
export const ALTERNATIVE_CANDIDATE_CAP = 20;

/**
 * Sessions of OTHER doctors in the same department that are scheduled or open, not ended, in the next 7 days
 * (today first), with at least one assignable booked slot (D-035). Earliest first. A plain read: nothing is locked,
 * so what is listed may be gone by the time the patient clicks (the reschedule then answers 409 and changes nothing).
 */
export async function findAlternatives(db: Queryable, q: AlternativeQuery): Promise<AlternativeSession[]> {
  const records = await listSessionRecords(db, { from: q.today, to: addDays(q.today, 7), department: q.department });
  const activeDoctors = new Set((await listDoctors(db, { activeOnly: true })).map((d) => d.id));
  const inScope = q.scopeDoctorIds == null ? null : new Set(q.scopeDoctorIds);
  const candidates = records
    .filter(
      ({ session: s }) =>
        s.doctorId !== q.sourceDoctorId &&
        activeDoctors.has(s.doctorId) &&
        (inScope === null || inScope.has(s.doctorId)) &&
        (s.status === 'scheduled' || s.status === 'open') &&
        new Date(s.endsAt).getTime() > q.now.getTime() &&
        s.capacity.bookedAvailable > 0,
    )
    .sort(
      (a, b) =>
        new Date(a.session.startsAt).getTime() - new Date(b.session.startsAt).getTime() ||
        a.session.id.localeCompare(b.session.id),
    )
    // cap BEFORE the per-session slot queries: a busy week must not turn one read into dozens of queries
    .slice(0, ALTERNATIVE_CANDIDATE_CAP);
  let heldByPatient = new Set<string>();
  if (q.excludePatientId && candidates.length > 0) {
    const res = await db.query<{ session_id: string }>(
      `SELECT session_id FROM appointments
        WHERE patient_id = $1 AND status IN ('booked','checked_in') AND session_id = ANY($2::uuid[])`,
      [q.excludePatientId, candidates.map((c) => c.session.id)],
    );
    heldByPatient = new Set(res.rows.map((r) => r.session_id));
  }
  const rules = new Map<string, SlotRule>();
  const out: AlternativeSession[] = [];
  for (const { session: s, policyId } of candidates) {
    if (out.length >= (q.limit ?? 6)) break;
    if (heldByPatient.has(s.id)) continue;
    let rule = rules.get(policyId);
    if (!rule) {
      const policy = await getPolicyById(db, policyId);
      if (!policy) continue;
      rule = { lateGraceMin: policy.lateGraceMin, minArrivalWindowMin: q.minArrivalWindowMin };
      rules.set(policyId, rule);
    }
    const nextSlotAt = await nextAssignableSlot(db, s, q.now, rule);
    if (nextSlotAt === null) continue;
    out.push({
      sessionId: s.id,
      doctorId: s.doctorId,
      doctorName: s.doctorName,
      department: s.department,
      room: s.room,
      sessionDate: s.sessionDate,
      label: s.label,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      status: s.status,
      nextSlotAt,
      bookedAvailable: s.capacity.bookedAvailable,
      walkinAvailable: s.capacity.walkinAvailable,
    });
  }
  return out;
}

export interface SessionAlternativeQuery {
  sourceDoctorId: string;
  department: string;
  now: Date;
  /** Hospital-local calendar date of `now` (YYYY-MM-DD). */
  today: string;
  minArrivalWindowMin: number;
  /** Doctors the caller may see (reception: their assignments); null = every doctor (admin). */
  scopeDoctorIds: readonly string[] | null;
  limit: number;
}

/**
 * PR-23: sessions that can take a patient who cannot be seen by `sourceDoctorId` right now (walk-in places full, or the
 * doctor unavailable). Today's sessions only, not yet ended, of OTHER active doctors of the same department inside the
 * caller's scope, status scheduled/open/paused (an away doctor is expected back). A session qualifies with a free
 * walk-in place, or with a free booked place that a booking could still be given a slot for (D-035). Most free walk-in
 * places first, then earliest start. A plain read, like findAlternatives.
 */
export async function findSessionAlternatives(db: Queryable, q: SessionAlternativeQuery): Promise<AlternativeSession[]> {
  const records = await listSessionRecords(db, { from: q.today, to: q.today, department: q.department });
  const activeDoctors = new Set((await listDoctors(db, { activeOnly: true })).map((d) => d.id));
  const inScope = q.scopeDoctorIds === null ? null : new Set(q.scopeDoctorIds);
  const candidates = records.filter(
    ({ session: s }) =>
      s.doctorId !== q.sourceDoctorId &&
      activeDoctors.has(s.doctorId) &&
      (inScope === null || inScope.has(s.doctorId)) &&
      (s.status === 'scheduled' || s.status === 'open' || s.status === 'paused') &&
      new Date(s.endsAt).getTime() > q.now.getTime() &&
      (s.capacity.walkinAvailable > 0 || s.capacity.bookedAvailable > 0),
  );
  candidates.sort(
    (a, b) =>
      b.session.capacity.walkinAvailable - a.session.capacity.walkinAvailable ||
      new Date(a.session.startsAt).getTime() - new Date(b.session.startsAt).getTime() ||
      a.session.id.localeCompare(b.session.id),
  );
  const rules = new Map<string, SlotRule>();
  const out: AlternativeSession[] = [];
  for (const { session: s, policyId } of candidates.slice(0, ALTERNATIVE_CANDIDATE_CAP)) {
    let rule = rules.get(policyId);
    if (!rule) {
      const policy = await getPolicyById(db, policyId);
      if (!policy) continue;
      rule = { lateGraceMin: policy.lateGraceMin, minArrivalWindowMin: q.minArrivalWindowMin };
      rules.set(policyId, rule);
    }
    const nextSlotAt = s.capacity.bookedAvailable > 0 ? await nextAssignableSlot(db, s, q.now, rule) : null;
    if (s.capacity.walkinAvailable === 0 && nextSlotAt === null) continue;
    out.push({
      sessionId: s.id,
      doctorId: s.doctorId,
      doctorName: s.doctorName,
      department: s.department,
      room: s.room,
      sessionDate: s.sessionDate,
      label: s.label,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      status: s.status,
      nextSlotAt,
      bookedAvailable: nextSlotAt === null ? 0 : s.capacity.bookedAvailable,
      walkinAvailable: s.capacity.walkinAvailable,
    });
  }
  out.sort(
    (a, b) =>
      b.walkinAvailable - a.walkinAvailable ||
      new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime() ||
      a.sessionId.localeCompare(b.sessionId),
  );
  return out.slice(0, q.limit);
}

/** Booked appointments of the session whose patients have not arrived. */
export async function readNotArrived(db: Queryable, sessionId: string): Promise<AffectedAppointment[]> {
  const res = await db.query(
    `SELECT a.id, a.patient_id, p.full_name, p.mrn, p.phone, a.scheduled_at, a.status, a.version,
            EXISTS (SELECT 1 FROM users u WHERE u.patient_id = p.id AND u.active) AS has_login
       FROM appointments a JOIN patients p ON p.id = a.patient_id
      WHERE a.session_id = $1 AND a.status = 'booked'
      ORDER BY a.scheduled_at, a.id`,
    [sessionId],
  );
  return res.rows.map((r) => ({
    appointmentId: r.id,
    patientId: r.patient_id,
    patientName: r.full_name,
    patientMrn: r.mrn,
    patientPhone: r.phone,
    scheduledAt: new Date(r.scheduled_at).toISOString(),
    status: r.status,
    version: r.version,
    hasLogin: r.has_login,
  }));
}

/** Checked-in patients still in the building: waiting, skipped or absent, visit still open. */
export async function readInQueue(db: Queryable, sessionId: string): Promise<AffectedQueueEntry[]> {
  const res = await db.query(
    `SELECT qe.id, qe.visit_id, v.patient_id, p.full_name, p.mrn, qe.token, qe.queue_group, qe.state,
            qe.checked_in_at, qe.version
       FROM queue_entries qe
       JOIN visits v ON v.id = qe.visit_id
       JOIN patients p ON p.id = v.patient_id
      WHERE qe.session_id = $1 AND qe.state IN ('waiting','skipped','absent') AND v.status = 'open'
      ORDER BY qe.seq`,
    [sessionId],
  );
  return res.rows.map((r) => ({
    queueEntryId: r.id,
    visitId: r.visit_id,
    patientId: r.patient_id,
    patientName: r.full_name,
    patientMrn: r.mrn,
    token: r.token,
    group: r.queue_group,
    state: r.state,
    checkedInAt: new Date(r.checked_in_at).toISOString(),
    version: r.version,
  }));
}

/** The visit that continues a transferred patient's attendance in the target session (kind `transfer`). */
export async function insertTransferVisit(
  tx: Tx,
  v: {
    patientId: string;
    sessionId: string;
    doctorId: string;
    allocationId: string;
    checkedInAt: string;
    checkedInBy: string;
    fromVisitId: string;
  },
): Promise<{ id: string; version: number }> {
  const res = await tx.query<{ id: string; version: number }>(
    `INSERT INTO visits (patient_id, session_id, doctor_id, appointment_id, allocation_id, kind, checked_in_at,
                         checked_in_by, transferred_from_visit_id)
     VALUES ($1, $2, $3, NULL, $4, 'transfer', $5, $6, $7)
     RETURNING id, version`,
    [v.patientId, v.sessionId, v.doctorId, v.allocationId, v.checkedInAt, v.checkedInBy, v.fromVisitId],
  );
  return one(res.rows, 'INSERT visits (transfer)');
}

/**
 * Carry the parts of the old entry that are not inserted with it: a parked state (absent/skipped stays parked),
 * `skipped_at`, and an assigned clinical priority (moving to another doctor must not silently drop it).
 */
export async function carryEntryState(tx: Tx, newEntryId: string, oldEntryId: string): Promise<void> {
  await tx.query(
    `UPDATE queue_entries n
        SET state = o.state, skipped_at = o.skipped_at, priority_class = o.priority_class,
            priority_reason = o.priority_reason, priority_set_by = o.priority_set_by, priority_set_at = o.priority_set_at
       FROM queue_entries o
      WHERE n.id = $1 AND o.id = $2 AND (o.state <> 'waiting' OR o.priority_class IS NOT NULL)`,
    [newEntryId, oldEntryId],
  );
}

/** Old entry ends as cancelled and its visit as transferred (the domain machines checked the transitions). */
export async function retireTransferredEntry(
  tx: Tx,
  entryId: string,
  visitId: string,
): Promise<{ entryVersion: number }> {
  const e = await tx.query<{ version: number }>(
    `UPDATE queue_entries SET state = 'cancelled', version = version + 1, updated_at = now() WHERE id = $1 RETURNING version`,
    [entryId],
  );
  await tx.query(`UPDATE visits SET status = 'transferred', version = version + 1, updated_at = now() WHERE id = $1`, [
    visitId,
  ]);
  return { entryVersion: one(e.rows, 'UPDATE queue_entries').version };
}
