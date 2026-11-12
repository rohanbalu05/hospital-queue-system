/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, Me } from '@hqms/contracts';
import { RolesGuard } from '../src/identity/auth.guard.js';
import { Roles } from '../src/identity/auth.decorators.js';
import { LoginRateLimiter } from '../src/identity/rate-limiter.js';
import {
  type Client,
  createTestApp,
  doctorId,
  loginAs,
  makeSession,
  newPatient,
  patientId,
  type TestApp,
} from './helpers.js';

let t: TestApp;
let patient: Client;
let reception: Client;
let reception3: Client;
let admin: Client;
let doctor: Client;

beforeAll(async () => {
  t = await createTestApp();
  patient = await loginAs(t.server, 'patient@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  reception3 = await loginAs(t.server, 'reception3@hqms.test'); // doctors 3 and 4 only
  admin = await loginAs(t.server, 'admin@hqms.test');
  doctor = await loginAs(t.server, 'doctor@hqms.test');
});
afterAll(async () => {
  await t.close();
});

describe('FR-01 identity', () => {
  it('login sets an httpOnly SameSite=Lax session cookie and /me returns the contract Me', async () => {
    const res = await request(t.server).post('/auth/login').send({ email: 'doctor@hqms.test', password: 'demo1234' });
    expect(res.status).toBe(200);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/^hqms_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(res.headers['x-correlation-id']).toBeTruthy();
    const me = Me.parse(res.body);
    expect(me.role).toBe('doctor');
    expect(me.doctorId).toBe(doctorId(1));
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash|token/i);

    const who = await doctor.get('/me');
    expect(who.status).toBe(200);
    expect(Me.parse(who.body).email).toBe('doctor@hqms.test');
  });

  it('only the SHA-256 of the cookie token is stored', async () => {
    const stored = await t.pool.query<{ token_hash: string }>(`SELECT token_hash FROM auth_sessions`);
    const raw = patient.cookie.split('=')[1]!;
    expect(stored.rows.length).toBeGreaterThan(0);
    expect(stored.rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash))).toBe(true);
    expect(stored.rows.some((r) => r.token_hash === raw)).toBe(false);
  });

  it('bad credentials get one generic 401 whether or not the account exists', async () => {
    const wrong = await request(t.server)
      .post('/auth/login')
      .send({ email: 'doctor@hqms.test', password: 'nope-nope' });
    const unknown = await request(t.server)
      .post('/auth/login')
      .send({ email: 'nobody@hqms.test', password: 'nope-nope' });
    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401);
      const body = ApiError.parse(res.body);
      expect(body.error.code).toBe('UNAUTHENTICATED');
      expect(body.error.correlationId).toBeTruthy();
    }
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('malformed login body is a 400 VALIDATION_FAILED that does not echo the input', async () => {
    const res = await request(t.server)
      .post('/auth/login')
      .send({ email: 'not-an-email', password: 'secret-value-123' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(res.body)).not.toContain('secret-value-123');
    const bad = await request(t.server).post('/auth/login').set('Content-Type', 'application/json').send('{"email":');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('logout revokes the session', async () => {
    const c = await loginAs(t.server, 'patient3@hqms.test');
    expect((await c.get('/me')).status).toBe(200);
    const out = await request(t.server).post('/auth/logout').set('Cookie', c.cookie);
    expect(out.status).toBe(204);
    expect((await c.get('/me')).status).toBe(401);
  });

  it('every route except login, logout and health needs a session (default deny)', async () => {
    const probes: Array<[string, string]> = [
      ['get', '/me'],
      ['get', '/doctors'],
      ['get', '/sessions'],
      ['get', '/policies/current'],
      ['get', '/patients?q=a'],
      ['get', '/appointments'],
      ['post', '/appointments'],
      ['post', '/patients'],
    ];
    for (const [method, path] of probes) {
      const res = await (request(t.server) as unknown as Record<string, (p: string) => request.Test>)[method]!(path);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
    const health = await request(t.server).get('/health');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok', db: 'up' });
  });

  it('a route that declares no roles is refused', () => {
    class Probe {
      declared() {}
      forgotten() {}
    }
    Roles('admin')(Probe.prototype, 'declared', Object.getOwnPropertyDescriptor(Probe.prototype, 'declared')!);
    const guard = new RolesGuard(new Reflector());
    const ctx = (handler: () => void, role: string): ExecutionContext =>
      ({
        getHandler: () => handler,
        getClass: () => Probe,
        switchToHttp: () => ({ getRequest: () => ({ user: { role }, method: 'GET', path: '/x' }) }),
      }) as unknown as ExecutionContext;
    expect(guard.canActivate(ctx(Probe.prototype.declared, 'admin'))).toBe(true);
    expect(() => guard.canActivate(ctx(Probe.prototype.declared, 'patient'))).toThrow();
    expect(() => guard.canActivate(ctx(Probe.prototype.forgotten, 'admin'))).toThrow();
  });

  it('login attempts per address+email are limited', () => {
    const limiter = new LoginRateLimiter(3, 60_000);
    const key = '1.2.3.4|a@b.c';
    for (let i = 0; i < 3; i++) {
      expect(limiter.retryAfterSec(key, 1000)).toBe(0);
      limiter.recordFailure(key, 1000);
    }
    expect(limiter.retryAfterSec(key, 2000)).toBeGreaterThan(0);
    expect(limiter.retryAfterSec('1.2.3.4|other@b.c', 2000)).toBe(0);
    expect(limiter.retryAfterSec(key, 62_000)).toBe(0);
    limiter.recordFailure(key, 62_000);
    limiter.recordSuccess(key);
    expect(limiter.retryAfterSec(key, 62_500)).toBe(0);
  });
});

describe('FR-01-a a patient never sees another patient', () => {
  it("another patient's appointment, patient record and lists answer 404, not 403", async () => {
    const theirs = await t.pool.query<{ id: string }>(`SELECT id FROM appointments WHERE patient_id = $1 LIMIT 1`, [
      patientId(2),
    ]);
    expect(theirs.rows.length).toBeGreaterThan(0);
    const id = theirs.rows[0]!.id;

    const appt = await patient.get(`/appointments/${id}`);
    expect(appt.status).toBe(404);
    expect(appt.body.error.code).toBe('NOT_FOUND');
    // Same answer as for an id that does not exist: existence is not disclosed.
    const missing = await patient.get('/appointments/00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).toBe(appt.body.error.message);

    expect((await patient.get(`/patients/${patientId(2)}`)).status).toBe(404);
    expect((await patient.get(`/appointments?patientId=${patientId(2)}`)).status).toBe(404);
    expect((await patient.post(`/appointments/${id}/cancel`, {})).status).toBe(404);
    expect((await patient.post(`/appointments/${id}/reschedule`, { targetSessionId: doctorId(1) })).status).toBe(404);

    const own = await patient.get(`/patients/${patientId(1)}`);
    expect(own.status).toBe(200);
  });

  it('the appointment list of a patient contains only their own', async () => {
    const list = await patient.get('/appointments');
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThan(0);
    for (const a of list.body as Array<{ patientId: string }>) expect(a.patientId).toBe(patientId(1));
  });

  it('a patient cannot book for someone else', async () => {
    const s = await makeSession(admin);
    const res = await patient.post('/appointments', { sessionId: s.id, patientId: patientId(2) });
    expect(res.status).toBe(404);
  });
});

describe('role matrix', () => {
  it('a patient cannot admit walk-ins, register patients, search patients or change sessions', async () => {
    const s = await makeSession(admin);
    expect((await patient.post(`/sessions/${s.id}/walk-ins`, { patientId: patientId(1) })).status).toBe(403);
    expect((await patient.post('/patients', { fullName: 'Someone Else' })).status).toBe(403);
    expect((await patient.get('/patients?q=ramesh')).status).toBe(403);
    expect((await patient.patch(`/sessions/${s.id}/capacity`, { bookedCapacity: 1, walkinCapacity: 1 })).status).toBe(
      403,
    );
    const created = await patient.post('/sessions', {}, null);
    expect(created.status).toBe(403);
  });

  it('reception cannot change capacity or create sessions; a doctor cannot check anyone in', async () => {
    const s = await makeSession(admin);
    expect((await reception.patch(`/sessions/${s.id}/capacity`, { bookedCapacity: 1, walkinCapacity: 1 })).status).toBe(
      403,
    );
    expect((await reception.post('/sessions', {}, null)).status).toBe(403);
    expect((await doctor.post(`/sessions/${s.id}/walk-ins`, { patientId: patientId(1) })).status).toBe(403);
    expect((await doctor.post('/appointments', { sessionId: s.id, patientId: patientId(1) })).status).toBe(403);
  });

  it('reception not assigned to the doctor cannot check in, book, read or admit for that doctor', async () => {
    const s = await makeSession(admin, { doctor: 1 });
    const booked = await reception.post('/appointments', { sessionId: s.id, patientId: await newPatient(reception) });
    expect(booked.status).toBe(201);

    const checkIn = await reception3.post(`/appointments/${booked.body.id}/check-in`, {});
    expect(checkIn.status).toBe(403);
    expect(checkIn.body.error.code).toBe('FORBIDDEN');
    expect((await reception3.post('/appointments', { sessionId: s.id, patientId: patientId(20) })).status).toBe(403);
    expect((await reception3.post(`/sessions/${s.id}/walk-ins`, { patientId: patientId(20) })).status).toBe(403);
    expect((await reception3.get(`/appointments/${booked.body.id}`)).status).toBe(403);
    expect((await reception3.get(`/sessions/${s.id}`)).status).toBe(403);
    expect((await reception3.get(`/appointments?sessionId=${s.id}`)).status).toBe(403);

    // Nothing was created by the refused attempts.
    expect((await t.pool.query(`SELECT 1 FROM visits WHERE appointment_id = $1`, [booked.body.id])).rowCount).toBe(0);

    // The assigned reception and the admin can read it.
    expect((await reception.get(`/appointments/${booked.body.id}`)).status).toBe(200);
    expect((await admin.get(`/appointments/${booked.body.id}`)).status).toBe(200);
  });

  it('staff session lists are limited to their doctors; patients see only bookable sessions', async () => {
    const mine = await reception3.get('/sessions');
    expect(mine.status).toBe(200);
    const doctors = new Set((mine.body as Array<{ doctorId: string }>).map((s) => s.doctorId));
    expect([...doctors].sort()).toEqual([doctorId(3), doctorId(4)].sort());

    const all = await admin.get('/sessions');
    expect(new Set((all.body as Array<{ doctorId: string }>).map((s) => s.doctorId)).size).toBe(10);

    await t.pool.query(
      `UPDATE sessions SET status = 'closed' WHERE id = (SELECT id FROM sessions WHERE doctor_id = $1 ORDER BY starts_at LIMIT 1)`,
      [doctorId(5)],
    );
    const bookable = await patient.get('/sessions');
    for (const s of bookable.body as Array<{ status: string }>) expect(['scheduled', 'open']).toContain(s.status);
  });

  it('assisted registration works for reception, validates input and honours Idempotency-Key', async () => {
    const key = `reg-${Date.now()}-abcdef`;
    const a = await reception.post('/patients', { fullName: 'Walk In Patient', phone: '+91 9800000000' }, key);
    const b = await reception.post('/patients', { fullName: 'Walk In Patient', phone: '+91 9800000000' }, key);
    expect(a.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(a.body.hasLogin).toBe(false);
    expect(a.body.mrn).toMatch(/^BLR-\d{6}$/);
    expect((await reception.post('/patients', { fullName: 'X' })).status).toBe(400);

    const found = await reception.get('/patients?q=Walk%20In%20Patient');
    expect(found.status).toBe(200);
    expect((found.body as Array<{ id: string }>).some((p) => p.id === a.body.id)).toBe(true);
    expect((await patient.get(`/patients/${a.body.id}`)).status).toBe(404);
  });
});
