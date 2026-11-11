import type { FollowUpTask } from '@hqms/contracts';
import type { Queryable, Tx } from '@hqms/db';
import { linkedToDoctorsSql } from '../access/patient-scope.service.js';
import { notFound } from '../common/errors.js';

/** SQL for follow-up tasks (FR-11). The service owns authorization, transitions, audit and outbox. */

const TASK_COLS = `
  t.id, t.patient_id, p.full_name AS patient_name, t.source_visit_id, t.source_message_id, t.kind, t.title, t.detail,
  t.owner_id, ou.display_name AS owner_name, t.status, t.due_at, t.acknowledged_at, t.disposition, t.outcome_note,
  t.resolved_at, t.return_appointment_id, t.version, t.created_at,
  ss.session_date AS sv_date, sd.id AS sv_doctor_id, sd.full_name AS sv_doctor_name, sd.department AS sv_department`;
const TASK_FROM = `FROM follow_up_tasks t JOIN patients p ON p.id = t.patient_id LEFT JOIN users ou ON ou.id = t.owner_id
  LEFT JOIN visits sv ON sv.id = t.source_visit_id LEFT JOIN sessions ss ON ss.id = sv.session_id
  LEFT JOIN doctors sd ON sd.id = sv.doctor_id`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg row
function mapTask(r: any, now: Date): FollowUpTask {
  const open = r.status === 'open' || r.status === 'acknowledged';
  return {
    id: r.id,
    patientId: r.patient_id,
    patientName: r.patient_name,
    sourceVisitId: r.source_visit_id,
    sourceMessageId: r.source_message_id,
    sourceVisit: r.sv_doctor_id
      ? { sessionDate: String(r.sv_date), doctorId: r.sv_doctor_id, doctorName: r.sv_doctor_name, department: r.sv_department }
      : null,
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

/**
 * The task list query, built per filter so each predicate is a plain column comparison: for owner=me the plan is
 * `owner_id = $n [AND status = $m] ORDER BY due_at`, which `follow_up_tasks_owner_idx (owner_id, status, due_at)`
 * serves (Table 13). The doctor scope never hides a task from its owner: an escalation for a patient with no
 * doctor link is visible to the user who owns it.
 */
export function buildTaskListQuery(now: Date, f: TaskListFilter): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const bind = (v: unknown): string => {
    values.push(v);
    return `$${values.length}`;
  };
  const where: string[] = [];
  if (f.owner === 'me') where.push(`t.owner_id = ${bind(f.userId)}`);
  else if (f.owner === 'unassigned') where.push('t.owner_id IS NULL');
  if (f.status) where.push(`t.status = ${bind(f.status)}`);
  if (f.patientId) where.push(`t.patient_id = ${bind(f.patientId)}`);
  if (f.overdue !== undefined) {
    const n = bind(now);
    where.push(
      f.overdue
        ? `(t.status IN ('open','acknowledged') AND t.due_at < ${n}::timestamptz)`
        : `NOT (t.status IN ('open','acknowledged') AND t.due_at < ${n}::timestamptz)`,
    );
  }
  // owner=me needs no scope clause: the caller owns every row, and an owned task is always visible to its owner.
  if (f.scopeDoctors !== null && f.owner !== 'me') {
    const d = bind(f.scopeDoctors);
    const n = bind(now);
    const u = bind(f.userId);
    where.push(`(${linkedToDoctorsSql('t.patient_id', d, n)} OR t.owner_id = ${u})`);
  }
  const order = f.status ? 't.due_at, t.id' : "(t.status IN ('open','acknowledged')) DESC, t.due_at, t.id";
  return {
    text: `SELECT ${TASK_COLS} ${TASK_FROM}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}`,
    values,
  };
}

export async function listTasks(db: Queryable, now: Date, f: TaskListFilter): Promise<FollowUpTask[]> {
  const q = buildTaskListQuery(now, f);
  const res = await db.query(q.text, q.values);
  return res.rows.map((r) => mapTask(r, now));
}

/**
 * Owner of a task nobody was named for (escalations, doctor-created tasks): a follow-up user assigned to one of the
 * patient's doctors, else any active follow-up user of the hospital; fewest open tasks first, then id, so the choice
 * is deterministic. `null` only when the hospital has no active follow-up user at all.
 */
export async function pickOwner(db: Queryable, patientId: string, doctorIds: string[]): Promise<string | null> {
  const load = `(SELECT count(*) FROM follow_up_tasks t WHERE t.owner_id = u.id AND t.status IN ('open','acknowledged'))`;
  const assigned = await db.query<{ id: string }>(
    `SELECT u.id FROM users u
      WHERE u.role = 'followup' AND u.active
        AND u.hospital_id = (SELECT hospital_id FROM patients WHERE id = $1)
        AND EXISTS (SELECT 1 FROM staff_assignments sa WHERE sa.user_id = u.id AND sa.doctor_id = ANY($2::uuid[]))
      ORDER BY ${load}, u.id LIMIT 1`,
    [patientId, doctorIds],
  );
  if (assigned.rows[0]) return assigned.rows[0].id;
  const any = await db.query<{ id: string }>(
    `SELECT u.id FROM users u
      WHERE u.role = 'followup' AND u.active
        AND u.hospital_id = (SELECT hospital_id FROM patients WHERE id = $1)
      ORDER BY ${load}, u.id LIMIT 1`,
    [patientId],
  );
  return any.rows[0]?.id ?? null;
}

/** A patient's own tasks (the patient-safe projection is built by the service). */
export async function listTasksOfPatient(db: Queryable, patientId: string, now: Date): Promise<FollowUpTask[]> {
  const res = await db.query(`SELECT ${TASK_COLS} ${TASK_FROM} WHERE t.patient_id = $1 ORDER BY t.created_at DESC, t.id`, [
    patientId,
  ]);
  return res.rows.map((r) => mapTask(r, now));
}
