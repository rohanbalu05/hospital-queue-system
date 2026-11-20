/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
/**
 * B4.4 / D-035: a slot is assignable only if `slot + lateGraceMin >= now + MIN_ARRIVAL_WINDOW_MIN` (10 min), so the
 * patient has at least 10 minutes to arrive before the slot is marked Missed. Session 09:00-13:00, 20-minute slots.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SlotAvailability, type Appointment } from '@hqms/contracts';
import { type Client, at, createTestApp, loginAs, makeSession, newPatient, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Client;
let reception: Client;

beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => t.clock.reset());

const plusSec = (d: Date, sec: number): Date => new Date(d.getTime() + sec * 1000);

describe('B4.4 minimum arrival window', () => {
  it('10:44:30 -> 10:40 (10:55 >= 10:54:30)', async () => {
    const s = await makeSession(admin);
    t.clock.set(plusSec(at(s, 104), 30));
    const p = await newPatient(reception);
    const res = await reception.post('/appointments', { sessionId: s.id, patientId: p });
    expect(res.status).toBe(201);
    expect(new Date((res.body as Appointment).scheduledAt).getTime()).toBe(at(s, 100).getTime());
  });

  it('10:45:00 -> 10:40 (10:55 >= 10:55, boundary is inclusive)', async () => {
    const s = await makeSession(admin);
    t.clock.set(at(s, 105));
    const p = await newPatient(reception);
    const res = await reception.post('/appointments', { sessionId: s.id, patientId: p });
    expect(res.status).toBe(201);
    expect(new Date((res.body as Appointment).scheduledAt).getTime()).toBe(at(s, 100).getTime());
  });

  it('10:46 -> 11:00 (the 10:40 slot would be Missed within 9 minutes)', async () => {
    const s = await makeSession(admin);
    t.clock.set(at(s, 106));
    const p = await newPatient(reception);
    const res = await reception.post('/appointments', { sessionId: s.id, patientId: p });
    expect(res.status).toBe(201);
    expect(new Date((res.body as Appointment).scheduledAt).getTime()).toBe(at(s, 120).getTime());
  });

  it('reschedule uses the same rule', async () => {
    const from = await makeSession(admin, { doctor: 1 });
    const to = await makeSession(admin, { doctor: 2 });
    const p = await newPatient(reception);
    const booked = await reception.post('/appointments', { sessionId: from.id, patientId: p });
    expect(booked.status).toBe(201);
    t.clock.set(at(to, 106));
    const res = await reception.post(`/appointments/${booked.body.id}/reschedule`, {
      targetSessionId: to.id,
      expectedVersion: booked.body.version,
    });
    expect(res.status).toBe(201);
    expect(new Date((res.body as Appointment).scheduledAt).getTime()).toBe(at(to, 120).getTime());
  });

  it('GET /sessions/{id}/slots marks past and too-late slots unavailable', async () => {
    const s = await makeSession(admin);
    t.clock.set(at(s, 106)); // 10:46
    const slots = SlotAvailability.parse((await reception.get(`/sessions/${s.id}/slots`)).body).slots;
    const byTime = new Map(slots.map((x) => [new Date(x.scheduledAt).getTime(), x.available]));
    expect(byTime.get(at(s, 0).getTime())).toBe(false); // 09:00, long gone
    expect(byTime.get(at(s, 100).getTime())).toBe(false); // 10:40: 10:55 < 10:56
    expect(byTime.get(at(s, 120).getTime())).toBe(true); // 11:00
    t.clock.set(at(s, 105)); // 10:45: 10:40 still assignable
    const again = SlotAvailability.parse((await reception.get(`/sessions/${s.id}/slots`)).body).slots;
    expect(again.find((x) => new Date(x.scheduledAt).getTime() === at(s, 100).getTime())!.available).toBe(true);
    expect(again.find((x) => new Date(x.scheduledAt).getTime() === at(s, 80).getTime())!.available).toBe(false);
  });
});
