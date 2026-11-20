/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
/* PR-41: POST /sessions refuses a session that overlaps another session of the same doctor (any status). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, SessionOverlap } from '@hqms/contracts';
import { type Client, type TestApp, createTestApp, doctorId, loginAs, nextFutureDate } from './helpers.js';

let t: TestApp;
let admin: Client;
let doctorUser: Client;

beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t.server, 'admin@hqms.test');
  doctorUser = await loginAs(t.server, 'doctor8@hqms.test');
});
afterAll(() => t.close());

const iso = (date: string, hhmm: string) => `${date}T${hhmm}:00+05:30`;
const create = (doctor: number, date: string, from: string, to: string, label: 'morning' | 'afternoon' | 'evening' = 'morning') =>
  admin.post('/sessions', { doctorId: doctorId(doctor), sessionDate: date, label, startsAt: iso(date, from), endsAt: iso(date, to) }, null);

describe('PR-41 session overlap', () => {
  it('refuses a partial overlap with 409 CONFLICT and SessionOverlap details; the rejected session is not created', async () => {
    const date = nextFutureDate();
    const first = await create(8, date, '08:35', '10:35');
    expect(first.status).toBe(201);
    const res = await create(8, date, '09:00', '13:00');
    expect(res.status).toBe(409);
    expect(ApiError.parse(res.body).error.code).toBe('CONFLICT');
    expect(SessionOverlap.parse(ApiError.parse(res.body).error.details)).toMatchObject({
      reason: 'SESSION_OVERLAP',
      overlappingSessionId: first.body.id,
      startsAt: new Date(iso(date, '08:35')).toISOString(),
      endsAt: new Date(iso(date, '10:35')).toISOString(),
    });
    const n = await t.pool.query(`SELECT count(*)::int AS n FROM sessions WHERE doctor_id = $1 AND session_date = $2`, [doctorId(8), date]);
    expect(n.rows[0]!.n).toBe(1);
  });

  it('refuses a session inside, around, or ending/starting one minute into another; allows touching ends', async () => {
    const date = nextFutureDate();
    expect((await create(8, date, '09:00', '13:00')).status).toBe(201);
    expect((await create(8, date, '10:30', '11:30')).status).toBe(409); // inside
    expect((await create(8, date, '08:00', '14:00')).status).toBe(409); // around
    expect((await create(8, date, '12:59', '15:00')).status).toBe(409); // one minute in
    expect((await create(8, date, '07:00', '09:01')).status).toBe(409);
    expect((await create(8, date, '13:00', '17:00', 'afternoon')).status).toBe(201); // touching after
    expect((await create(8, date, '05:00', '09:00')).status).toBe(201); // touching before
  });

  it('overlap is per doctor: another doctor may run at the same time', async () => {
    const date = nextFutureDate();
    expect((await create(8, date, '09:00', '13:00')).status).toBe(201);
    expect((await create(9, date, '09:00', '13:00')).status).toBe(201);
  });

  it('a closed or unavailable session still counts (it occupied that time)', async () => {
    const date = nextFutureDate();
    const a = await create(8, date, '09:00', '13:00');
    expect((await doctorUser.post(`/sessions/${a.body.id}/unavailable`, { reason: 'Emergency surgery' })).status).toBe(200);
    expect((await create(8, date, '10:00', '12:00')).status).toBe(409);
    expect((await admin.post(`/sessions/${a.body.id}/close`, {})).status).toBe(200);
    expect((await create(8, date, '10:00', '12:00')).status).toBe(409);
  });

  it('parallel overlapping creates: exactly one wins (doctor lock)', async () => {
    const date = nextFutureDate();
    const results = await Promise.all([
      create(8, date, '09:00', '12:00'),
      create(8, date, '10:00', '13:00'),
      create(8, date, '11:00', '14:00'),
      create(8, date, '09:30', '10:30'),
    ]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
  });

  it('the seeded demo days contain no overlapping sessions for any doctor', async () => {
    const r = await t.pool.query(
      `SELECT a.doctor_id FROM sessions a JOIN sessions b
         ON a.doctor_id = b.doctor_id AND a.id < b.id AND a.starts_at < b.ends_at AND b.starts_at < a.ends_at
        WHERE a.session_date < '2039-01-01' LIMIT 1`,
    );
    expect(r.rows).toEqual([]);
  });
});
