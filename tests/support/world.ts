/**
 * Shared fixtures for the black-box suites: DB pool for invariant queries, session factories,
 * patient registration and the global invariant checker. Everything talks to the real API over HTTP
 * and to the real PostgreSQL; nothing is mocked.
 */
import { inject } from 'vitest';
import pg from 'pg';
import { stableId } from '../../db/seed/seed.js';
import { type ApiClient, login, type ApiResponse } from './client.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export const apiUrl = (): string => inject('apiUrl');
export const databaseUrl = (): string => inject('databaseUrl');

let sharedPool: pg.Pool | undefined;
/** Direct connection pool for read-only invariant queries (never used to change state). */
export function pool(): pg.Pool {
  sharedPool ??= new pg.Pool({ connectionString: databaseUrl(), max: 4 });
  return sharedPool;
}
export async function closePool(): Promise<void> {
  await sharedPool?.end();
  sharedPool = undefined;
}

export const doctorId = (n: number): string => stableId(`doctor:${n}`);
export const seededPatientId = (n: number): string => stableId(`patient:${n}`);

export const loginAs = (email: string): Promise<ApiClient> => login(apiUrl(), email);

/** Hospital-local (Asia/Kolkata) calendar date of an instant, YYYY-MM-DD. */
export function istDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export interface MadeSession {
  id: string;
  doctor: number;
  date: string;
  startsAt: string;
  endsAt: string;
}

export interface SessionOptions {
  doctor?: number;
  booked?: number;
  walkin?: number;
}

let futureCursor = Math.floor(Math.random() * 25_000);

/**
 * A session on a far-future date (2040+), so it is always bookable and never collides with the seed.
 * Unique (doctor, starts_at) clashes (409) are retried with the next date.
 */
export async function makeFutureSession(admin: ApiClient, opts: SessionOptions = {}): Promise<MadeSession> {
  const doctor = opts.doctor ?? 1 + Math.floor(Math.random() * 10);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    futureCursor += 1 + Math.floor(Math.random() * 3);
    const date = new Date(Date.UTC(2040, 0, 1 + futureCursor)).toISOString().slice(0, 10);
    const startsAt = `${date}T09:00:00+05:30`;
    const endsAt = `${date}T13:00:00+05:30`;
    const res = await admin.post(
      '/sessions',
      {
        doctorId: doctorId(doctor),
        sessionDate: date,
        label: 'morning',
        startsAt,
        endsAt,
        bookedCapacity: opts.booked ?? 10,
        walkinCapacity: opts.walkin ?? 5,
      },
      null,
    );
    if (res.status === 201) {
      return { id: res.body.id, doctor, date, startsAt: new Date(startsAt).toISOString(), endsAt };
    }
    if (res.status !== 409) throw new Error(`could not create session: ${res.status} ${JSON.stringify(res.body)}`);
  }
  throw new Error('could not find a free (doctor, start) slot for a future session');
}

/**
 * A session dated TODAY (hospital-local) whose first slot starts 60-170 minutes from now, so appointments
 * booked into it are in the future and check-in is accepted (arrivals are only accepted on the session's own day).
 */
export async function makeTodaySession(admin: ApiClient, opts: SessionOptions = {}): Promise<MadeSession> {
  const now = Date.now();
  const date = istDate(new Date(now));
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const doctor = opts.doctor ?? 1 + Math.floor(Math.random() * 10);
    const startMs = Math.ceil((now + (60 + Math.floor(Math.random() * 110)) * 60_000) / 60_000) * 60_000;
    const startsAt = new Date(startMs).toISOString();
    const endsAt = new Date(startMs + 4 * 3_600_000).toISOString();
    const res = await admin.post(
      '/sessions',
      {
        doctorId: doctorId(doctor),
        sessionDate: date,
        label: 'afternoon',
        startsAt,
        endsAt,
        bookedCapacity: opts.booked ?? 10,
        walkinCapacity: opts.walkin ?? 5,
      },
      null,
    );
    if (res.status === 201) return { id: res.body.id, doctor, date, startsAt, endsAt };
    if (res.status !== 409)
      throw new Error(`could not create today session: ${res.status} ${JSON.stringify(res.body)}`);
  }
  throw new Error('could not find a free (doctor, start) pair for a today session');
}

/** Register `n` fresh patients (assisted registration) and return their ids. */
export async function registerPatients(
  reception: ApiClient,
  n: number,
  prefix = 'Blackbox Patient',
): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const res = await reception.post('/patients', { fullName: `${prefix} ${i + 1}` });
    if (res.status !== 201) throw new Error(`could not register patient: ${res.status} ${JSON.stringify(res.body)}`);
    out.push(res.body.id as string);
  }
  return out;
}

export async function book(
  client: ApiClient,
  sessionId: string,
  patientId?: string,
  key?: string,
): Promise<ApiResponse> {
  return client.post('/appointments', { sessionId, ...(patientId ? { patientId } : {}) }, key);
}

// ---------------------------------------------------------------------------------------------------
// SQL helpers and invariants
// ---------------------------------------------------------------------------------------------------

export async function sqlRows<T extends Record<string, any> = Record<string, any>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const r = await pool().query<T>(sql, params);
  return r.rows;
}

export interface CapacityCounts {
  booked_capacity: number;
  walkin_capacity: number;
  booked_reserved: number;
  walkin_used: number;
  booked_allocations: number;
  walkin_allocations: number;
  active_appointments: number;
}

/** Counters next to the allocation rows they are supposed to equal. */
export async function capacityCounts(sessionId: string): Promise<CapacityCounts> {
  const rows = await sqlRows<CapacityCounts>(
    `SELECT c.booked_capacity, c.walkin_capacity, c.booked_reserved, c.walkin_used,
            (SELECT count(*)::int FROM capacity_allocations a WHERE a.session_id = c.session_id
               AND a.kind = 'booked' AND a.state IN ('reserved','consumed')) AS booked_allocations,
            (SELECT count(*)::int FROM capacity_allocations a WHERE a.session_id = c.session_id
               AND a.kind = 'walkin' AND a.state IN ('reserved','consumed')) AS walkin_allocations,
            (SELECT count(*)::int FROM appointments p WHERE p.session_id = c.session_id
               AND p.status IN ('booked','checked_in','completed')) AS active_appointments
       FROM session_capacity c WHERE c.session_id = $1`,
    [sessionId],
  );
  const row = rows[0];
  if (!row) throw new Error(`no capacity row for session ${sessionId}`);
  return row;
}

/** Appointment row joined with its allocation, for before/after comparisons. */
export async function appointmentSnapshot(appointmentId: string): Promise<Record<string, any> | undefined> {
  const rows = await sqlRows(
    `SELECT p.*, a.state AS allocation_state, a.kind AS allocation_kind, a.session_id AS allocation_session_id,
            a.updated_at AS allocation_updated_at
       FROM appointments p JOIN capacity_allocations a ON a.id = p.allocation_id WHERE p.id = $1`,
    [appointmentId],
  );
  return rows[0];
}

export interface InvariantReport {
  sessionsChecked: number;
  violations: string[];
}

/**
 * Whole-database invariants that must hold after every suite (Table 13 + FR-03..05):
 *  - per session: booked_reserved == reserved+consumed booked allocations <= booked_capacity; same for walk-ins;
 *  - no session has two active appointments in the same slot, and active appointments <= booked capacity;
 *  - an appointment's allocation state agrees with its status (booked -> reserved, cancelled/rescheduled -> released);
 *  - no appointment has two visits; no visit has two queue entries; no doctor has two called/in-service entries.
 */
export async function checkGlobalInvariants(): Promise<InvariantReport> {
  const violations: string[] = [];

  const counters = await sqlRows(
    `SELECT c.session_id, c.booked_capacity, c.walkin_capacity, c.booked_reserved, c.walkin_used,
            count(a.*) FILTER (WHERE a.kind = 'booked' AND a.state IN ('reserved','consumed'))::int AS booked_alloc,
            count(a.*) FILTER (WHERE a.kind = 'walkin' AND a.state IN ('reserved','consumed'))::int AS walkin_alloc
       FROM session_capacity c LEFT JOIN capacity_allocations a ON a.session_id = c.session_id
      GROUP BY c.session_id, c.booked_capacity, c.walkin_capacity, c.booked_reserved, c.walkin_used`,
  );
  for (const r of counters) {
    if (r.booked_reserved !== r.booked_alloc)
      violations.push(`session ${r.session_id}: booked_reserved ${r.booked_reserved} != allocations ${r.booked_alloc}`);
    if (r.walkin_used !== r.walkin_alloc)
      violations.push(`session ${r.session_id}: walkin_used ${r.walkin_used} != allocations ${r.walkin_alloc}`);
    if (r.booked_alloc > r.booked_capacity)
      violations.push(`session ${r.session_id}: booked allocations ${r.booked_alloc} > capacity ${r.booked_capacity}`);
    if (r.walkin_alloc > r.walkin_capacity)
      violations.push(`session ${r.session_id}: walk-in allocations ${r.walkin_alloc} > capacity ${r.walkin_capacity}`);
  }

  const slotDupes = await sqlRows(
    `SELECT session_id, scheduled_at, count(*)::int AS n FROM appointments
      WHERE status IN ('booked','checked_in','completed') GROUP BY session_id, scheduled_at HAVING count(*) > 1`,
  );
  for (const r of slotDupes)
    violations.push(`session ${r.session_id}: ${r.n} active appointments at ${r.scheduled_at}`);

  const overActive = await sqlRows(
    `SELECT p.session_id, count(*)::int AS n, max(c.booked_capacity) AS cap FROM appointments p
       JOIN session_capacity c ON c.session_id = p.session_id
      WHERE p.status IN ('booked','checked_in','completed') GROUP BY p.session_id HAVING count(*) > max(c.booked_capacity)`,
  );
  for (const r of overActive)
    violations.push(`session ${r.session_id}: ${r.n} active appointments > capacity ${r.cap}`);

  const mismatched = await sqlRows(
    `SELECT p.id, p.status, a.state FROM appointments p JOIN capacity_allocations a ON a.id = p.allocation_id
      WHERE (p.status = 'booked' AND a.state <> 'reserved')
         OR (p.status IN ('cancelled','rescheduled') AND a.state <> 'released')
         OR (p.status IN ('checked_in','completed') AND a.state <> 'consumed' AND NOT EXISTS (
               SELECT 1 FROM visits v WHERE v.appointment_id = p.id AND v.kind = 'late_admission'))`,
  );
  for (const r of mismatched) violations.push(`appointment ${r.id}: status ${r.status} but allocation ${r.state}`);

  const dupVisits = await sqlRows(
    `SELECT appointment_id, count(*)::int AS n FROM visits WHERE appointment_id IS NOT NULL GROUP BY appointment_id HAVING count(*) > 1`,
  );
  for (const r of dupVisits) violations.push(`appointment ${r.appointment_id}: ${r.n} visits`);

  const dupEntries = await sqlRows(
    `SELECT visit_id, count(*)::int AS n FROM queue_entries GROUP BY visit_id HAVING count(*) > 1`,
  );
  for (const r of dupEntries) violations.push(`visit ${r.visit_id}: ${r.n} queue entries`);

  const dupActive = await sqlRows(
    `SELECT doctor_id, count(*)::int AS n FROM queue_entries WHERE state IN ('called','in_service') GROUP BY doctor_id HAVING count(*) > 1`,
  );
  for (const r of dupActive) violations.push(`doctor ${r.doctor_id}: ${r.n} called/in-service entries`);

  const orphanVisits = await sqlRows(
    `SELECT v.id FROM visits v LEFT JOIN queue_entries q ON q.visit_id = v.id WHERE q.id IS NULL`,
  );
  for (const r of orphanVisits) violations.push(`visit ${r.id}: no queue entry`);

  return { sessionsChecked: counters.length, violations };
}

/**
 * Fingerprint of every state-bearing table an unauthorized request could touch: md5 over the full rows of
 * appointments, allocations, capacities, visits, queue entries, patients and sessions, plus row counts of the
 * append-only tables (outbox, jobs, idempotency records, state-changing audit operations).
 * Equal fingerprints before and after a request mean it had zero side effects.
 */
export async function dbFingerprint(): Promise<string> {
  const tables = [
    'appointments',
    'capacity_allocations',
    'session_capacity',
    'visits',
    'queue_entries',
    'patients',
    'sessions',
  ];
  const parts: string[] = [];
  for (const t of tables) {
    const r = await sqlRows<{ h: string | null }>(
      `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`,
    );
    parts.push(`${t}:${r[0]?.h}`);
  }
  const counts = await sqlRows(
    `SELECT (SELECT count(*)::int FROM outbox_events) AS outbox,
            (SELECT count(*)::int FROM jobs) AS jobs,
            (SELECT count(*)::int FROM idempotency_records) AS idem,
            (SELECT count(*)::int FROM audit_events
               WHERE operation NOT LIKE 'auth.%' AND operation NOT LIKE '%search%' AND operation NOT LIKE '%denied%') AS audit`,
  );
  parts.push(JSON.stringify(counts[0]));
  return parts.join(';');
}

export interface Tally {
  total: number;
  byStatus: Record<string, number>;
  byCode: Record<string, number>;
  serverErrors: number;
}

/** Count responses by HTTP status and by ApiError code. */
export function tally(results: ApiResponse[]): Tally {
  const byStatus: Record<string, number> = {};
  const byCode: Record<string, number> = {};
  let serverErrors = 0;
  for (const r of results) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const code = r.body?.error?.code;
    if (typeof code === 'string') byCode[code] = (byCode[code] ?? 0) + 1;
    if (r.status >= 500) serverErrors += 1;
  }
  return { total: results.length, byStatus, byCode, serverErrors };
}
