import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  capacityInvariant,
  createPatient,
  createPool,
  getAppointment,
  getLatestPolicy,
  getMe,
  getPatient,
  getPolicyByVersion,
  getServiceEstimate,
  getSession,
  getUserByEmail,
  getUserById,
  listAppointmentsByPatient,
  listAppointmentsBySession,
  listDoctors,
  listSessions,
  migrate,
  searchPatients,
  upsertServiceEstimate,
  verifyPassword,
  withTransaction,
} from '../src/index.js';
import { istDate, seed } from '../../../db/seed/seed.js';
import { createDatabase, dropDatabase, testUrl } from './helpers.js';

const DB = 'hqms_test_db_engineer_seed';
let pool: Pool;
let first: Awaited<ReturnType<typeof seed>>;

const counts = async () => {
  const tables = [
    'hospitals', 'doctors', 'users', 'staff_assignments', 'patients', 'sessions', 'session_capacity',
    'capacity_allocations', 'appointments', 'audit_events',
  ];
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = (await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
  return out;
};

beforeAll(async () => {
  await createDatabase(DB);
  pool = createPool(testUrl(DB), { max: 4 });
  await migrate(pool);
  first = await seed(pool);
}, 120_000);
afterAll(async () => {
  await pool.end();
  await dropDatabase(DB);
});

describe('seed', () => {
  it('creates the specified demo data', async () => {
    const c = await counts();
    expect(c).toMatchObject({
      hospitals: 1,
      doctors: 10,
      users: 32, // 22 staff + 10 patient logins
      patients: 40,
      sessions: 140, // 10 doctors x 2 sessions x 7 days
      session_capacity: 140,
    });
    const roles = await pool.query(`SELECT role, count(*)::int AS n FROM users GROUP BY role`);
    expect(Object.fromEntries(roles.rows.map((r) => [r.role, r.n]))).toEqual({ doctor: 10, reception: 6, followup: 4, admin: 2, patient: 10 });
    const depts = await pool.query(`SELECT department, count(*)::int AS n FROM doctors GROUP BY department`);
    expect(depts.rows).toHaveLength(5);
    expect(depts.rows.every((r) => r.n === 2)).toBe(true);
    expect(first).toMatchObject({ doctors: 10, staff: 22, patients: 40, sessionsCreated: 140, appointmentsCreated: 15 });
  });

  it('is idempotent: a second run adds nothing', async () => {
    const before = await counts();
    const again = await seed(pool);
    expect(again).toMatchObject({ sessionsCreated: 0, appointmentsCreated: 0 });
    expect(await counts()).toEqual(before);
  });

  it('adds only the new day when re-run on a later date', async () => {
    const before = (await counts()).sessions!;
    const tomorrow = new Date(Date.now() + 86_400_000);
    const again = await seed(pool, { now: tomorrow });
    expect(again.sessionsCreated).toBe(20); // one new day: 10 doctors x 2
    expect((await counts()).sessions).toBe(before + 20);
  });

  it('every session is 10 booked + 5 walk-in, policy v1, today open and later days scheduled', async () => {
    const today = istDate(0);
    const rows = await pool.query(
      `SELECT s.session_date, s.status, s.label, s.slot_minutes, s.starts_at, s.ends_at, c.booked_capacity, c.walkin_capacity, p.version
         FROM sessions s JOIN session_capacity c ON c.session_id = s.id JOIN queue_policies p ON p.id = s.policy_id
        WHERE s.session_date <= $1::date + 6`,
      [today],
    );
    for (const r of rows.rows) {
      expect(r).toMatchObject({ booked_capacity: 10, walkin_capacity: 5, version: 1, slot_minutes: 20 });
      expect(r.status).toBe(r.session_date === today ? 'open' : 'scheduled');
    }
    const morning = rows.rows.find((r) => r.label === 'morning')!;
    // 09:00-13:00 IST is 03:30-07:30 UTC
    expect(morning.starts_at.slice(11, 16)).toBe('03:30');
    expect(morning.ends_at.slice(11, 16)).toBe('07:30');
    expect((new Date(morning.ends_at).getTime() - new Date(morning.starts_at).getTime()) / (20 * 60_000)).toBeGreaterThanOrEqual(10);
  });

  it('counters match allocation rows for every session', async () => {
    const ids = await pool.query(`SELECT session_id FROM session_capacity`);
    for (const r of ids.rows) expect((await capacityInvariant(pool, r.session_id)).ok).toBe(true);
    const booked = await pool.query(`SELECT sum(booked_reserved)::int AS n FROM session_capacity`);
    expect(booked.rows[0].n).toBe(15);
    expect((await counts()).appointments).toBe(15);
  });

  it('demo accounts exist with password demo1234 and the right scope', async () => {
    const emails = ['admin@hqms.test', 'reception@hqms.test', 'doctor@hqms.test', 'followup@hqms.test', 'patient@hqms.test', 'patient2@hqms.test'];
    for (const email of emails) {
      const u = await getUserByEmail(pool, email);
      expect(u, email).not.toBeNull();
      expect(await verifyPassword(u!.passwordHash, 'demo1234'), email).toBe(true);
      expect(await verifyPassword(u!.passwordHash, 'wrong')).toBe(false);
    }
    expect(u_role(await getUserByEmail(pool, 'Admin@HQMS.test'))).toBe('admin'); // case-insensitive

    const all = (await listDoctors(pool)).map((d) => d.id);
    expect((await getMe(pool, (await getUserByEmail(pool, 'reception@hqms.test'))!.id))!.assignedDoctorIds.sort()).toEqual([...all].sort());
    expect((await getMe(pool, (await getUserByEmail(pool, 'followup@hqms.test'))!.id))!.assignedDoctorIds).toHaveLength(10);
    expect((await getMe(pool, (await getUserByEmail(pool, 'admin@hqms.test'))!.id))!.assignedDoctorIds).toHaveLength(10);
    expect((await getMe(pool, (await getUserByEmail(pool, 'reception2@hqms.test'))!.id))!.assignedDoctorIds).toHaveLength(2);

    const doc = (await getMe(pool, (await getUserByEmail(pool, 'doctor@hqms.test'))!.id))!;
    const gm = (await listDoctors(pool, { department: 'General Medicine' }))[0]!;
    expect(doc.doctorId).toBeTruthy();
    expect(['Dr. Suresh Hegde', 'Dr. Lakshmi Narayan']).toContain(gm.fullName);
    const first = await pool.query(`SELECT full_name FROM doctors WHERE id = $1`, [doc.doctorId]);
    expect(first.rows[0].full_name).toBe('Dr. Suresh Hegde');

    const p = (await getMe(pool, (await getUserByEmail(pool, 'patient@hqms.test'))!.id))!;
    expect(p).toMatchObject({ role: 'patient', assignedDoctorIds: [] });
    expect(p.patientId).toBeTruthy();
    // the demo patient has an appointment today with the demo doctor
    const appts = await listAppointmentsByPatient(pool, p.patientId!);
    expect(appts.some((a) => a.doctorId === doc.doctorId && a.sessionId)).toBe(true);
  });

  it('reception scopes: 6 receptionists, one for all doctors, the rest partial', async () => {
    const r = await pool.query(
      `SELECT u.email, count(a.doctor_id)::int AS n FROM users u LEFT JOIN staff_assignments a ON a.user_id = u.id
        WHERE u.role IN ('reception','followup') GROUP BY u.email ORDER BY u.email`,
    );
    const byEmail = Object.fromEntries(r.rows.map((x) => [x.email, x.n]));
    expect(byEmail['reception@hqms.test']).toBe(10);
    expect(byEmail['followup@hqms.test']).toBe(10);
    expect(Object.values(byEmail).every((n) => (n as number) > 0)).toBe(true);
  });
});

function u_role(u: { role: string } | null) {
  return u?.role;
}

describe('repositories', () => {
  it('sessions: list with capacity and policy version, get, filters', async () => {
    const today = istDate(0);
    const list = await listSessions(pool, { date: today });
    expect(list).toHaveLength(20);
    const gm = await listSessions(pool, { date: today, department: 'General Medicine' });
    expect(gm).toHaveLength(4);
    const s = gm.find((x) => x.label === 'morning' && x.doctorName === 'Dr. Suresh Hegde')!;
    expect(s).toMatchObject({
      sessionDate: today,
      policyVersion: 1,
      status: 'open',
      room: 'OPD 1',
      capacity: { bookedCapacity: 10, walkinCapacity: 5, bookedReserved: 3, bookedAvailable: 7, walkinAvailable: 5 },
    });
    expect(s.startsAt).toMatch(/Z$/);
    expect(await getSession(pool, s.id)).toEqual(s);
    expect(await getSession(pool, '00000000-0000-4000-8000-000000000000')).toBeNull();
    const week = await listSessions(pool, { from: today, to: istDate(6), doctorId: s.doctorId });
    expect(week).toHaveLength(14);
    expect(await listSessions(pool, { doctorIds: [] })).toHaveLength(0);
  });

  it('appointments: get and list by session / patient', async () => {
    const today = istDate(0);
    const s = (await listSessions(pool, { date: today, department: 'General Medicine' })).find(
      (x) => x.label === 'morning' && x.doctorName === 'Dr. Suresh Hegde',
    )!;
    const inSession = await listAppointmentsBySession(pool, s.id);
    expect(inSession).toHaveLength(3);
    expect(inSession[0]!.scheduledAt <= inSession[2]!.scheduledAt).toBe(true);
    const one = await getAppointment(pool, inSession[0]!.id);
    expect(one).toMatchObject({ status: 'booked', department: 'General Medicine', rescheduledFromId: null });
    expect(await listAppointmentsBySession(pool, s.id, { statuses: ['cancelled'] })).toHaveLength(0);
  });

  it('policies, doctors, patients', async () => {
    const p1 = await getPolicyByVersion(pool, 1);
    expect(p1).toMatchObject({
      rotation: ['A', 'A', 'W'], earlyEligibilityMin: 10, lateGraceMin: 15, agingTriggerMin: 45,
      calledTimeoutSec: 120, ewmaAlpha: 0.2, initialEstimateMin: 12, defaultBookedCapacity: 10, defaultWalkinCapacity: 5,
    });
    expect((await getLatestPolicy(pool))!.version).toBe(1);
    expect(await getPolicyByVersion(pool, 99)).toBeNull();
    expect(await listDoctors(pool, { activeOnly: true })).toHaveLength(10);

    const hits = await searchPatients(pool, 'ramesh');
    expect(hits.map((h) => h.fullName)).toContain('Ramesh Kumar');
    expect((await searchPatients(pool, 'BLR-000002'))[0]!.fullName).toBe('Sunita Devi');
    const phone = hits[0]!.phone!;
    expect((await searchPatients(pool, phone.slice(-6))).some((h) => h.id === hits[0]!.id)).toBe(true);
    expect(await searchPatients(pool, '%')).toEqual([]); // wildcard is escaped, not a match-all
    expect(hits[0]!.hasLogin).toBe(true);
    expect((await searchPatients(pool, 'Chandrashekar'))[0]!.hasLogin).toBe(false);
  });

  it('createPatient generates sequential MRNs like BLR-001000', async () => {
    const [a, b] = await withTransaction(pool, async (tx) => [
      await createPatient(tx, { fullName: 'Walk In One', phone: '+91 9800000001', dateOfBirth: '1990-05-17' }),
      await createPatient(tx, { fullName: 'Walk In Two' }),
    ]);
    expect(a!.mrn).toMatch(/^BLR-\d{6}$/);
    expect(Number(b!.mrn.slice(4))).toBe(Number(a!.mrn.slice(4)) + 1);
    expect(a).toMatchObject({ fullName: 'Walk In One', dateOfBirth: '1990-05-17', hasLogin: false });
    expect(await getPatient(pool, a!.id)).toEqual(a);
  });

  it('service estimates: absent until first upsert, then updated in place', async () => {
    const d = (await listDoctors(pool))[0]!;
    expect(await getServiceEstimate(pool, d.id)).toBeNull();
    await withTransaction(pool, (tx) => upsertServiceEstimate(tx, { doctorId: d.id, meanMinutes: 12, samples: 0 }));
    const e = await withTransaction(pool, (tx) => upsertServiceEstimate(tx, { doctorId: d.id, meanMinutes: 11.2, samples: 1 }));
    expect(e).toMatchObject({ meanMinutes: 11.2, samples: 1 });
    expect(await getServiceEstimate(pool, d.id)).toEqual(e);
  });

  it('users by id round-trip', async () => {
    const u = (await getUserByEmail(pool, 'patient@hqms.test'))!;
    expect(await getUserById(pool, u.id)).toEqual(u);
    expect(await getUserByEmail(pool, 'nobody@hqms.test')).toBeNull();
  });
});
