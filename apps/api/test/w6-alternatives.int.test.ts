/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
/* PR-23: GET /sessions/{id}/alternatives - same-department sessions today with a free walk-in or booked place. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AlternativeSession, SESSION_ALTERNATIVES_LIMIT } from '@hqms/contracts';
import { type Client, type TestApp, createTestApp, doctorId, loginAs, nextFutureDate } from './helpers.js';

let t: TestApp;
let admin: Client;
let reception: Client; // all doctors
let reception2: Client; // doctors 1-2 (General Medicine)
let narrow: Client; // assigned to doctor 5 only (created below)
let doctor: Client;
let patient: Client;

beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  reception2 = await loginAs(t.server, 'reception2@hqms.test');
  doctor = await loginAs(t.server, 'doctor5@hqms.test');
  patient = await loginAs(t.server, 'patient@hqms.test');
  const email = `w6-narrow-${randomUUID().slice(0, 8)}@hqms.test`;
  const u = await t.pool.query(
    `INSERT INTO users (hospital_id, email, display_name, role, password_hash)
     SELECT hospital_id, $1, 'Narrow Reception', 'reception', password_hash FROM users WHERE email = 'reception@hqms.test' RETURNING id`,
    [email],
  );
  await t.pool.query(`INSERT INTO staff_assignments (user_id, doctor_id) VALUES ($1, $2)`, [u.rows[0]!.id, doctorId(5)]);
  narrow = await loginAs(t.server, email);
});
afterAll(() => t.close());
beforeEach(() => t.clock.reset());

const iso = (date: string, hhmm: string) => `${date}T${hhmm}:00+05:30`;
async function make(
  doc: number,
  date: string,
  from: string,
  to: string,
  caps: { booked?: number; walkin?: number } = {},
  label: 'morning' | 'afternoon' | 'evening' = 'morning',
) {
  const res = await admin.post(
    '/sessions',
    { doctorId: doctorId(doc), sessionDate: date, label, startsAt: iso(date, from), endsAt: iso(date, to), bookedCapacity: caps.booked ?? 10, walkinCapacity: caps.walkin ?? 5 },
    null,
  );
  if (res.status !== 201) throw new Error(`session: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}
const parse = (body: unknown) => (body as unknown[]).map((r) => AlternativeSession.parse(r));

describe('GET /sessions/{id}/alternatives (PR-23)', () => {
  it('lists other doctors of the department, today, in window; most free walk-in places first, then earliest', async () => {
    const date = nextFutureDate();
    const src = await make(5, date, '09:00', '13:00'); // ENT, the full one
    const a = await make(6, date, '09:00', '13:00', { walkin: 5 });
    const b = await make(6, date, '14:00', '18:00', { walkin: 8 }, 'afternoon');
    await make(6, date, '05:00', '08:00', { walkin: 9 }); // ended before "now"
    await make(5, date, '14:00', '18:00', { walkin: 9 }, 'afternoon'); // same doctor as the source: never offered
    await make(8, date, '09:00', '13:00', { walkin: 9 }); // Orthopaedics: another department
    const unavailable = await make(6, date, '18:30', '20:00', { walkin: 9 }, 'evening');
    const closed = await make(6, date, '20:30', '22:00', { walkin: 9 }, 'evening');
    await admin.post(`/sessions/${unavailable}/unavailable`, { reason: 'Away' });
    await admin.post(`/sessions/${closed}/close`, {});
    // another day: not today
    const other = nextFutureDate();
    await make(6, other, '09:00', '13:00', { walkin: 9 });

    t.clock.set(iso(date, '10:00'));
    const res = await reception.get(`/sessions/${src}/alternatives`);
    expect(res.status).toBe(200);
    const list = parse(res.body);
    expect(list.map((s) => s.sessionId)).toEqual([b, a]);
    expect(list[0]).toMatchObject({ doctorId: doctorId(6), department: 'ENT', walkinAvailable: 8, bookedAvailable: 10 });
    expect(list[1]).toMatchObject({ walkinAvailable: 5 });
    expect((await admin.get(`/sessions/${src}/alternatives`)).status).toBe(200);
  });

  it('a session with no free place at all is left out; one with only booked places is kept', async () => {
    const date = nextFutureDate();
    const src = await make(5, date, '09:00', '13:00');
    const full = await make(6, date, '09:00', '13:00', { booked: 0, walkin: 0 });
    const bookedOnly = await make(6, date, '14:00', '18:00', { booked: 6, walkin: 0 }, 'afternoon');
    t.clock.set(iso(date, '10:00'));
    const ids = parse((await reception.get(`/sessions/${src}/alternatives`)).body).map((s) => s.sessionId);
    expect(ids).toContain(bookedOnly);
    expect(ids).not.toContain(full);
  });

  it('is capped at SESSION_ALTERNATIVES_LIMIT', async () => {
    const date = nextFutureDate();
    const src = await make(5, date, '09:00', '13:00');
    const slices = ['10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30'];
    for (const [i, from] of slices.entries()) {
      const to = i + 1 < slices.length ? slices[i + 1]! : '15:00';
      await make(6, date, from, to, { walkin: 5 }, 'afternoon');
    }
    t.clock.set(iso(date, '10:00'));
    expect(parse((await reception.get(`/sessions/${src}/alternatives`)).body)).toHaveLength(SESSION_ALTERNATIVES_LIMIT);
  });

  it('reception sees only doctors in their scope; the source session must be in scope too', async () => {
    const date = nextFutureDate();
    const src = await make(5, date, '09:00', '13:00');
    await make(6, date, '09:00', '13:00');
    t.clock.set(iso(date, '10:00'));
    expect(parse((await narrow.get(`/sessions/${src}/alternatives`)).body)).toEqual([]); // doctor 6 is not theirs
    expect((await reception2.get(`/sessions/${src}/alternatives`)).status).toBe(403); // doctor 5 is not theirs
  });

  it('is for reception and admin only; unknown session is 404', async () => {
    const date = nextFutureDate();
    const src = await make(5, date, '09:00', '13:00');
    expect((await patient.get(`/sessions/${src}/alternatives`)).status).toBe(403);
    expect((await doctor.get(`/sessions/${src}/alternatives`)).status).toBe(403);
    expect((await reception.get(`/sessions/${randomUUID()}/alternatives`)).status).toBe(404);
  });
});
