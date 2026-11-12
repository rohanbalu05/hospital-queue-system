import type { Capacity, Doctor, SessionStatus } from '@hqms/contracts';
import { NotFoundError } from './errors.js';
import { required, type QueryResultRow } from './pool.js';
import type { LockKind, Tx } from './tx.js';

/*
 * Guard rows, locked in this order only: doctor -> session -> capacity (rank 1, 2, 3).
 *
 * We use FOR NO KEY UPDATE rather than FOR UPDATE. It is exclusive against every other guard locker
 * (they all use it, and plain UPDATEs of these rows take the same mode), but it does NOT conflict with
 * the FOR KEY SHARE lock that foreign-key checks take on doctors/sessions when appointments, visits or
 * queue entries are inserted. With FOR UPDATE, a booking that already holds the capacity lock and then
 * inserts an appointment (FK -> doctors) would block behind a call-next that holds the doctor lock
 * while waiting for the session/capacity lock: a deadlock the lock order alone cannot prevent.
 */

export interface SessionLockRow {
  id: string;
  doctorId: string;
  policyId: string;
  sessionDate: string;
  label: 'morning' | 'afternoon' | 'evening';
  startsAt: string;
  endsAt: string;
  slotMinutes: number;
  status: SessionStatus;
  pausedAt: string | null;
  pauseUntil: string | null;
  pauseReason: string | null;
  rotationPointer: number;
  queueVersion: number;
  nextSeqA: number;
  nextSeqW: number;
  version: number;
}

export interface CapacityLockRow extends Capacity {
  sessionId: string;
  version: number;
}

async function lockMany<R>(
  tx: Tx,
  kind: LockKind,
  entity: string,
  ids: string[],
  sql: string,
  mapRow: (row: QueryResultRow) => R,
  rowId: (r: R) => string,
  /** Runs after the order check and before the locking SELECT (parent-lock assertions). */
  beforeLock?: (unique: string[]) => Promise<void>,
): Promise<R[]> {
  const unique = [...new Set(ids.map((i) => i.toLowerCase()))].sort();
  if (unique.length === 0) return [];
  tx.checkOrder(kind, unique);
  if (beforeLock) await beforeLock(unique);
  const res = await tx.query(sql, [unique]);
  const rows = res.rows.map(mapRow);
  const found = new Set(rows.map((r) => rowId(r).toLowerCase()));
  const missing = unique.find((i) => !found.has(i));
  if (missing) throw new NotFoundError(entity, missing);
  tx.recordLocks(kind, unique);
  return rows;
}

const mapDoctor = (r: QueryResultRow): Doctor => ({
  id: r.id,
  fullName: r.full_name,
  department: r.department,
  room: r.room,
  active: r.active,
});

/** Lock doctor rows (rank 1) in ascending id order. Returns rows in that order. */
export function lockDoctors(tx: Tx, ids: string[]): Promise<Doctor[]> {
  return lockMany(
    tx,
    'doctor',
    'doctor',
    ids,
    `SELECT id, full_name, department, room, active FROM doctors WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE`,
    mapDoctor,
    (r) => r.id,
  );
}

export async function lockDoctor(tx: Tx, doctorId: string): Promise<Doctor> {
  return required((await lockDoctors(tx, [doctorId]))[0], 'doctor');
}

const mapSession = (r: QueryResultRow): SessionLockRow => ({
  id: r.id,
  doctorId: r.doctor_id,
  policyId: r.policy_id,
  sessionDate: r.session_date,
  label: r.label,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  slotMinutes: r.slot_minutes,
  status: r.status,
  pausedAt: r.paused_at,
  pauseUntil: r.pause_until,
  pauseReason: r.pause_reason,
  rotationPointer: r.rotation_pointer,
  queueVersion: r.queue_version,
  nextSeqA: r.next_seq_a,
  nextSeqW: r.next_seq_w,
  version: r.version,
});

/**
 * Lock session rows (rank 2) in ascending id order. The doctor of every session must already be locked in
 * this transaction (LockOrderError otherwise). The doctor id is read with a plain non-locking SELECT first
 * (sessions.doctor_id never changes), so a violation is reported before any session lock is taken. There is
 * deliberately no opt-out: no caller needs a session snapshot without its doctor lock, and read-only
 * snapshots do not need a lock at all (use getSession).
 */
export function lockSessions(tx: Tx, ids: string[]): Promise<SessionLockRow[]> {
  return lockMany(
    tx,
    'session',
    'session',
    ids,
    `SELECT id, doctor_id, policy_id, session_date, label, starts_at, ends_at, slot_minutes, status,
            paused_at, pause_until, pause_reason, rotation_pointer, queue_version, next_seq_a, next_seq_w, version
       FROM sessions WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE`,
    mapSession,
    (r) => r.id,
    async (unique) => {
      const res = await tx.query<{ id: string; doctor_id: string }>(
        `SELECT id, doctor_id FROM sessions WHERE id = ANY($1::uuid[])`,
        [unique],
      );
      for (const row of res.rows) tx.assertHolds('doctor', row.doctor_id, `Locking session ${row.id}`);
    },
  );
}

export async function lockSession(tx: Tx, sessionId: string): Promise<SessionLockRow> {
  return required((await lockSessions(tx, [sessionId]))[0], 'session');
}

export const toCapacity = (r: QueryResultRow): CapacityLockRow => ({
  sessionId: r.session_id,
  bookedCapacity: r.booked_capacity,
  walkinCapacity: r.walkin_capacity,
  bookedReserved: r.booked_reserved,
  walkinUsed: r.walkin_used,
  bookedAvailable: r.booked_capacity - r.booked_reserved,
  walkinAvailable: r.walkin_capacity - r.walkin_used,
  version: r.version,
});

/** Lock capacity guard rows (rank 3), keyed by session id, in ascending id order. The session lock must be held. */
export function lockCapacities(tx: Tx, sessionIds: string[]): Promise<CapacityLockRow[]> {
  return lockMany(
    tx,
    'capacity',
    'session_capacity',
    sessionIds,
    `SELECT session_id, booked_capacity, walkin_capacity, booked_reserved, walkin_used, version
       FROM session_capacity WHERE session_id = ANY($1::uuid[]) ORDER BY session_id FOR NO KEY UPDATE`,
    toCapacity,
    (r) => r.sessionId,
    async (unique) => {
      for (const id of unique) tx.assertHolds('session', id, 'Locking the capacity guard');
    },
  );
}

export async function lockCapacity(tx: Tx, sessionId: string): Promise<CapacityLockRow> {
  return required((await lockCapacities(tx, [sessionId]))[0], 'session_capacity');
}
