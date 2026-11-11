import type { ArrivalResult, QueueGroup, VisitKind } from '@hqms/contracts';
import type { Queryable, Tx } from '@hqms/db';
import { one } from '../common/rows.js';

/** SQL for visits and queue entries (report Table 13 constraints do the final duplicate protection). */

export interface VisitRow {
  id: string;
  version: number;
}

export async function insertVisit(
  tx: Tx,
  v: {
    patientId: string;
    sessionId: string;
    doctorId: string;
    appointmentId: string | null;
    allocationId: string;
    kind: VisitKind;
    checkedInAt: Date;
    checkedInBy: string;
  },
): Promise<VisitRow> {
  const res = await tx.query<{ id: string; version: number }>(
    `INSERT INTO visits (patient_id, session_id, doctor_id, appointment_id, allocation_id, kind, checked_in_at, checked_in_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, version`,
    [v.patientId, v.sessionId, v.doctorId, v.appointmentId, v.allocationId, v.kind, v.checkedInAt, v.checkedInBy],
  );
  return one(res.rows, 'INSERT visits');
}

/**
 * Take the next token number of `group` and the next stable sequence of the session, and bump the queue
 * version, in one statement. Requires the session lock. Returns the token ("A-001"), seq and new version.
 */
export async function takeQueuePosition(
  tx: Tx,
  sessionId: string,
  group: QueueGroup,
): Promise<{ token: string; seq: number; queueVersion: number }> {
  const counter = group === 'A' ? 'next_seq_a' : 'next_seq_w';
  const upd = await tx.query<{ n: number; queue_version: number }>(
    `UPDATE sessions
        SET ${counter} = ${counter} + 1, queue_version = queue_version + 1, updated_at = now()
      WHERE id = $1
      RETURNING ${counter} - 1 AS n, queue_version`,
    [sessionId],
  );
  const row = one(upd.rows, 'UPDATE sessions');
  const seqRes = await tx.query<{ seq: number }>(
    `SELECT COALESCE(max(seq), 0) + 1 AS seq FROM queue_entries WHERE session_id = $1`,
    [sessionId],
  );
  return {
    token: `${group}-${String(row.n).padStart(3, '0')}`,
    seq: one(seqRes.rows, 'SELECT max(seq)').seq,
    queueVersion: row.queue_version,
  };
}

export async function insertQueueEntry(
  tx: Tx,
  e: {
    visitId: string;
    sessionId: string;
    doctorId: string;
    group: QueueGroup;
    token: string;
    seq: number;
    scheduledAt: string | null;
    checkedInAt: Date;
    eligibleAt: Date;
  },
): Promise<string> {
  const res = await tx.query<{ id: string }>(
    `INSERT INTO queue_entries (visit_id, session_id, doctor_id, queue_group, token, seq, scheduled_at, checked_in_at, eligible_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [e.visitId, e.sessionId, e.doctorId, e.group, e.token, e.seq, e.scheduledAt, e.checkedInAt, e.eligibleAt],
  );
  return one(res.rows, 'INSERT queue_entries').id;
}

/** The arrival already recorded for an appointment (unique non-null visits.appointment_id), if any. */
export async function findArrivalByAppointment(
  db: Queryable,
  appointmentId: string,
  queueVersion: number,
): Promise<ArrivalResult | null> {
  const res = await db.query(
    `SELECT v.id AS visit_id, v.kind, qe.id AS queue_entry_id, qe.token, qe.queue_group, qe.eligible_at
       FROM visits v JOIN queue_entries qe ON qe.visit_id = v.id
      WHERE v.appointment_id = $1`,
    [appointmentId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    visitId: r.visit_id,
    queueEntryId: r.queue_entry_id,
    token: r.token,
    group: r.queue_group,
    kind: r.kind,
    eligibleAt: r.eligible_at,
    queueVersion,
  };
}

/** Does this patient already hold a live place (waiting, called or in service) in the session? */
export async function hasActiveEntry(db: Queryable, sessionId: string, patientId: string): Promise<boolean> {
  const res = await db.query(
    `SELECT 1 FROM queue_entries qe JOIN visits v ON v.id = qe.visit_id
      WHERE qe.session_id = $1 AND v.patient_id = $2 AND qe.state IN ('waiting','called','in_service')
      LIMIT 1`,
    [sessionId, patientId],
  );
  return (res.rowCount ?? 0) > 0;
}
