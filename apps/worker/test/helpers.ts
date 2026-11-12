import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  createPool,
  createSession,
  insertAppointment,
  lockCapacity,
  lockDoctor,
  lockSession,
  reserveBooked,
  withTransaction,
} from '@hqms/db';
import { createLogger, silentLogger, type Logger } from '../src/log.js';

export const TEST_DB = process.env['WORKER_TEST_DB_NAME'] ?? 'hqms_test_worker_w3';

export function adminUrl(): string {
  return process.env['TEST_ADMIN_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/postgres';
}

export function testUrl(): string {
  const u = new URL(adminUrl());
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

export const makePool = (max = 6): Pool => createPool(testUrl(), { max, applicationName: 'worker-test' });

/** Quiet logger; set TEST_LOG=1 to see worker logs while debugging. */
export const testLog: Logger = process.env['TEST_LOG'] ? createLogger({ test: true }, 'debug') : silentLogger;

export function must<T>(v: T | null | undefined, what = 'value'): T {
  if (v === null || v === undefined) throw new Error(`${what} was null`);
  return v;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface World {
  hospitalId: string;
  doctorId: string;
  room: string;
  receptionUserId: string;
  sessionId: string;
  startsAt: Date;
}

/** Fresh hospital + doctor + reception user + open session; unique per call so tests never share guards. */
export async function makeWorld(
  pool: Pool,
  opts: { booked?: number; walkin?: number; startsAt?: Date } = {},
): Promise<World> {
  const tag = randomUUID().slice(0, 8);
  const hospitalId = (await pool.query(`INSERT INTO hospitals (name) VALUES ($1) RETURNING id`, [`H ${tag}`])).rows[0]
    .id as string;
  const room = `OPD ${Math.floor(Math.random() * 90) + 10}`;
  const doctorId = (
    await pool.query(
      `INSERT INTO doctors (hospital_id, full_name, department, room) VALUES ($1, $2, 'General Medicine', $3) RETURNING id`,
      [hospitalId, `Dr Test ${tag}`, room],
    )
  ).rows[0].id as string;
  const receptionUserId = (
    await pool.query(
      `INSERT INTO users (hospital_id, email, display_name, role) VALUES ($1, $2, 'Reception', 'reception') RETURNING id`,
      [hospitalId, `rec-${tag}@test.local`],
    )
  ).rows[0].id as string;
  const startsAt = opts.startsAt ?? new Date(Date.now() + 3_600_000);
  const sessionId = must(
    await withTransaction(pool, (tx) =>
      createSession(tx, {
        doctorId,
        sessionDate: startsAt.toISOString().slice(0, 10),
        label: 'morning',
        startsAt,
        endsAt: new Date(startsAt.getTime() + 4 * 3_600_000),
        status: 'open',
        bookedCapacity: opts.booked ?? 20,
        walkinCapacity: opts.walkin ?? 60,
      }),
    ),
    'session id',
  );
  return { hospitalId, doctorId, room, receptionUserId, sessionId, startsAt };
}

export async function makePatient(
  pool: Pool,
  w: World,
  opts: { login?: boolean } = {},
): Promise<{ patientId: string; userId: string | null }> {
  const tag = randomUUID().slice(0, 8);
  const patientId = (
    await pool.query(`INSERT INTO patients (hospital_id, mrn, full_name) VALUES ($1, $2, $3) RETURNING id`, [
      w.hospitalId,
      `T-${tag}`,
      `Patient Secret ${tag}`,
    ])
  ).rows[0].id as string;
  let userId: string | null = null;
  if (opts.login) {
    userId = (
      await pool.query(
        `INSERT INTO users (hospital_id, email, display_name, role, patient_id) VALUES ($1, $2, 'Pat', 'patient', $3) RETURNING id`,
        [w.hospitalId, `pat-${tag}@test.local`, patientId],
      )
    ).rows[0].id as string;
  }
  return { patientId, userId };
}

export interface EntryFixture {
  patientId: string;
  userId: string | null;
  visitId: string;
  entryId: string;
  token: string;
}

let tokenSeq = 100;

/** A walk-in visit with a queue entry in the given state (called_at set when state is 'called'). */
export async function makeEntry(
  pool: Pool,
  w: World,
  opts: { state?: 'waiting' | 'called' | 'in_service'; calledAt?: Date; login?: boolean } = {},
): Promise<EntryFixture> {
  const state = opts.state ?? 'called';
  const { patientId, userId } = await makePatient(pool, w, { login: opts.login ?? false });
  const allocationId = (
    await pool.query(
      `INSERT INTO capacity_allocations (session_id, kind, state) VALUES ($1, 'walkin', 'consumed') RETURNING id`,
      [w.sessionId],
    )
  ).rows[0].id as string;
  await pool.query(`UPDATE session_capacity SET walkin_used = walkin_used + 1 WHERE session_id = $1`, [w.sessionId]);
  const checkedIn = new Date((opts.calledAt ?? new Date()).getTime() - 10 * 60_000);
  const visitId = (
    await pool.query(
      `INSERT INTO visits (patient_id, session_id, doctor_id, allocation_id, kind, checked_in_at, checked_in_by)
       VALUES ($1, $2, $3, $4, 'walkin', $5, $6) RETURNING id`,
      [patientId, w.sessionId, w.doctorId, allocationId, checkedIn, w.receptionUserId],
    )
  ).rows[0].id as string;
  const seq = ++tokenSeq;
  const token = `W-${seq}`;
  const entryId = (
    await pool.query(
      `INSERT INTO queue_entries (visit_id, session_id, doctor_id, queue_group, token, seq, state, checked_in_at, eligible_at, called_at, call_count)
       VALUES ($1, $2, $3, 'W', $4, $5, $6, $7, $7, $8, $9) RETURNING id`,
      [
        visitId,
        w.sessionId,
        w.doctorId,
        token,
        seq,
        state,
        checkedIn,
        state === 'waiting' ? null : (opts.calledAt ?? new Date()),
        state === 'waiting' ? 0 : 1,
      ],
    )
  ).rows[0].id as string;
  return { patientId, userId, visitId, entryId, token };
}

/** Book one appointment with the full lock sequence (same as the API will). */
export async function bookAppointment(
  pool: Pool,
  w: World,
  opts: { scheduledAt?: Date; login?: boolean } = {},
): Promise<{ appointmentId: string; allocationId: string; patientId: string; userId: string | null }> {
  const { patientId, userId } = await makePatient(pool, w, { login: opts.login ?? false });
  const r = await withTransaction(pool, async (tx) => {
    await lockDoctor(tx, w.doctorId);
    const s = await lockSession(tx, w.sessionId);
    await lockCapacity(tx, w.sessionId);
    const allocationId = await reserveBooked(tx, w.sessionId);
    const a = await insertAppointment(tx, {
      patientId,
      sessionId: w.sessionId,
      doctorId: w.doctorId,
      scheduledAt: opts.scheduledAt ?? s.startsAt,
      allocationId,
      bookedBy: w.receptionUserId,
    });
    return { appointmentId: a.id, allocationId };
  });
  return { ...r, patientId, userId };
}

export async function insertJob(
  pool: Pool,
  j: {
    type: string;
    payload?: unknown;
    runAt?: Date;
    maxAttempts?: number;
    dedupeKey?: string;
    state?: string;
    attempts?: number;
    leaseOwner?: string;
    leaseExpiresAt?: Date;
  },
): Promise<string> {
  const r = await pool.query(
    `INSERT INTO jobs (job_type, payload, run_at, max_attempts, dedupe_key, state, attempts, lease_owner, lease_expires_at)
     VALUES ($1, $2::jsonb, COALESCE($3::timestamptz, now()), COALESCE($4, 5), $5, COALESCE($6, 'pending'), COALESCE($7, 0), $8, $9) RETURNING id`,
    [
      j.type,
      JSON.stringify(j.payload ?? {}),
      j.runAt ?? null,
      j.maxAttempts ?? null,
      j.dedupeKey ?? null,
      j.state ?? null,
      j.attempts ?? null,
      j.leaseOwner ?? null,
      j.leaseExpiresAt ?? null,
    ],
  );
  return r.rows[0].id as string;
}

export async function getJob(pool: Pool, id: string) {
  return (await pool.query(`SELECT * FROM jobs WHERE id = $1`, [id])).rows[0];
}

export const fixedClock = (initial: Date) => {
  let t = initial.getTime();
  const clock = () => new Date(t);
  clock.set = (d: Date) => void (t = d.getTime());
  clock.advance = (ms: number) => void (t += ms);
  return clock;
};
