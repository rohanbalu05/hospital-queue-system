import type { FollowUpTask } from '@hqms/contracts';
import type { Queryable, Tx } from '@hqms/db';
import { notFound } from '../common/errors.js';

/** SQL for follow-up tasks (FR-11). The service owns authorization, transitions, audit and outbox. */

const TASK_COLS = `
  t.id, t.patient_id, p.full_name AS patient_name, t.source_visit_id, t.source_message_id, t.kind, t.title, t.detail,
  t.owner_id, ou.display_name AS owner_name, t.status, t.due_at, t.acknowledged_at, t.disposition, t.outcome_note,
  t.resolved_at, t.return_appointment_id, t.version, t.created_at`;
const TASK_FROM = `FROM follow_up_tasks t JOIN patients p ON p.id = t.patient_id LEFT JOIN users ou ON ou.id = t.owner_id`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg row
function mapTask(r: any, now: Date): FollowUpTask {
  const open = r.status === 'open' || r.status === 'acknowledged';
  return {
    id: r.id,
    patientId: r.patient_id,
    patientName: r.patient_name,
    sourceVisitId: r.source_visit_id,
    sourceMessageId: r.source_message_id,
    kind: r.kind,
    title: r.title,
    detail: r.detail,
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    status: r.status,
    dueAt: r.due_at,
    // Derived, never stored: an unresolved task past its due time stays open and visible (FR-11).
    overdue: open && new Date(r.due_at).getTime() < now.getTime(),
    acknowledgedAt: r.acknowledged_at,
    disposition: r.disposition,
    outcomeNote: r.outcome_note,
    resolvedAt: r.resolved_at,
    returnAppointmentId: r.return_appointment_id,
    version: r.version,
    createdAt: r.created_at,
  };
}

export async function readTask(db: Queryable, id: string, now: Date): Promise<FollowUpTask | null> {
  const res = await db.query(`SELECT ${TASK_COLS} ${TASK_FROM} WHERE t.id = $1`, [id]);
  return res.rows[0] ? mapTask(res.rows[0], now) : null;
}

/**
 * Lock the task row (FOR NO KEY UPDATE) and return it. Task rows sit below the doctor -> session -> capacity
 * guards in the lock order: a writer that needs both takes the guards first and the task last.
 */
export async function lockTask(tx: Tx, id: string, now: Date): Promise<FollowUpTask> {
  const res = await tx.query(`SELECT ${TASK_COLS} ${TASK_FROM} WHERE t.id = $1 FOR NO KEY UPDATE OF t`, [id]);
  if (!res.rows[0]) throw notFound('Follow-up task');
  return mapTask(res.rows[0], now);
}

export interface TaskListFilter {
  /** Doctors whose patients are visible; `null` = every patient (admin). */
  scopeDoctors: string[] | null;
  owner: 'me' | 'unassigned' | 'all';
  userId: string;
  status?: string | undefined;
  overdue?: boolean | undefined;
  patientId?: string | undefined;
}

export async function listTasks(db: Queryable, now: Date, f: TaskListFilter): Promise<FollowUpTask[]> {
  const res = await db.query(
    `SELECT ${TASK_COLS} ${TASK_FROM}
      WHERE ($1::uuid[] IS NULL
             OR EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = t.patient_id AND a.doctor_id = ANY($1::uuid[]))
             OR EXISTS (SELECT 1 FROM visits v WHERE v.patient_id = t.patient_id AND v.doctor_id = ANY($1::uuid[])))
        AND ($2 = 'all' OR ($2 = 'me' AND t.owner_id = $3) OR ($2 = 'unassigned' AND t.owner_id IS NULL))
        AND ($4::text IS NULL OR t.status = $4)
        AND ($5::uuid IS NULL OR t.patient_id = $5)
        AND ($6::boolean IS NULL
             OR $6 = (t.status IN ('open','acknowledged') AND t.due_at < $7::timestamptz))
      ORDER BY (t.status IN ('open','acknowledged')) DESC, t.due_at, t.id`,
    [f.scopeDoctors, f.owner, f.userId, f.status ?? null, f.patientId ?? null, f.overdue ?? null, now],
  );
  return res.rows.map((r) => mapTask(r, now));
}

/** A patient's own tasks (the patient-safe projection is built by the service). */
export async function listTasksOfPatient(db: Queryable, patientId: string, now: Date): Promise<FollowUpTask[]> {
  const res = await db.query(`SELECT ${TASK_COLS} ${TASK_FROM} WHERE t.patient_id = $1 ORDER BY t.created_at DESC, t.id`, [
    patientId,
  ]);
  return res.rows.map((r) => mapTask(r, now));
}
