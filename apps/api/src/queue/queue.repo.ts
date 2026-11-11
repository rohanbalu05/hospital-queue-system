import type { DecisionReason, QueueDecision, QueueEntry, QueueGroup, QueueEntryState } from '@hqms/contracts';
import { getPolicyById, type Queryable, type Tx } from '@hqms/db';
import type { Candidate, Policy, PriorityClass } from '@hqms/domain';
import { notFound } from '../common/errors.js';
import { one } from '../common/rows.js';
import { toDomainPolicy } from '../scheduling/shared.js';

/** SQL for the queue module: entries, decisions and the shared session read model. */

/** An entry with the visit and patient columns the queue commands need. */
export interface EntryRow {
  id: string;
  visitId: string;
  sessionId: string;
  doctorId: string;
  patientId: string;
  patientName: string;
  token: string;
  group: QueueGroup;
  seq: number;
  state: QueueEntryState;
  scheduledAt: string | null;
  checkedInAt: string;
  eligibleAt: string;
  priorityClass: number | null;
  priorityReason: string | null;
  calledAt: string | null;
  callCount: number;
  version: number;
  visitStatus: string;
  visitVersion: number;
  visitKind: string;
  appointmentId: string | null;
  startedAt: string | null;
}

const ENTRY_COLS = `
  qe.id, qe.visit_id, qe.session_id, qe.doctor_id, v.patient_id, p.full_name AS patient_name, qe.token,
  qe.queue_group, qe.seq, qe.state, qe.scheduled_at, qe.checked_in_at, qe.eligible_at, qe.priority_class,
  qe.priority_reason, qe.called_at, qe.call_count, qe.version, v.status AS visit_status,
  v.version AS visit_version, v.kind AS visit_kind, v.appointment_id, v.started_at`;
const ENTRY_FROM = `FROM queue_entries qe JOIN visits v ON v.id = qe.visit_id JOIN patients p ON p.id = v.patient_id`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg row
const mapEntry = (r: any): EntryRow => ({
  id: r.id,
  visitId: r.visit_id,
  sessionId: r.session_id,
  doctorId: r.doctor_id,
  patientId: r.patient_id,
  patientName: r.patient_name,
  token: r.token,
  group: r.queue_group,
  seq: r.seq,
  state: r.state,
  scheduledAt: r.scheduled_at,
  checkedInAt: r.checked_in_at,
  eligibleAt: r.eligible_at,
  priorityClass: r.priority_class,
  priorityReason: r.priority_reason,
  calledAt: r.called_at,
  callCount: r.call_count,
  version: r.version,
  visitStatus: r.visit_status,
  visitVersion: r.visit_version,
  visitKind: r.visit_kind,
  appointmentId: r.appointment_id,
  startedAt: r.started_at,
});

/** Plain read of one entry by queue entry id (or by visit id). */
export async function readEntry(db: Queryable, id: string, by: 'entry' | 'visit' = 'entry'): Promise<EntryRow | null> {
  const col = by === 'entry' ? 'qe.id' : 'qe.visit_id';
  const res = await db.query(`SELECT ${ENTRY_COLS} ${ENTRY_FROM} WHERE ${col} = $1`, [id]);
  return res.rows[0] ? mapEntry(res.rows[0]) : null;
}

/**
 * Lock the entry row and its visit (FOR NO KEY UPDATE) and return it. Always called AFTER the doctor and
 * session locks, so the lock order doctor -> session -> entry rows holds in every writer (worker included).
 */
export async function lockEntry(tx: Tx, id: string, by: 'entry' | 'visit' = 'entry'): Promise<EntryRow> {
  const col = by === 'entry' ? 'qe.id' : 'qe.visit_id';
  const res = await tx.query(`SELECT ${ENTRY_COLS} ${ENTRY_FROM} WHERE ${col} = $1 FOR NO KEY UPDATE OF qe, v`, [id]);
  if (!res.rows[0]) throw notFound('Queue entry');
  return mapEntry(res.rows[0]);
}

/** All waiting entries of a session, oldest sequence first. */
export async function readWaiting(db: Queryable, sessionId: string): Promise<EntryRow[]> {
  const res = await db.query(
    `SELECT ${ENTRY_COLS} ${ENTRY_FROM} WHERE qe.session_id = $1 AND qe.state = 'waiting' ORDER BY qe.seq`,
    [sessionId],
  );
  return res.rows.map(mapEntry);
}

/** The doctor's current called / in-service entry in ANY session (overlapping sessions share one doctor). */
export async function readActiveForDoctor(db: Queryable, doctorId: string): Promise<EntryRow | null> {
  const res = await db.query(
    `SELECT ${ENTRY_COLS} ${ENTRY_FROM} WHERE qe.doctor_id = $1 AND qe.state IN ('called','in_service')`,
    [doctorId],
  );
  return res.rows[0] ? mapEntry(res.rows[0]) : null;
}

/** Entries of a session in the given states, in sequence order. */
export async function readEntriesInStates(
  db: Queryable,
  sessionId: string,
  states: QueueEntryState[],
): Promise<EntryRow[]> {
  const res = await db.query(
    `SELECT ${ENTRY_COLS} ${ENTRY_FROM} WHERE qe.session_id = $1 AND qe.state = ANY($2::text[]) ORDER BY qe.seq`,
    [sessionId, states],
  );
  return res.rows.map(mapEntry);
}

export function toCandidate(e: EntryRow): Candidate {
  return {
    id: e.id,
    group: e.group,
    seq: e.seq,
    state: e.state,
    scheduledAt: e.scheduledAt === null ? null : new Date(e.scheduledAt),
    checkedInAt: new Date(e.checkedInAt),
    eligibleAt: new Date(e.eligibleAt),
    priorityClass: (e.priorityClass as PriorityClass | null) ?? null,
  };
}

/** Staff projection of an entry. */
export function toQueueEntry(
  e: EntryRow,
  extra: { now?: Date; projectedPosition?: number | null } = {},
): QueueEntry {
  const waiting = e.state === 'waiting';
  return {
    id: e.id,
    visitId: e.visitId,
    sessionId: e.sessionId,
    doctorId: e.doctorId,
    patientId: e.patientId,
    patientName: e.patientName,
    token: e.token,
    group: e.group,
    seq: e.seq,
    state: e.state,
    scheduledAt: e.scheduledAt,
    checkedInAt: e.checkedInAt,
    eligibleAt: e.eligibleAt,
    priorityClass: e.priorityClass,
    priorityReason: e.priorityReason,
    calledAt: e.calledAt,
    startedAt: e.startedAt,
    callCount: e.callCount,
    waitingMinutes:
      waiting && extra.now
        ? Math.max(0, Math.floor((extra.now.getTime() - new Date(e.eligibleAt).getTime()) / 60_000))
        : null,
    projectedPosition: waiting ? (extra.projectedPosition ?? null) : null,
    version: e.version,
  };
}

/** The session columns call-next, the snapshots and the display all need, joined with doctor and policy. */
export interface SessionState {
  id: string;
  doctorId: string;
  doctorName: string;
  department: string;
  room: string;
  sessionDate: string;
  status: 'scheduled' | 'open' | 'paused' | 'unavailable' | 'closed';
  pauseUntil: string | null;
  rotationPointer: number;
  queueVersion: number;
  policy: Policy;
  capacity: { bookedCapacity: number; walkinCapacity: number; bookedReserved: number; walkinUsed: number };
}

export async function readSessionState(db: Queryable, sessionId: string): Promise<SessionState | null> {
  const res = await db.query(
    `SELECT s.id, s.doctor_id, d.full_name, d.department, d.room, s.session_date, s.status, s.pause_until,
            s.rotation_pointer, s.queue_version, s.policy_id,
            c.booked_capacity, c.walkin_capacity, c.booked_reserved, c.walkin_used
       FROM sessions s
       JOIN doctors d ON d.id = s.doctor_id
       JOIN session_capacity c ON c.session_id = s.id
      WHERE s.id = $1`,
    [sessionId],
  );
  const r = res.rows[0];
  if (!r) return null;
  const policyRow = await getPolicyById(db, r.policy_id);
  if (!policyRow) throw notFound('Policy');
  return {
    id: r.id,
    doctorId: r.doctor_id,
    doctorName: r.full_name,
    department: r.department,
    room: r.room,
    sessionDate: r.session_date,
    status: r.status,
    pauseUntil: r.pause_until,
    rotationPointer: r.rotation_pointer,
    queueVersion: r.queue_version,
    policy: toDomainPolicy(policyRow),
    capacity: {
      bookedCapacity: r.booked_capacity,
      walkinCapacity: r.walkin_capacity,
      bookedReserved: r.booked_reserved,
      walkinUsed: r.walkin_used,
    },
  };
}

/** Doctor and session ids of a queue entry / visit, unlocked (guards are taken from them). */
export async function readGuards(
  db: Queryable,
  id: string,
  by: 'entry' | 'visit',
): Promise<{ doctorId: string; sessionId: string } | null> {
  const sql =
    by === 'entry'
      ? `SELECT doctor_id, session_id FROM queue_entries WHERE id = $1`
      : `SELECT doctor_id, session_id FROM queue_entries WHERE visit_id = $1`;
  const res = await db.query(sql, [id]);
  const r = res.rows[0];
  return r ? { doctorId: r.doctor_id, sessionId: r.session_id } : null;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export interface DecisionInsert {
  sessionId: string;
  doctorId: string;
  queueEntryId: string | null;
  reason: DecisionReason;
  rotationSlot: number | null;
  pointerBefore: number;
  pointerAfter: number;
  policyVersion: number;
  queueVersion: number;
  explanation: string;
  candidates: unknown[];
  decidedAt: Date;
  decidedBy: string;
}

export async function insertDecision(tx: Tx, d: DecisionInsert): Promise<string> {
  const res = await tx.query<{ id: string }>(
    `INSERT INTO queue_decisions (session_id, doctor_id, queue_entry_id, reason, rotation_slot, pointer_before,
                                  pointer_after, policy_version, queue_version, explanation, candidates, decided_at, decided_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
     RETURNING id`,
    [
      d.sessionId,
      d.doctorId,
      d.queueEntryId,
      d.reason,
      d.rotationSlot,
      d.pointerBefore,
      d.pointerAfter,
      d.policyVersion,
      d.queueVersion,
      d.explanation,
      JSON.stringify(d.candidates),
      d.decidedAt,
      d.decidedBy,
    ],
  );
  return one(res.rows, 'INSERT queue_decisions').id;
}

const DECISION_SELECT = `
  SELECT qd.id, qd.session_id, qd.doctor_id, qd.queue_entry_id, qe.token, qd.reason, qd.rotation_slot,
         qd.pointer_before, qd.pointer_after, qd.policy_version, qd.queue_version, qd.explanation,
         qd.decided_at, qd.decided_by
    FROM queue_decisions qd LEFT JOIN queue_entries qe ON qe.id = qd.queue_entry_id`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg row
const mapDecision = (r: any): QueueDecision => ({
  id: r.id,
  sessionId: r.session_id,
  doctorId: r.doctor_id,
  queueEntryId: r.queue_entry_id,
  token: r.token,
  reason: r.reason,
  rotationSlot: r.rotation_slot,
  pointerBefore: r.pointer_before,
  pointerAfter: r.pointer_after,
  policyVersion: r.policy_version,
  queueVersion: r.queue_version,
  explanation: r.explanation,
  decidedAt: r.decided_at,
  decidedBy: r.decided_by,
});

export async function readDecision(db: Queryable, id: string): Promise<QueueDecision> {
  const res = await db.query(`${DECISION_SELECT} WHERE qd.id = $1`, [id]);
  return mapDecision(one(res.rows, 'SELECT queue_decisions'));
}

export async function readLastDecision(db: Queryable, sessionId: string): Promise<QueueDecision | null> {
  const res = await db.query(`${DECISION_SELECT} WHERE qd.session_id = $1 ORDER BY qd.decided_at DESC, qd.id DESC LIMIT 1`, [
    sessionId,
  ]);
  return res.rows[0] ? mapDecision(res.rows[0]) : null;
}

export async function readDecisions(db: Queryable, sessionId: string, limit: number): Promise<QueueDecision[]> {
  const res = await db.query(`${DECISION_SELECT} WHERE qd.session_id = $1 ORDER BY qd.decided_at DESC, qd.id DESC LIMIT $2`, [
    sessionId,
    limit,
  ]);
  return res.rows.map(mapDecision);
}

/** Bump queue_version and set the rotation pointer in one statement (session lock held). */
export async function setPointerAndBump(tx: Tx, sessionId: string, pointer: number): Promise<number> {
  tx.assertHolds('session', sessionId, 'setPointerAndBump');
  const res = await tx.query<{ queue_version: number }>(
    `UPDATE sessions SET rotation_pointer = $2, queue_version = queue_version + 1, updated_at = now()
      WHERE id = $1 RETURNING queue_version`,
    [sessionId, pointer],
  );
  return one(res.rows, 'UPDATE sessions').queue_version;
}

/** The pending call_timeout job of an entry's current call is moot once it starts or is skipped. */
export async function cancelCallTimeoutJob(tx: Tx, entryId: string, callCount: number): Promise<void> {
  await tx.query(
    `UPDATE jobs SET state = 'cancelled', finished_at = now(), updated_at = now()
      WHERE dedupe_key = $1 AND state = 'pending'`,
    [`call_timeout:${entryId}:${callCount}`],
  );
}
