/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Appointment } from '@hqms/contracts';
import { type Client, at, createTestApp, loginAs, makeSession, patientId, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Client;
let reception: Client;
let patient1: Client;
let patient2: Client;

beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  patient1 = await loginAs(t.server, 'patient@hqms.test');
  patient2 = await loginAs(t.server, 'patient2@hqms.test');
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => t.clock.reset());

describe('appointment reads (D-021)', () => {
  it('staff see patient name/MRN/phone and token after check-in; patients never see patient fields', async () => {
    const s = await makeSession(admin);
    const a1 = (await reception.post('/appointments', { sessionId: s.id, patientId: patientId(1) }))
      .body as Appointment;
    const a2 = (await reception.post('/appointments', { sessionId: s.id, patientId: patientId(2) }))
      .body as Appointment;
    t.clock.set(at(s, -5));
    expect((await reception.post(`/appointments/${a1.id}/check-in`, {})).status).toBe(201);

    const list = await reception.get(`/appointments?sessionId=${s.id}`);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    const rows = (list.body as Appointment[]).map((r) => Appointment.parse(r));
    const r1 = rows.find((r) => r.id === a1.id)!;
    const r2 = rows.find((r) => r.id === a2.id)!;
    expect(r1.patientName).toBe('Ramesh Kumar');
    expect(r1.patientMrn).toMatch(/\S/);
    expect(r1.queueEntryId).toBeTruthy();
    expect(r1.token).toBe('A-001');
    expect(r2.patientName).toBe('Sunita Devi');
    expect(r2.queueEntryId).toBeNull();
    expect(r2.token).toBeNull();

    const one = await reception.get(`/appointments/${a1.id}`);
    expect(one.body.patientName).toBe('Ramesh Kumar');

    // Patient 1: own appointment carries the token but no patient fields; patient 2's data is not reachable.
    const own = await patient1.get(`/appointments/${a1.id}`);
    expect(own.status).toBe(200);
    expect(own.body.token).toBe('A-001');
    expect(own.body.queueEntryId).toBeTruthy();
    for (const k of ['patientName', 'patientMrn', 'patientPhone']) expect(own.body).not.toHaveProperty(k);
    expect((await patient1.get(`/appointments/${a2.id}`)).status).toBe(404);
    const mine = await patient1.get(`/appointments?patientId=${patientId(1)}`);
    expect(mine.status).toBe(200);
    expect(JSON.stringify(mine.body)).not.toContain('Sunita Devi');
    expect(JSON.stringify(mine.body)).not.toContain('Ramesh Kumar');
    expect((await patient2.get(`/appointments?patientId=${patientId(1)}`)).status).toBe(404);
  });
});
