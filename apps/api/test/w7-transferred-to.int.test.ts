/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
/**
 * Polish defect 4: after reception moves a checked-in patient to another doctor, the original appointment reads
 * `transferredTo` (staff and the owning patient), so lists stop showing it as "Checked in" at the old doctor.
 * Sessions live in year 2121 so nothing else in the shared database interferes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Appointment, MoveAffectedResult } from '@hqms/contracts';
import { type Client, createTestApp, doctorId, loginAs, newLoginPatient, newPatient, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Client;
let reception: Client;

beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  await t.pool.query(`UPDATE queue_entries SET state = 'skipped', skipped_at = now() WHERE state IN ('called','in_service')`);
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => t.clock.reset());

const ist = (date: string, hhmm: string): Date => new Date(`${date}T${hhmm}:00+05:30`);

async function mk(doctor: number, date: string): Promise<string> {
  const res = await admin.post(
    '/sessions',
    {
      doctorId: doctorId(doctor),
      sessionDate: date,
      label: 'morning',
      startsAt: ist(date, '09:00').toISOString(),
      endsAt: ist(date, '13:00').toISOString(),
      bookedCapacity: 10,
      walkinCapacity: 5,
    },
    null,
  );
  if (res.status !== 201) throw new Error(`could not create session: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}

describe('Appointment.transferredTo on reads', () => {
  it('is set for a patient moved to another doctor, for staff and the owner, and null for everyone else', async () => {
    const day = '2121-03-11';
    t.clock.set(ist(day, '08:00'));
    const S = await mk(1, day);
    const T = await mk(2, day);
    const moved = await newLoginPatient(t, reception, 'Polish Moved Patient');
    const stays = await newPatient(reception, 'Polish Staying Patient');
    const apMoved = Appointment.parse((await reception.post('/appointments', { sessionId: S, patientId: moved.id })).body);
    const apStays = Appointment.parse((await reception.post('/appointments', { sessionId: S, patientId: stays })).body);
    t.clock.set(ist(day, '08:55'));
    const ci = await reception.post(`/appointments/${apMoved.id}/check-in`, {});
    expect(ci.status).toBe(201);
    const ci2 = await reception.post(`/appointments/${apStays.id}/check-in`, {});
    expect(ci2.status).toBe(201);

    // before the move: nothing is set
    expect(Appointment.parse((await reception.get(`/appointments/${apMoved.id}`)).body).transferredTo ?? null).toBeNull();

    expect((await reception.post(`/sessions/${S}/unavailable`, { reason: 'Doctor unwell' })).status).toBe(200);
    const res = await reception.post(
      `/sessions/${S}/affected/move`,
      { targetSessionId: T, appointmentIds: [], queueEntryIds: [ci.body.queueEntryId] },
      'polish-transfer-0001',
    );
    expect(res.status).toBe(200);
    const out = MoveAffectedResult.parse(res.body);
    const token = out.results[0]!.token!;
    const doc = (await t.pool.query(`SELECT full_name, room FROM doctors WHERE id = $1`, [doctorId(2)])).rows[0]!;
    const doctorName = doc.full_name as string;
    const room = doc.room as string;

    const expected = { sessionId: T, doctorName, room, token };
    const asStaff = Appointment.parse((await reception.get(`/appointments/${apMoved.id}`)).body);
    expect(asStaff.status).toBe('checked_in');
    expect(asStaff.transferredTo).toEqual(expected);
    const asOwner = Appointment.parse((await moved.client.get(`/appointments/${apMoved.id}`)).body);
    expect(asOwner.transferredTo).toEqual(expected);

    // a list read carries it too; an appointment that did not move has null
    const list = (await reception.get(`/appointments?sessionId=${S}`)).body as unknown[];
    const byId = new Map(list.map((a) => Appointment.parse(a)).map((a) => [a.id, a]));
    expect(byId.get(apMoved.id)!.transferredTo).toEqual(expected);
    expect(byId.get(apStays.id)!.transferredTo ?? null).toBeNull();
  });
});
