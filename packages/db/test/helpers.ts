import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Pool } from 'pg';
import {
  createSession,
  insertAppointment,
  lockCapacity,
  lockDoctor,
  lockSession,
  reserveBooked,
  withTransaction,
} from '../src/index.js';

const ADMIN_URL = process.env['TEST_ADMIN_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/postgres';

/** Shared scratch database for tests that build their own isolated fixtures. */
export const TEST_DB = 'hqms_test_db_engineer';

export function testUrl(db: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
}

/** Drop (force) and create an empty database. */
export async function createDatabase(name: string): Promise<void> {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${name}"`);
  } finally {
    await c.end();
  }
}

export async function dropDatabase(name: string): Promise<void> {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await c.end();
  }
}

export interface Fixture {
  hospitalId: string;
  doctorId: string;
  userId: string;
  patientIds: string[];
  sessionId: string;
}

/** Hospital + doctor + reception user + patients + one session (capacity as given). Unique per call. */
export async function makeFixture(
  pool: Pool,
  opts: { booked?: number; walkin?: number; patients?: number; startsAt?: Date } = {},
): Promise<Fixture> {
  const tag = randomUUID().slice(0, 8);
  const hospital = await pool.query<{ id: string }>(`INSERT INTO hospitals (name) VALUES ($1) RETURNING id`, [`H ${tag}`]);
  const hospitalId = hospital.rows[0]!.id;
  const doctor = await pool.query<{ id: string }>(
    `INSERT INTO doctors (hospital_id, full_name, department, room) VALUES ($1, $2, 'General Medicine', 'OPD 1') RETURNING id`,
    [hospitalId, `Dr ${tag}`],
  );
  const doctorId = doctor.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (hospital_id, email, display_name, role) VALUES ($1, $2, 'Reception', 'reception') RETURNING id`,
    [hospitalId, `rec-${tag}@test.local`],
  );
  const patientIds: string[] = [];
  for (let i = 0; i < (opts.patients ?? 0); i++) {
    const p = await pool.query<{ id: string }>(
      `INSERT INTO patients (hospital_id, mrn, full_name) VALUES ($1, $2, $3) RETURNING id`,
      [hospitalId, `T-${tag}-${i}`, `Patient ${i}`],
    );
    patientIds.push(p.rows[0]!.id);
  }
  const startsAt = opts.startsAt ?? new Date(Date.now() + 86_400_000 + Math.floor(Math.random() * 1e6) * 1000);
  const sessionId = (await withTransaction(pool, (tx) =>
    createSession(tx, {
      doctorId,
      sessionDate: startsAt.toISOString().slice(0, 10),
      label: 'morning',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 4 * 3_600_000),
      bookedCapacity: opts.booked ?? 5,
      walkinCapacity: opts.walkin ?? 2,
    }),
  ))!;
  return { hospitalId, doctorId, userId: user.rows[0]!.id, patientIds, sessionId };
}

/** A second session for the same doctor (reschedule targets). */
export async function addSession(pool: Pool, f: Fixture, opts: { booked?: number; walkin?: number } = {}): Promise<string> {
  const startsAt = new Date(Date.now() + 2 * 86_400_000 + Math.floor(Math.random() * 1e6) * 1000);
  return (await withTransaction(pool, (tx) =>
    createSession(tx, {
      doctorId: f.doctorId,
      sessionDate: startsAt.toISOString().slice(0, 10),
      label: 'afternoon',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 4 * 3_600_000),
      bookedCapacity: opts.booked ?? 5,
      walkinCapacity: opts.walkin ?? 2,
    }),
  ))!;
}

/** Book one appointment with the full lock sequence. */
export async function bookOne(
  pool: Pool,
  f: Fixture,
  patientId: string,
  sessionId = f.sessionId,
): Promise<{ appointmentId: string; allocationId: string }> {
  return withTransaction(pool, async (tx) => {
    await lockDoctor(tx, f.doctorId);
    const s = await lockSession(tx, sessionId);
    await lockCapacity(tx, sessionId);
    const allocationId = await reserveBooked(tx, sessionId);
    const a = await insertAppointment(tx, {
      patientId,
      sessionId,
      doctorId: f.doctorId,
      scheduledAt: s.startsAt,
      allocationId,
      bookedBy: f.userId,
    });
    return { appointmentId: a.id, allocationId };
  });
}
