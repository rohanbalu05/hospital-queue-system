/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
/* PR-42: admin staff lifecycle - create with a one-time temporary password, deactivate/activate, reset password. */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, Doctor, StaffCredentials, StaffMember } from '@hqms/contracts';
import { type Client, type TestApp, createTestApp, doctorId, loginAs, PASSWORD } from './helpers.js';

let t: TestApp;
let admin: Client;
let reception: Client;
let doctor1: Client;

beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  doctor1 = await loginAs(t.server, 'doctor@hqms.test');
});
afterAll(() => t.close());

const email = (p = 'w6') => `${p}-${randomUUID().slice(0, 8)}@hqms.test`;
const code = (b: unknown) => ApiError.parse(b).error.code;
const login = (e: string, password: string) => request(t.server).post('/auth/login').send({ email: e, password });

async function create(body: Record<string, unknown>, by: Client = admin) {
  return by.post('/admin/staff', body, null);
}
async function createOk(body: Record<string, unknown>): Promise<StaffCredentials> {
  const res = await create(body);
  expect(res.status).toBe(201);
  return StaffCredentials.parse(res.body);
}

describe('POST /admin/staff', () => {
  it('admin only', async () => {
    const body = { displayName: 'Nope Nope', email: email(), role: 'followup' };
    expect((await create(body, reception)).status).toBe(403);
    expect((await create(body, doctor1)).status).toBe(403);
    expect((await request(t.server).post('/admin/staff').send(body)).status).toBe(401);
  });

  it('creates a reception login with assignments and a one-time temporary password that works', async () => {
    const e = email('rec');
    const res = await createOk({ displayName: 'New Reception', email: e, role: 'reception', doctorIds: [doctorId(1), doctorId(2)] });
    expect(res.member).toMatchObject({ displayName: 'New Reception', email: e, role: 'reception', active: true, doctorId: null });
    expect([...res.member.doctorIds].sort()).toEqual([doctorId(1), doctorId(2)].sort());
    expect(res.temporaryPassword.length).toBeGreaterThanOrEqual(16);

    const ok = await login(e, res.temporaryPassword);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ role: 'reception', assignedDoctorIds: expect.arrayContaining([doctorId(1), doctorId(2)]) });

    // argon2 hash only; the password is nowhere in the database or the audit trail
    const row = (await t.pool.query(`SELECT password_hash, identity_provider FROM users WHERE lower(email) = $1`, [e])).rows[0]!;
    expect(row.password_hash).toMatch(/^\$argon2/);
    expect(row.password_hash).not.toContain(res.temporaryPassword);
    const audit = await t.pool.query(`SELECT * FROM audit_events WHERE operation = 'staff.create' AND entity_id = $1`, [res.member.userId]);
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows)).not.toContain(res.temporaryPassword);
    expect(audit.rows[0]!.actor_role).toBe('admin');
    // listed
    const list = ((await admin.get('/admin/staff')).body as unknown[]).map((m) => StaffMember.parse(m));
    expect(list.find((m) => m.userId === res.member.userId)).toMatchObject({ active: true, role: 'reception' });
  });

  it('every password is different and long; case-insensitive duplicate email is 409', async () => {
    const e = email('dup');
    const a = await createOk({ displayName: 'Dup One', email: e, role: 'followup' });
    const b = await createOk({ displayName: 'Dup Two', email: email('dup2'), role: 'followup' });
    expect(a.temporaryPassword).not.toBe(b.temporaryPassword);
    const again = await create({ displayName: 'Dup Three', email: e.toUpperCase(), role: 'followup' });
    expect(again.status).toBe(409);
    expect(code(again.body)).toBe('CONFLICT');
    expect((await create({ displayName: 'Dup Four', email: 'ADMIN@hqms.test', role: 'admin' })).status).toBe(409);
    // a retry with the same Idempotency-Key is NOT a replay: no stored password, so it is simply the same email again
    const key = randomUUID();
    const body = { displayName: 'Keyed One', email: email('key'), role: 'followup' };
    expect((await admin.post('/admin/staff', body, key)).status).toBe(201);
    expect((await admin.post('/admin/staff', body, key)).status).toBe(409);
    const stored = await t.pool.query(`SELECT 1 FROM idempotency_records WHERE operation LIKE 'staff.%' OR operation LIKE 'admin.%'`);
    expect(stored.rowCount).toBe(0);
  });

  it('a doctor login links an existing doctor record that has no login, or creates the doctor record', async () => {
    const lone = (
      await t.pool.query(
        `INSERT INTO doctors (hospital_id, full_name, department, room)
         SELECT hospital_id, 'Dr. Lone Star', 'General Medicine', 'OPD 77' FROM doctors LIMIT 1 RETURNING id`,
      )
    ).rows[0]!.id as string;
    const linked = await createOk({ displayName: 'Dr. Lone Star', email: email('doc'), role: 'doctor', doctorId: lone });
    expect(linked.member).toMatchObject({ role: 'doctor', doctorId: lone, doctorIds: [lone] });
    expect((await login(linked.member.email, linked.temporaryPassword)).body).toMatchObject({ doctorId: lone });

    // that doctor already has a login now; an unknown doctor does not exist
    expect((await create({ displayName: 'Second Login', email: email('doc'), role: 'doctor', doctorId: lone })).status).toBe(409);
    expect((await create({ displayName: 'Ghost Doctor', email: email('doc'), role: 'doctor', doctorId: randomUUID() })).status).toBe(404);
    // a seeded doctor already has a login
    expect((await create({ displayName: 'Seeded Again', email: email('doc'), role: 'doctor', doctorId: doctorId(3) })).status).toBe(409);

    const made = await createOk({ displayName: 'Dr. Fresh Start', email: email('doc'), role: 'doctor', newDoctor: { department: 'Cardiology', room: 'OPD 88' } });
    expect(made.member.doctorId).toBeTruthy();
    const doctors = ((await admin.get('/doctors')).body as unknown[]).map((d) => Doctor.parse(d));
    expect(doctors.find((d) => d.id === made.member.doctorId)).toMatchObject({ fullName: 'Dr. Fresh Start', department: 'Cardiology', room: 'OPD 88', active: true });

    // exactly one of doctorId / newDoctor
    expect((await create({ displayName: 'No Doctor', email: email('doc'), role: 'doctor' })).status).toBe(400);
    expect((await create({ displayName: 'Both', email: email('doc'), role: 'doctor', doctorId: lone, newDoctor: { department: 'ENT', room: 'OPD 1' } })).status).toBe(400);
  });

  it('refuses assignments for roles that have none, unknown doctors, and a doctor record on a non-doctor', async () => {
    expect((await create({ displayName: 'Admin Assigned', email: email(), role: 'admin', doctorIds: [doctorId(1)] })).status).toBe(400);
    expect((await create({ displayName: 'Bad Doctors', email: email(), role: 'reception', doctorIds: [randomUUID()] })).status).toBe(400);
    expect((await create({ displayName: 'Stray Doctor', email: email(), role: 'followup', doctorId: doctorId(1) })).status).toBe(400);
    expect((await create({ displayName: 'x', email: 'not-an-email', role: 'followup' })).status).toBe(400);
    expect((await create({ displayName: 'Patient Role', email: email(), role: 'patient' })).status).toBe(400);
  });
});

describe('deactivate, activate, reset password', () => {
  it('deactivate revokes sessions and blocks login; activate restores it; both audited; repeat is harmless', async () => {
    const e = email('life');
    const made = await createOk({ displayName: 'Life Cycle', email: e, role: 'followup' });
    const session = await loginAs(t.server, e, made.temporaryPassword);
    expect((await session.get('/me')).status).toBe(200);

    expect((await admin.post(`/admin/staff/${made.member.userId}/deactivate`, {}, null)).status).toBe(400); // reason required
    const off = await admin.post(`/admin/staff/${made.member.userId}/deactivate`, { reason: 'Left the hospital' }, null);
    expect(off.status).toBe(200);
    expect(StaffMember.parse(off.body)).toMatchObject({ active: false, userId: made.member.userId });
    expect((await session.get('/me')).status).toBe(401); // the open session is gone
    expect((await login(e, made.temporaryPassword)).status).toBe(401);
    const listed = ((await admin.get('/admin/staff')).body as unknown[]).map((m) => StaffMember.parse(m));
    expect(listed.find((m) => m.userId === made.member.userId)?.active).toBe(false);

    expect((await admin.post(`/admin/staff/${made.member.userId}/deactivate`, { reason: 'Left the hospital' }, null)).status).toBe(200);
    expect(
      Number((await t.pool.query(`SELECT count(*) FROM audit_events WHERE operation = 'staff.deactivate' AND entity_id = $1`, [made.member.userId])).rows[0]!.count),
    ).toBe(1);

    const on = await admin.post(`/admin/staff/${made.member.userId}/activate`, { reason: 'Returned from leave' }, null);
    expect(on.status).toBe(200);
    expect(StaffMember.parse(on.body).active).toBe(true);
    expect((await login(e, made.temporaryPassword)).status).toBe(200);
    expect(
      Number((await t.pool.query(`SELECT count(*) FROM audit_events WHERE operation = 'staff.activate' AND entity_id = $1`, [made.member.userId])).rows[0]!.count),
    ).toBe(1);
  });

  it('an admin cannot deactivate themself; reception and doctors cannot use these routes; patients are not staff', async () => {
    const me = (await admin.get('/me')).body.userId as string;
    const self = await admin.post(`/admin/staff/${me}/deactivate`, { reason: 'Oops' }, null);
    expect(self.status).toBe(409);
    expect(code(self.body)).toBe('CONFLICT');
    expect((await admin.get('/me')).status).toBe(200);

    const target = (await createOk({ displayName: 'Guarded Person', email: email(), role: 'followup' })).member.userId;
    expect((await reception.post(`/admin/staff/${target}/deactivate`, { reason: 'Nope nope' }, null)).status).toBe(403);
    expect((await doctor1.post(`/admin/staff/${target}/activate`, { reason: 'Nope nope' }, null)).status).toBe(403);
    expect((await doctor1.post(`/admin/staff/${target}/reset-password`, { reason: 'Nope nope' }, null)).status).toBe(403);

    const patientUser = (await t.pool.query(`SELECT id FROM users WHERE email = 'patient@hqms.test'`)).rows[0]!.id as string;
    expect((await admin.post(`/admin/staff/${patientUser}/deactivate`, { reason: 'Not staff' }, null)).status).toBe(404);
    expect((await admin.post(`/admin/staff/${randomUUID()}/deactivate`, { reason: 'Not there' }, null)).status).toBe(404);
  });

  it('the last active admin stays: an admin cannot deactivate themself, and others can be rotated out', async () => {
    // Make A the only active admin besides a second one B, then take B out by SQL and try to deactivate A as B's session.
    const a = await createOk({ displayName: 'Admin Alpha', email: email('adm'), role: 'admin' });
    const b = await createOk({ displayName: 'Admin Beta', email: email('adm'), role: 'admin' });
    const asB = await loginAs(t.server, b.member.email, b.temporaryPassword);
    const others = await t.pool.query(`SELECT id FROM users WHERE role = 'admin' AND active AND id NOT IN ($1, $2)`, [a.member.userId, b.member.userId]);
    const otherIds = others.rows.map((r) => r.id as string);
    try {
      await t.pool.query(`UPDATE users SET active = false WHERE id = ANY($1::uuid[])`, [otherIds]);
      // B deactivates A: allowed, B remains
      expect((await asB.post(`/admin/staff/${a.member.userId}/deactivate`, { reason: 'Rotating admins' }, null)).status).toBe(200);
      // B cannot deactivate B (self), and the guard also counts active admins: only B is left
      expect((await asB.post(`/admin/staff/${b.member.userId}/deactivate`, { reason: 'Rotating admins' }, null)).status).toBe(409);
      const active = await t.pool.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active`);
      expect(active.rows[0]!.n).toBe(1);
    } finally {
      await t.pool.query(`UPDATE users SET active = true WHERE id = ANY($1::uuid[])`, [otherIds]);
    }
  });

  it('reset-password returns new credentials, revokes sessions, and the old password stops working', async () => {
    const e = email('reset');
    const made = await createOk({ displayName: 'Reset Me', email: e, role: 'reception', doctorIds: [doctorId(1)] });
    const session = await loginAs(t.server, e, made.temporaryPassword);

    expect((await admin.post(`/admin/staff/${made.member.userId}/reset-password`, {}, null)).status).toBe(400);
    const res = await admin.post(`/admin/staff/${made.member.userId}/reset-password`, { reason: 'Forgot password' }, null);
    expect(res.status).toBe(200);
    const fresh = StaffCredentials.parse(res.body);
    expect(fresh.member.userId).toBe(made.member.userId);
    expect(fresh.temporaryPassword).not.toBe(made.temporaryPassword);
    expect(fresh.temporaryPassword.length).toBeGreaterThanOrEqual(16);

    expect((await session.get('/me')).status).toBe(401);
    expect((await login(e, made.temporaryPassword)).status).toBe(401);
    expect((await login(e, fresh.temporaryPassword)).status).toBe(200);

    const audit = await t.pool.query(`SELECT * FROM audit_events WHERE operation = 'staff.reset_password' AND entity_id = $1`, [made.member.userId]);
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows)).not.toContain(fresh.temporaryPassword);
    expect(JSON.stringify(audit.rows)).not.toContain(made.temporaryPassword);
    // nothing about passwords is stored for replay
    expect((await t.pool.query(`SELECT 1 FROM idempotency_records WHERE response_body::text LIKE $1`, [`%${fresh.temporaryPassword}%`])).rowCount).toBe(0);
  });

  it('assignments keep working for the new account (PUT /admin/staff/{id}/assignments)', async () => {
    const made = await createOk({ displayName: 'Assign Later', email: email(), role: 'followup' });
    const put = await request(t.server)
      .put(`/admin/staff/${made.member.userId}/assignments`)
      .set('Cookie', admin.cookie)
      .send({ doctorIds: [doctorId(4)] });
    expect(put.status).toBe(200);
    expect(StaffMember.parse(put.body).doctorIds).toEqual([doctorId(4)]);
  });
});

describe('local identity: a deactivated user cannot sign in', () => {
  it('a seeded user deactivated by SQL gets 401 with the right password', async () => {
    const e = email('sql');
    const made = await createOk({ displayName: 'Sql Off', email: e, role: 'followup' });
    await t.pool.query(`UPDATE users SET active = false WHERE id = $1`, [made.member.userId]);
    expect((await login(e, made.temporaryPassword)).status).toBe(401);
    expect((await login('admin@hqms.test', PASSWORD)).status).toBe(200);
  });
});
