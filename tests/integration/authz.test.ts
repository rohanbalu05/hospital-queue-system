/**
 * NFR-06 authorization suite (black box, real HTTP + real PostgreSQL).
 *
 *  1. Cross-patient: patient@hqms.test against patient2's resources, and the reverse. Expected 403/404 and an
 *     identical database fingerprint afterwards (zero side effects).
 *  2. Role matrix: every route derived from the Nest controllers x every role. A role outside the route's
 *     @Roles must get 403; a role inside must never get 401/403/5xx.
 *  3. Assignment: reception3 (doctors 3,4) and doctor@ (doctor 1) against resources of doctors outside their scope.
 *  4. Anonymous: every non-public route answers 401, with no cookie and with a forged cookie.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anonymous, ApiClient } from '../support/client.js';
import { AUTHZ_RESULTS_FILE, recordResult } from '../support/results.js';
import { fillPath, listRoutes, type RoleName } from '../support/routes.js';
import {
  apiUrl,
  closePool,
  dbFingerprint,
  doctorId as doctorIdOf,
  loginAs,
  makeFutureSession,
  makeTodaySession,
  seededPatientId,
  sqlRows,
} from '../support/world.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Entry {
  category: 'cross-patient' | 'role-matrix' | 'assignment' | 'anonymous' | 'positive-control';
  actor: string;
  request: string;
  expected: string;
  /** True when the request must be refused (401/403/404); false for positive controls and shape checks. */
  expectDenied: boolean;
  status: number;
  sideEffects: boolean;
  ok: boolean;
}
const matrix: Entry[] = [];

let admin: ApiClient;
let reception: ApiClient;
let reception3: ApiClient;
let doctor1: ApiClient;
let followup: ApiClient;
let patient1: ApiClient;
let patient2: ApiClient;
let P1: string;
let P2: string;
let S1: string; // doctor 1, future
let S3: string; // doctor 3, future
let S3b: string; // doctor 3, future (reschedule target)
let A1: string; // patient1 in S1
let A2: string; // patient2 in S3

async function attempt(
  category: Entry['category'],
  actor: string,
  client: ApiClient,
  method: string,
  path: string,
  body: unknown,
  allowed: number[] | ((s: number) => boolean),
  expectedLabel: string,
): Promise<{ status: number; body: any }> {
  const before = await dbFingerprint();
  const res = await client.request(method, path, method === 'GET' ? {} : { body: body ?? {} });
  const after = await dbFingerprint();
  const okStatus = typeof allowed === 'function' ? allowed(res.status) : allowed.includes(res.status);
  const entry: Entry = {
    category,
    actor,
    request: `${method} ${path}`,
    expected: expectedLabel,
    expectDenied: category !== 'positive-control' && /^(40[134]|403\|404)/.test(expectedLabel),
    status: res.status,
    sideEffects: before !== after,
    ok: okStatus && before === after,
  };
  matrix.push(entry);
  expect(res.status, `${actor} ${method} ${path}: expected ${expectedLabel}`).toSatisfy(() => okStatus);
  expect(before === after, `${actor} ${method} ${path}: database changed`).toBe(true);
  return res;
}

const denied = (s: number) => s === 403 || s === 404;

beforeAll(async () => {
  [admin, reception, reception3, doctor1, followup, patient1, patient2] = await Promise.all([
    loginAs('admin@hqms.test'),
    loginAs('reception@hqms.test'),
    loginAs('reception3@hqms.test'),
    loginAs('doctor@hqms.test'),
    loginAs('followup@hqms.test'),
    loginAs('patient@hqms.test'),
    loginAs('patient2@hqms.test'),
  ]);
  const [m1, m2] = await Promise.all([patient1.get('/me'), patient2.get('/me')]);
  P1 = m1.body.patientId;
  P2 = m2.body.patientId;
  expect(P1).toBe(seededPatientId(1));
  expect(P2).toBe(seededPatientId(2));
  S1 = (await makeFutureSession(admin, { doctor: 1 })).id;
  S3 = (await makeFutureSession(admin, { doctor: 3 })).id;
  S3b = (await makeFutureSession(admin, { doctor: 3 })).id;
  const a1 = await patient1.post('/appointments', { sessionId: S1 });
  const a2 = await patient2.post('/appointments', { sessionId: S3 });
  expect(a1.status).toBe(201);
  expect(a2.status).toBe(201);
  A1 = a1.body.id;
  A2 = a2.body.id;
}, 120_000);

afterAll(async () => {
  const unauthorizedSuccesses = matrix.filter((e) => e.expectDenied && e.status >= 200 && e.status < 300).length;
  const summary = {
    totalChecks: matrix.filter((e) => e.status !== 0).length,
    skippedChecks: matrix.filter((e) => e.status === 0).length,
    byCategory: Object.fromEntries(
      [...new Set(matrix.map((e) => e.category))].map((c) => [c, matrix.filter((e) => e.category === c).length]),
    ),
    crossPatientAttempts: matrix.filter((e) => e.category === 'cross-patient' && e.expectDenied).length,
    crossPatientShapeChecks: matrix.filter((e) => e.category === 'cross-patient' && !e.expectDenied && e.status !== 0)
      .length,
    deniedExpectedTotal: matrix.filter((e) => e.expectDenied).length,
    unauthorizedSuccesses,
    attemptsWithSideEffects: matrix.filter((e) => e.sideEffects).length,
    failedChecks: matrix.filter((e) => !e.ok).length,
  };
  recordResult('summary', summary, AUTHZ_RESULTS_FILE);
  recordResult('matrix', matrix, AUTHZ_RESULTS_FILE);
  await closePool();
});

describe('NFR-06 cross-patient access', () => {
  it('patient@ cannot read, change or book into patient2 resources (and the reverse), with zero side effects', async () => {
    const dirs: Array<{ name: string; c: ApiClient; theirAppt: string; theirPatient: string; mySession: string }> = [
      { name: 'patient@ -> patient2', c: patient1, theirAppt: A2, theirPatient: P2, mySession: S1 },
      { name: 'patient2@ -> patient', c: patient2, theirAppt: A1, theirPatient: P1, mySession: S3 },
    ];
    for (const d of dirs) {
      await attempt('cross-patient', d.name, d.c, 'GET', `/appointments/${d.theirAppt}`, null, denied, '403|404');
      await attempt(
        'cross-patient',
        d.name,
        d.c,
        'GET',
        `/appointments/${d.theirAppt.toUpperCase()}`,
        null,
        denied,
        '403|404 (upper-case id)',
      );
      await attempt(
        'cross-patient',
        d.name,
        d.c,
        'GET',
        `/appointments?patientId=${d.theirPatient}`,
        null,
        denied,
        '403|404',
      );
      await attempt(
        'cross-patient',
        d.name,
        d.c,
        'GET',
        `/appointments?patientId=${d.theirPatient}&sessionId=${d.mySession}`,
        null,
        denied,
        '403|404',
      );
      await attempt('cross-patient', d.name, d.c, 'GET', `/patients/${d.theirPatient}`, null, denied, '403|404');
      await attempt(
        'cross-patient',
        d.name,
        d.c,
        'POST',
        `/appointments/${d.theirAppt}/cancel`,
        { reason: 'not mine' },
        denied,
        '403|404',
      );
      await attempt(
        'cross-patient',
        d.name,
        d.c,
        'POST',
        `/appointments/${d.theirAppt}/reschedule`,
        { targetSessionId: S3b },
        denied,
        '403|404',
      );
      await attempt(
        'cross-patient',
        d.name,
        d.c,
        'POST',
        `/appointments/${d.theirAppt}/check-in`,
        {},
        denied,
        '403|404 (staff route)',
      );
      await attempt(
        'cross-patient',
        d.name,
        d.c,
        'POST',
        '/appointments',
        { sessionId: S3b, patientId: d.theirPatient },
        denied,
        '403|404 (book for other patient)',
      );
    }
    // Rescheduling the other patient's appointment into a session the caller could otherwise use.
    await attempt(
      'cross-patient',
      'patient@ -> patient2',
      patient1,
      'POST',
      `/appointments/${A2}/reschedule`,
      { targetSessionId: S1 },
      denied,
      '403|404',
    );

    // The appointment list of a patient never contains another patient's rows.
    for (const [name, c, mine] of [
      ['patient@', patient1, P1],
      ['patient2@', patient2, P2],
    ] as const) {
      const noFilter = await c.get('/appointments');
      const bySession = await c.get(`/appointments?sessionId=${mine === P1 ? S3 : S1}`);
      for (const res of [noFilter, bySession]) {
        expect([200, 400]).toContain(res.status);
        if (res.status === 200) {
          expect(res.body.every((a: any) => a.patientId === mine)).toBe(true);
          matrix.push({
            category: 'cross-patient',
            actor: name,
            request: 'GET /appointments (list leak check)',
            expected: '200 with only own rows',
            expectDenied: false,
            status: res.status,
            sideEffects: false,
            ok: true,
          });
        }
      }
    }
  }, 120_000);

  it('a foreign appointment answers exactly like a nonexistent one (no existence disclosure)', async () => {
    const missing = await patient1.get('/appointments/00000000-0000-4000-8000-0000000000bb');
    const foreign = await patient1.get(`/appointments/${A2}`);
    expect(foreign.status).toBe(missing.status);
    expect(foreign.body.error.code).toBe(missing.body.error.code);
    expect(foreign.body.error.message).toBe(missing.body.error.message);
    const foreignPatient = await patient1.get(`/patients/${P2}`);
    const missingPatient = await patient1.get('/patients/00000000-0000-4000-8000-0000000000bb');
    expect(foreignPatient.status).toBe(missingPatient.status);
    expect(foreignPatient.body.error.code).toBe(missingPatient.body.error.code);
    matrix.push(
      {
        category: 'cross-patient',
        actor: 'patient@',
        request: 'GET /appointments/{foreign} vs {nonexistent}',
        expected: 'identical status and error body',
        expectDenied: false,
        status: foreign.status,
        sideEffects: false,
        ok: true,
      },
      {
        category: 'cross-patient',
        actor: 'patient@',
        request: 'GET /patients/{foreign} vs {nonexistent}',
        expected: 'identical status and error body',
        expectDenied: false,
        status: foreignPatient.status,
        sideEffects: false,
        ok: true,
      },
    );
  });

  const hasQueueRoute = listRoutes().some((r) => r.method === 'GET' && r.path === '/sessions/:id/queue');
  it.skipIf(!hasQueueRoute)(
    'GET /sessions/{id}/queue of a session where only patient2 has an entry is denied for patient@',
    async () => {
      const today = await makeTodaySession(admin, { doctor: 3 });
      const walkIn = await reception.post(`/sessions/${today.id}/walk-ins`, { patientId: P2 });
      expect(walkIn.status).toBe(201);
      await attempt(
        'cross-patient',
        'patient@ -> patient2',
        patient1,
        'GET',
        `/sessions/${today.id}/queue`,
        null,
        denied,
        '403|404',
      );
    },
  );
  if (!hasQueueRoute) {
    it('records that GET /sessions/{id}/queue is not implemented yet (skipped, not counted as passed)', () => {
      matrix.push({
        category: 'cross-patient',
        actor: 'patient@ -> patient2',
        request: 'GET /sessions/{id}/queue',
        expected: 'route not implemented in this build: skipped',
        expectDenied: false,
        status: 0,
        sideEffects: false,
        ok: true,
      });
      expect(hasQueueRoute).toBe(false);
    });
  }

  it('positive controls: each patient can use their own resources', async () => {
    for (const [name, c, appt, pid] of [
      ['patient@', patient1, A1, P1],
      ['patient2@', patient2, A2, P2],
    ] as const) {
      const a = await attempt(
        'positive-control',
        name,
        c,
        'GET',
        `/appointments/${appt}`,
        null,
        [200],
        '200 (own appointment)',
      );
      expect(a.body.patientId).toBe(pid);
      await attempt('positive-control', name, c, 'GET', `/patients/${pid}`, null, [200], '200 (own record)');
      await attempt(
        'positive-control',
        name,
        c,
        'GET',
        `/appointments?patientId=${pid}`,
        null,
        [200],
        '200 (own list)',
      );
    }
  });
});

describe('NFR-06 role matrix (derived from the Nest controllers)', () => {
  const routes = listRoutes();
  const roleClients = (): Array<[RoleName | 'reception3', ApiClient]> => [
    ['patient', patient1],
    ['reception', reception],
    ['reception3', reception3],
    ['doctor', doctor1],
    ['followup', followup],
    ['admin', admin],
  ];

  it('the route table was derived and the public set is exactly login, logout, health and the tokens-only display (FR-09)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(18);
    const publicRoutes = routes.filter((r) => r.roles === null).map((r) => `${r.method} ${r.path}`);
    expect(publicRoutes.sort()).toEqual([
      'GET /display/events',
      'GET /display/sessions',
      'GET /health',
      'POST /auth/login',
      'POST /auth/logout',
    ]);
    for (const needed of [
      'POST /sessions/:id/walk-ins',
      'POST /appointments/:id/check-in',
      'PATCH /sessions/:id/capacity',
      'POST /sessions',
      'GET /patients',
    ]) {
      expect(routes.map((r) => `${r.method} ${r.path}`)).toContain(needed);
    }
  });

  it("every role outside a route's @Roles gets 403; every role inside never gets 401/403/5xx", async () => {
    for (const route of routes.filter((r) => r.roles !== null)) {
      const path = fillPath(route.path);
      for (const [name, client] of roleClients()) {
        const role = (name === 'reception3' ? 'reception' : name) as RoleName;
        const allowedRole = (route.roles as RoleName[]).includes(role);
        if (allowedRole) {
          await attempt(
            'role-matrix',
            name,
            client,
            route.method,
            path,
            {},
            (s) => s !== 401 && s !== 403 && s < 500,
            'not 401/403/5xx',
          );
        } else {
          await attempt('role-matrix', name, client, route.method, path, {}, [403], '403');
        }
      }
    }
  }, 180_000);

  it('patients are refused on the staff routes named by NFR-06 (walk-ins, check-in, capacity, POST /sessions, patient search)', async () => {
    const date = '2041-01-01';
    const cases: Array<[string, string, unknown]> = [
      ['POST', `/sessions/${S1}/walk-ins`, { patientId: P1 }],
      ['POST', `/appointments/${A1}/check-in`, {}],
      ['PATCH', `/sessions/${S1}/capacity`, { bookedCapacity: 99, walkinCapacity: 99 }],
      [
        'POST',
        '/sessions',
        {
          doctorId: doctorIdOf(1),
          sessionDate: date,
          label: 'morning',
          startsAt: `${date}T09:00:00+05:30`,
          endsAt: `${date}T13:00:00+05:30`,
        },
      ],
      ['GET', '/patients?q=Sunita', null],
      ['POST', '/patients', { fullName: 'Intruder Patient' }],
    ];
    for (const [method, path, body] of cases) {
      await attempt('role-matrix', 'patient@', patient1, method, path, body, [403], '403');
    }
  });
});

describe('NFR-06 assignment scope', () => {
  it('reception3 (doctors 3 and 4) cannot act on doctor 1 resources; doctor@ cannot read doctor 3 resources', async () => {
    const r3 = 'reception3@';
    await attempt('assignment', r3, reception3, 'GET', `/appointments/${A1}`, null, [403], '403');
    await attempt('assignment', r3, reception3, 'POST', `/appointments/${A1}/cancel`, {}, [403], '403');
    await attempt(
      'assignment',
      r3,
      reception3,
      'POST',
      `/appointments/${A1}/reschedule`,
      { targetSessionId: S3 },
      [403],
      '403',
    );
    await attempt('assignment', r3, reception3, 'POST', `/appointments/${A1}/check-in`, {}, [403], '403');
    await attempt('assignment', r3, reception3, 'POST', `/sessions/${S1}/walk-ins`, { patientId: P2 }, [403], '403');
    await attempt(
      'assignment',
      r3,
      reception3,
      'POST',
      '/appointments',
      { sessionId: S1, patientId: P2 },
      [403],
      '403',
    );
    await attempt('assignment', r3, reception3, 'GET', `/sessions/${S1}`, null, [403], '403');
    await attempt('assignment', r3, reception3, 'GET', `/sessions/${S1}/slots`, null, [403], '403');
    await attempt('assignment', r3, reception3, 'GET', `/appointments?sessionId=${S1}`, null, [403], '403');
    // Reschedule an appointment inside scope (doctor 3) into a session outside scope (doctor 1).
    await attempt(
      'assignment',
      r3,
      reception3,
      'POST',
      `/appointments/${A2}/reschedule`,
      { targetSessionId: S1 },
      [403],
      '403',
    );

    // Lists are filtered by scope instead of leaking.
    const sessions = await reception3.get(`/sessions?doctorId=${doctorIdOf(1)}`);
    expect(sessions.status).toBe(200);
    expect(sessions.body).toEqual([]);
    const byPatient = await reception3.get(`/appointments?patientId=${P1}`);
    expect(byPatient.status).toBe(200);
    expect(byPatient.body.every((a: any) => a.doctorId !== doctorIdOf(1))).toBe(true);
    matrix.push(
      {
        category: 'assignment',
        actor: r3,
        request: 'GET /sessions?doctorId={doctor1} (list filtered)',
        expected: '200 empty',
        expectDenied: false,
        status: sessions.status,
        sideEffects: false,
        ok: true,
      },
      {
        category: 'assignment',
        actor: r3,
        request: 'GET /appointments?patientId={P1} (list filtered)',
        expected: '200 without doctor 1 rows',
        expectDenied: false,
        status: byPatient.status,
        sideEffects: false,
        ok: true,
      },
    );

    const d1 = 'doctor@ (doctor 1)';
    await attempt('assignment', d1, doctor1, 'GET', `/appointments/${A2}`, null, [403], '403');
    await attempt('assignment', d1, doctor1, 'GET', `/sessions/${S3}`, null, [403], '403');
    await attempt('assignment', d1, doctor1, 'GET', `/appointments?sessionId=${S3}`, null, [403], '403');
  }, 120_000);

  it('positive controls: in-scope staff can still read and act', async () => {
    await attempt(
      'positive-control',
      'reception3@',
      reception3,
      'GET',
      `/appointments/${A2}`,
      null,
      [200],
      '200 (own doctor)',
    );
    await attempt(
      'positive-control',
      'doctor@ (doctor 1)',
      doctor1,
      'GET',
      `/appointments/${A1}`,
      null,
      [200],
      '200 (own doctor)',
    );
    await attempt('positive-control', 'admin@', admin, 'GET', `/appointments/${A2}`, null, [200], '200 (all doctors)');
    const rows = await sqlRows(`SELECT 1 FROM appointments WHERE id IN ($1, $2)`, [A1, A2]);
    expect(rows).toHaveLength(2);
  });
});

describe('NFR-06 unauthenticated access', () => {
  it('every non-public route answers 401 without a cookie and with a forged cookie', async () => {
    const forged = new ApiClient(
      apiUrl(),
      'hqms_session=0000000000000000000000000000000000000000000000000000000000000000',
    );
    for (const route of listRoutes().filter((r) => r.roles !== null)) {
      const path = fillPath(route.path);
      await attempt('anonymous', 'anonymous', anonymous(apiUrl()), route.method, path, {}, [401], '401');
      await attempt('anonymous', 'forged cookie', forged, route.method, path, {}, [401], '401');
    }
  }, 120_000);
});
