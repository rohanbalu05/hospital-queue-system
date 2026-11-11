import type { Appointment, AppointmentStatus } from '@hqms/contracts';
import { ConflictError, NotFoundError } from '../errors.js';
import { firstRow, maybeOne, many, required, type Queryable, type QueryResultRow } from '../pool.js';
import type { Tx } from '../tx.js';

const SELECT_APPT = `
  SELECT a.id, a.patient_id, a.session_id, a.doctor_id, d.full_name AS doctor_name, d.department,
         a.scheduled_at, a.status, a.rescheduled_from_id, a.follow_up_task_id, a.version, a.created_at,
         a.allocation_id
    FROM appointments a JOIN doctors d ON d.id = a.doctor_id`;

/** Contract shape plus the allocation id (needed by check-in/cancel/reschedule, not exposed to clients). */
export type AppointmentRecord = Appointment & { allocationId: string };

const mapAppt = (r: QueryResultRow): AppointmentRecord => ({
  id: r.id,
  patientId: r.patient_id,
  sessionId: r.session_id,
  doctorId: r.doctor_id,
  doctorName: r.doctor_name,
  department: r.department,
  scheduledAt: r.scheduled_at,
  status: r.status,
  rescheduledFromId: r.rescheduled_from_id,
  followUpTaskId: r.follow_up_task_id,
  version: r.version,
  createdAt: r.created_at,
  allocationId: r.allocation_id,
});

export async function getAppointment(db: Queryable, id: string): Promise<AppointmentRecord | null> {
  const r = await maybeOne(db, `${SELECT_APPT} WHERE a.id = $1`, [id]);
  return r ? mapAppt(r) : null;
}

export async function listAppointmentsByPatient(
  db: Queryable,
  patientId: string,
  opts: { statuses?: AppointmentStatus[]; from?: string | Date } = {},
): Promise<AppointmentRecord[]> {
  const rows = await many(
    db,
    `${SELECT_APPT}
      WHERE a.patient_id = $1
        AND ($2::text[] IS NULL OR a.status = ANY($2))
        AND ($3::timestamptz IS NULL OR a.scheduled_at >= $3)
      ORDER BY a.scheduled_at, a.id`,
    [patientId, opts.statuses ?? null, opts.from ?? null],
  );
  return rows.map(mapAppt);
}

export async function listAppointmentsBySession(
  db: Queryable,
  sessionId: string,
  opts: { statuses?: AppointmentStatus[] } = {},
): Promise<AppointmentRecord[]> {
  const rows = await many(
    db,
    `${SELECT_APPT}
      WHERE a.session_id = $1 AND ($2::text[] IS NULL OR a.status = ANY($2))
      ORDER BY a.scheduled_at, a.id`,
    [sessionId, opts.statuses ?? null],
  );
  return rows.map(mapAppt);
}

export interface InsertAppointmentInput {
  id?: string;
  patientId: string;
  sessionId: string;
  doctorId: string;
  scheduledAt: string | Date;
  allocationId: string;
  bookedBy: string;
  rescheduledFromId?: string | null;
  followUpTaskId?: string | null;
}

/** Insert a booked appointment bound to an already reserved allocation. */
export async function insertAppointment(tx: Tx, a: InsertAppointmentInput): Promise<AppointmentRecord> {
  const res = await tx.query<{ id: string }>(
    `INSERT INTO appointments (id, patient_id, session_id, doctor_id, scheduled_at, allocation_id, booked_by,
                               rescheduled_from_id, follow_up_task_id)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      a.id ?? null,
      a.patientId,
      a.sessionId,
      a.doctorId,
      a.scheduledAt,
      a.allocationId,
      a.bookedBy,
      a.rescheduledFromId ?? null,
      a.followUpTaskId ?? null,
    ],
  );
  return required(await getAppointment(tx, firstRow(res, 'appointment').id), 'appointment');
}

/**
 * Move an appointment to a new status, bumping its version. `expectedVersion` gives optimistic
 * concurrency (mismatch -> ConflictError CONFLICT). Transition legality is the domain state machine's job.
 */
export async function setAppointmentStatus(
  tx: Tx,
  id: string,
  status: AppointmentStatus,
  opts: { expectedVersion?: number; cancelReason?: string | null } = {},
): Promise<AppointmentRecord> {
  const res = await tx.query(
    `UPDATE appointments
        SET status = $2, cancel_reason = COALESCE($3, cancel_reason), version = version + 1, updated_at = now()
      WHERE id = $1 AND ($4::int IS NULL OR version = $4)
      RETURNING id`,
    [id, status, opts.cancelReason ?? null, opts.expectedVersion ?? null],
  );
  if (res.rowCount === 0) {
    const cur = await getAppointment(tx, id);
    if (!cur) throw new NotFoundError('appointment', id);
    throw new ConflictError('CONFLICT', 'Appointment was changed by someone else', {
      expectedVersion: opts.expectedVersion,
      currentVersion: cur.version,
    });
  }
  return required(await getAppointment(tx, id), 'appointment');
}
