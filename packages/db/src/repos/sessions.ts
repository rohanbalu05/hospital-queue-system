import type { Session } from '@hqms/contracts';
import { maybeOne, many, type Queryable } from '../pool.js';
import type { Tx } from '../tx.js';

const SELECT_SESSION = `
  SELECT s.id, s.doctor_id, d.full_name AS doctor_name, d.department, d.room, s.session_date, s.label,
         s.starts_at, s.ends_at, s.slot_minutes, s.status, p.version AS policy_version, s.version,
         c.booked_capacity, c.walkin_capacity, c.booked_reserved, c.walkin_used
    FROM sessions s
    JOIN doctors d ON d.id = s.doctor_id
    JOIN queue_policies p ON p.id = s.policy_id
    JOIN session_capacity c ON c.session_id = s.id`;

const mapSession = (r: any): Session => ({
  id: r.id,
  doctorId: r.doctor_id,
  doctorName: r.doctor_name,
  department: r.department,
  room: r.room,
  sessionDate: r.session_date,
  label: r.label,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  slotMinutes: r.slot_minutes,
  status: r.status,
  policyVersion: r.policy_version,
  capacity: {
    bookedCapacity: r.booked_capacity,
    walkinCapacity: r.walkin_capacity,
    bookedReserved: r.booked_reserved,
    walkinUsed: r.walkin_used,
    bookedAvailable: r.booked_capacity - r.booked_reserved,
    walkinAvailable: r.walkin_capacity - r.walkin_used,
  },
  version: r.version,
});

export interface SessionFilter {
  date?: string;
  from?: string;
  to?: string;
  doctorId?: string;
  /** Restrict to these doctors (staff scope). Empty array means none. */
  doctorIds?: string[];
  department?: string;
}

/** Sessions with capacity and policy version, ordered by start time then doctor name. Plain read (no locks). */
export async function listSessions(db: Queryable, f: SessionFilter = {}): Promise<Session[]> {
  const rows = await many(
    db,
    `${SELECT_SESSION}
      WHERE ($1::date IS NULL OR s.session_date = $1)
        AND ($2::date IS NULL OR s.session_date >= $2)
        AND ($3::date IS NULL OR s.session_date <= $3)
        AND ($4::uuid IS NULL OR s.doctor_id = $4)
        AND ($5::uuid[] IS NULL OR s.doctor_id = ANY($5))
        AND ($6::text IS NULL OR d.department = $6)
      ORDER BY s.starts_at, d.full_name`,
    [f.date ?? null, f.from ?? null, f.to ?? null, f.doctorId ?? null, f.doctorIds ?? null, f.department ?? null],
  );
  return rows.map(mapSession);
}

export async function getSession(db: Queryable, id: string): Promise<Session | null> {
  const r = await maybeOne(db, `${SELECT_SESSION} WHERE s.id = $1`, [id]);
  return r ? mapSession(r) : null;
}

export interface CreateSessionInput {
  id?: string;
  doctorId: string;
  sessionDate: string;
  label: 'morning' | 'afternoon' | 'evening';
  startsAt: string | Date;
  endsAt: string | Date;
  slotMinutes?: number;
  status?: 'scheduled' | 'open';
  bookedCapacity?: number;
  walkinCapacity?: number;
  /** Defaults to the latest policy version. */
  policyId?: string;
}

/**
 * Insert a session and its capacity guard row. Capacities default from the policy. Returns the id,
 * or null if (doctor_id, starts_at) already exists (idempotent seeding / admin retry).
 */
export async function createSession(tx: Tx, s: CreateSessionInput): Promise<string | null> {
  const res = await tx.query<{ id: string }>(
    `WITH pol AS (
       SELECT id, default_booked_capacity, default_walkin_capacity FROM queue_policies
        WHERE ($8::uuid IS NULL OR id = $8) ORDER BY version DESC LIMIT 1
     ), ins AS (
       INSERT INTO sessions (id, doctor_id, policy_id, session_date, label, starts_at, ends_at, slot_minutes, status)
       SELECT COALESCE($1::uuid, gen_random_uuid()), $2, pol.id, $3, $4, $5, $6, COALESCE($7, 20), COALESCE($9, 'scheduled')
         FROM pol
       ON CONFLICT (doctor_id, starts_at) DO NOTHING
       RETURNING id
     )
     INSERT INTO session_capacity (session_id, booked_capacity, walkin_capacity)
     SELECT ins.id, COALESCE($10::int, pol.default_booked_capacity), COALESCE($11::int, pol.default_walkin_capacity)
       FROM ins, pol
     RETURNING session_id AS id`,
    [
      s.id ?? null,
      s.doctorId,
      s.sessionDate,
      s.label,
      s.startsAt,
      s.endsAt,
      s.slotMinutes ?? null,
      s.policyId ?? null,
      s.status ?? null,
      s.bookedCapacity ?? null,
      s.walkinCapacity ?? null,
    ],
  );
  return res.rows[0]?.id ?? null;
}
