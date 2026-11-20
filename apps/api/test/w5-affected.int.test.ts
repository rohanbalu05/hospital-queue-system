/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
/**
 * B3 (D-033): doctor unavailable for the rest of the session. Alternatives for one appointment, the affected
 * list for reception, one-click rebook through the existing reschedule path and the bulk move/transfer.
 *
 * Doctors 1 and 2 are both General Medicine; doctors 3 and 4 are Paediatrics. Sessions live on far-future days
 * (year 2120, 10 days apart per test) so nothing else in the shared database interferes with the lists.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AffectedPatients,
  ApiError,
  Appointment,
  AppointmentAlternatives,
  MoveAffectedResult,
  MyTodayVisit,
} from '@hqms/contracts';
import { capacityInvariant } from '@hqms/db';
import {
  type Client,
  capacityOf,
  count,
  createTestApp,
  doctorId,
  loginAs,
  newLoginPatient,
  newPatient,
  type TestApp,
} from './helpers.js';

let t: TestApp;
let admin: Client;
let reception: Client; // all doctors
let reception3: Client; // doctors 3 and 4 only

beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  reception3 = await loginAs(t.server, 'reception3@hqms.test');
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => t.clock.reset());

const code = (body: unknown): string => ApiError.parse(body).error.code;

let dayN = 0;
const nextDay = (): string => new Date(Date.UTC(2120, 0, 1 + 10 * ++dayN)).toISOString().slice(0, 10);
const addDays = (date: string, n: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const ist = (date: string, hhmm: string): Date => new Date(`${date}T${hhmm}:00+05:30`);

interface Sess {
  id: string;
  date: string;
  startsAt: string;
}
async function mk(
  doctor: number,
  date: string,
  o: { from?: string; to?: string; booked?: number; walkin?: number } = {},
): Promise<Sess> {
  const from = o.from ?? '09:00';
  const res = await admin.post(
    '/sessions',
    {
      doctorId: doctorId(doctor),
      sessionDate: date,
      label: 'morning',
      startsAt: ist(date, from).toISOString(),
      endsAt: ist(date, o.to ?? '13:00').toISOString(),
      bookedCapacity: o.booked ?? 10,
      walkinCapacity: o.walkin ?? 5,
    },
    null,
  );
  if (res.status !== 201) throw new Error(`could not create session: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.id as string, date, startsAt: ist(date, from).toISOString() };
}

async function book(s: Sess, patient: string): Promise<Appointment> {
  const res = await reception.post('/appointments', { sessionId: s.id, patientId: patient });
  if (res.status !== 201) throw new Error(`book failed: ${res.status} ${JSON.stringify(res.body)}`);
  return Appointment.parse(res.body);
}

const iso = (v: unknown): number => new Date(v as string).getTime();

describe('B3.1 GET /appointments/{id}/alternatives and one-click rebook', () => {
  it('lists other doctors of the same department with a free slot, today first then 7 days, earliest first', async () => {
    const day = nextDay();
    t.clock.set(ist(day, '08:00'));
    const source = await mk(1, day);
    const mine = await newLoginPatient(t, reception, 'Alt Patient');
    const appt = await book(source, mine.id);
    // candidates
    const today2 = await mk(2, day); // today, doctor 2: listed first
    const d2 = await mk(2, addDays(day, 2));
    const farOut = await mk(2, addDays(day, 8)); // beyond the 7-day window
    const full = await mk(2, addDays(day, 3), { booked: 0 }); // no booked place
    const otherDept = await mk(3, day); // Paediatrics
    const sameDoctor = await mk(1, addDays(day, 1)); // the affected doctor's own later session
    const ended = await mk(2, day, { from: '06:00', to: '07:30' }); // ended before 08:00
    // the affected doctor is away for the rest of the session
    expect((await reception.post(`/sessions/${source.id}/unavailable`, { reason: 'Doctor unwell' })).status).toBe(200);

    const res = await mine.client.get(`/appointments/${appt.id}/alternatives`);
    expect(res.status).toBe(200);
    const alt = AppointmentAlternatives.parse(res.body);
    expect(alt.appointmentId).toBe(appt.id);
    expect(alt.sourceAvailability).toMatchObject({ state: 'unavailable', reason: null });
    expect(alt.alternatives.map((a) => a.sessionId)).toEqual([today2.id, d2.id]);
    const ids = new Set(alt.alternatives.map((a) => a.sessionId));
    for (const s of [farOut, full, otherDept, sameDoctor, ended, source]) expect(ids.has(s.id)).toBe(false);
    expect(alt.alternatives[0]).toMatchObject({
      doctorId: doctorId(2),
      department: 'General Medicine',
      status: 'scheduled',
      bookedAvailable: 10,
      walkinAvailable: 5,
    });
    expect(iso(alt.alternatives[0]!.nextSlotAt)).toBe(ist(day, '09:00').getTime());
    expect(iso(alt.alternatives[1]!.nextSlotAt)).toBe(ist(addDays(day, 2), '09:00').getTime());

    // staff in scope see the same list plus the reason; another patient and out-of-scope staff are refused
    const staff = AppointmentAlternatives.parse((await reception.get(`/appointments/${appt.id}/alternatives`)).body);
    expect(staff.sourceAvailability.reason).toBe('Doctor unwell');
    const stranger = await newLoginPatient(t, reception, 'Alt Stranger');
    expect((await stranger.client.get(`/appointments/${appt.id}/alternatives`)).status).toBe(404);
    expect((await reception3.get(`/appointments/${appt.id}/alternatives`)).status).toBe(403);
  });

  it('at most 6, earliest first; nextSlotAt is the slot booking would assign right now', async () => {
    const day = nextDay();
    t.clock.set(ist(day, '10:00'));
    const source = await mk(1, day, { from: '09:00', to: '13:00' });
    const p = await newPatient(reception, 'Alt Six');
    const appt = await book(source, p);
    const targets: Sess[] = [];
    for (let i = 0; i < 8; i += 1)
      targets.push(
        await mk(2, addDays(day, i % 7), { from: i < 7 ? '09:00' : '14:00', to: i < 7 ? '13:00' : '17:00' }),
      );
    const alt = AppointmentAlternatives.parse((await reception.get(`/appointments/${appt.id}/alternatives`)).body);
    expect(alt.alternatives).toHaveLength(6);
    const starts = alt.alternatives.map((a) => iso(a.startsAt));
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    // today's 09:00-13:00 session at 10:00: the 10:00 slot closes 10:15, after the arrival window (10:10), so it is still offered
    const todayRow = alt.alternatives.find((a) => a.sessionId === targets[0]!.id)!;
    expect(iso(todayRow.nextSlotAt)).toBe(ist(day, '10:00').getTime());
  });

  it('a patient rebooks in one call to another General Medicine doctor; a full target leaves the original intact', async () => {
    const day = nextDay();
    t.clock.set(ist(day, '08:00'));
    const source = await mk(1, day);
    const mine = await newLoginPatient(t, reception, 'Rebook Patient');
    const appt = await book(source, mine.id);
    expect((await reception.post(`/sessions/${source.id}/unavailable`, { reason: 'Doctor unwell' })).status).toBe(200);
    const target = await mk(2, day);
    const alt = AppointmentAlternatives.parse((await mine.client.get(`/appointments/${appt.id}/alternatives`)).body);
    expect(alt.alternatives.map((a) => a.sessionId)).toContain(target.id);

    // a full target first: 409 and nothing changes
    const filler = await newPatient(reception, 'Filler');
    const tiny = await mk(2, addDays(day, 1), { booked: 1 });
    await book(tiny, filler);
    const before = await capacityOf(t.pool, source.id);
    const full = await mine.client.post(`/appointments/${appt.id}/reschedule`, {
      targetSessionId: tiny.id,
      expectedVersion: appt.version,
    });
    expect(full.status).toBe(409);
    expect(code(full.body)).toBe('CAPACITY_FULL');
    expect((await mine.client.get(`/appointments/${appt.id}`)).body).toMatchObject({
      status: 'booked',
      version: appt.version,
    });
    expect(await capacityOf(t.pool, source.id)).toEqual(before);

    const res = await mine.client.post(`/appointments/${appt.id}/reschedule`, {
      targetSessionId: target.id,
      expectedVersion: appt.version,
    });
    expect(res.status).toBe(201);
    const moved = Appointment.parse(res.body);
    expect(moved).toMatchObject({
      sessionId: target.id,
      doctorId: doctorId(2),
      status: 'booked',
      rescheduledFromId: appt.id,
    });
    expect((await mine.client.get(`/appointments/${appt.id}`)).body.status).toBe('rescheduled');
    expect((await capacityInvariant(t.pool, source.id)).ok).toBe(true);
    expect((await capacityInvariant(t.pool, target.id)).ok).toBe(true);
  });
});

/** The standard story: doctor 1 has booked, checked-in and walk-in patients, then becomes unavailable. */
async function story(srcDoctor = 1, tgtDoctor = 2) {
  const day = nextDay();
  t.clock.set(ist(day, '08:00'));
  const S = await mk(srcDoctor, day);
  const T = await mk(tgtDoctor, day);
  const pc = await newLoginPatient(t, reception, 'Story Checked In A');
  const pa1 = await newLoginPatient(t, reception, 'Story Booked One');
  const pa2 = await newPatient(reception, 'Story Booked Two');
  const pw = await newLoginPatient(t, reception, 'Story Walk In');
  const apc = await book(S, pc.id); // 09:00
  const a1 = await book(S, pa1.id); // 09:20
  const a2 = await book(S, pa2); // 09:40
  t.clock.set(ist(day, '08:55'));
  const ci = await reception.post(`/appointments/${apc.id}/check-in`, {});
  expect(ci.status).toBe(201);
  const wi = await reception.post(`/sessions/${S.id}/walk-ins`, { patientId: pw.id });
  expect(wi.status).toBe(201);
  expect((await reception.post(`/sessions/${S.id}/unavailable`, { reason: 'Doctor unwell' })).status).toBe(200);
  return {
    day,
    S,
    T,
    pc,
    pa1,
    pa2,
    pw,
    apc,
    a1,
    a2,
    checkedIn: ci.body as { queueEntryId: string; visitId: string; token: string },
    walkIn: wi.body as { queueEntryId: string; visitId: string; token: string },
  };
}

describe('B3.2 GET /sessions/{id}/affected', () => {
  it('reception in scope sees booked-not-arrived and checked-in patients and candidate sessions; others are refused', async () => {
    const w = await story();
    const res = await reception.get(`/sessions/${w.S.id}/affected`);
    expect(res.status).toBe(200);
    const a = AffectedPatients.parse(res.body);
    expect(a).toMatchObject({ sessionId: w.S.id, department: 'General Medicine' });
    expect(a.availability).toMatchObject({ state: 'unavailable', reason: 'Doctor unwell' });
    expect(a.notArrived.map((x) => x.appointmentId).sort()).toEqual([w.a1.id, w.a2.id].sort());
    const one = a.notArrived.find((x) => x.appointmentId === w.a1.id)!;
    expect(one).toMatchObject({ patientName: 'Story Booked One', hasLogin: true, status: 'booked' });
    expect(a.notArrived.find((x) => x.appointmentId === w.a2.id)!.hasLogin).toBe(false);
    expect(a.notArrived.find((x) => x.appointmentId === w.a2.id)!.patientMrn).toMatch(/\S/);
    expect(a.inQueue.map((x) => x.queueEntryId).sort()).toEqual(
      [w.checkedIn.queueEntryId, w.walkIn.queueEntryId].sort(),
    );
    expect(a.inQueue.find((x) => x.queueEntryId === w.checkedIn.queueEntryId)).toMatchObject({
      group: 'A',
      state: 'waiting',
      token: w.checkedIn.token,
    });
    expect(a.inQueue.find((x) => x.queueEntryId === w.walkIn.queueEntryId)!.group).toBe('W');
    expect(a.alternatives.map((x) => x.sessionId)).toContain(w.T.id);
    expect(a.alternatives.some((x) => x.doctorId === doctorId(1))).toBe(false);

    expect((await admin.get(`/sessions/${w.S.id}/affected`)).status).toBe(200);
    expect((await reception3.get(`/sessions/${w.S.id}/affected`)).status).toBe(403);
    expect((await w.pa1.client.get(`/sessions/${w.S.id}/affected`)).status).toBe(403);
    expect((await (await loginAs(t.server, 'doctor@hqms.test')).get(`/sessions/${w.S.id}/affected`)).status).toBe(403);
    expect((await reception.get(`/sessions/00000000-0000-4000-8000-000000000000/affected`)).status).toBe(404);
  });
});

describe('B3.3 POST /sessions/{id}/affected/move', () => {
  it('refuses while the source session is open, and validates the request', async () => {
    const day = nextDay();
    t.clock.set(ist(day, '08:00'));
    const S = await mk(1, day);
    const T = await mk(2, day);
    const p = await newPatient(reception, 'Move Validation');
    const a = await book(S, p);
    const body = { targetSessionId: T.id, appointmentIds: [a.id] };
    const open = await reception.post(`/sessions/${S.id}/affected/move`, body);
    expect(open.status).toBe(409);
    expect(code(open.body)).toBe('INVALID_TRANSITION');
    expect((await reception.post(`/sessions/${S.id}/open`, {})).status).toBe(200);
    expect(
      (
        await reception.post(`/sessions/${S.id}/pause`, {
          until: ist(day, '08:30').toISOString(),
          reason: 'Ward round',
        })
      ).status,
    ).toBe(200);
    expect((await reception.post(`/sessions/${S.id}/affected/move`, body, null)).status).toBe(400); // Idempotency-Key required
    expect((await reception.post(`/sessions/${S.id}/affected/move`, { targetSessionId: T.id })).status).toBe(400); // nobody chosen
    expect((await reception.post(`/sessions/${S.id}/affected/move`, { ...body, targetSessionId: S.id })).status).toBe(
      400,
    );
    expect(
      (
        await reception.post(`/sessions/${S.id}/affected/move`, {
          ...body,
          targetSessionId: '00000000-0000-4000-8000-000000000000',
        })
      ).status,
    ).toBe(404);
    expect((await reception3.post(`/sessions/${S.id}/affected/move`, body)).status).toBe(403);
    expect(
      (await (await newLoginPatient(t, reception, 'Move Patient')).client.post(`/sessions/${S.id}/affected/move`, body))
        .status,
    ).toBe(403);
    // away (paused) is enough: the booked appointment moves
    const ok = await reception.post(`/sessions/${S.id}/affected/move`, body);
    expect(ok.status).toBe(200);
    expect(MoveAffectedResult.parse(ok.body)).toMatchObject({ moved: 1, skipped: 0 });
  });

  it('moves booked appointments and transfers checked-in patients with their group, times and a new token', async () => {
    const w = await story();
    const capS = await capacityOf(t.pool, w.S.id);
    const verS = (await t.pool.query(`SELECT queue_version FROM sessions WHERE id = $1`, [w.S.id])).rows[0]!
      .queue_version as number;
    const verT = (await t.pool.query(`SELECT queue_version FROM sessions WHERE id = $1`, [w.T.id])).rows[0]!
      .queue_version as number;
    const oldEntry = (
      await t.pool.query(`SELECT scheduled_at, checked_in_at, eligible_at, token FROM queue_entries WHERE id = $1`, [
        w.checkedIn.queueEntryId,
      ])
    ).rows[0]!;

    const key = 'move-batch-0001';
    const res = await reception.post(
      `/sessions/${w.S.id}/affected/move`,
      {
        targetSessionId: w.T.id,
        appointmentIds: [w.a1.id, w.a2.id],
        queueEntryIds: [w.checkedIn.queueEntryId, w.walkIn.queueEntryId],
      },
      key,
    );
    expect(res.status).toBe(200);
    const out = MoveAffectedResult.parse(res.body);
    expect(out).toMatchObject({ sourceSessionId: w.S.id, targetSessionId: w.T.id, moved: 4, skipped: 0 });
    expect(out.results.every((r) => r.outcome === 'moved' && r.code === null)).toBe(true);

    // appointments: rescheduled into the target, first assignable slots
    for (const a of [w.a1, w.a2]) {
      const o = out.results.find((r) => r.sourceId === a.id)!;
      expect(o.kind).toBe('appointment');
      const moved = (await reception.get(`/appointments/${o.newAppointmentId}`)).body as Appointment;
      expect(moved).toMatchObject({ sessionId: w.T.id, status: 'booked', rescheduledFromId: a.id });
      expect((await reception.get(`/appointments/${a.id}`)).body.status).toBe('rescheduled');
    }
    expect(
      await count(
        t.pool,
        `SELECT 1 FROM outbox_events WHERE event_type = 'AppointmentRescheduled' AND session_id = $1`,
        [w.T.id],
      ),
    ).toBe(2);

    // checked-in A patient: transferred, same group, original times carried over, new token in the target
    const mc = out.results.find((r) => r.sourceId === w.checkedIn.queueEntryId)!;
    expect(mc).toMatchObject({ kind: 'queue_entry', outcome: 'moved', newAppointmentId: null });
    expect(mc.token).toMatch(/^A-\d{3}$/);
    const ne = (await t.pool.query(`SELECT * FROM queue_entries WHERE id = $1`, [mc.newQueueEntryId])).rows[0]!;
    expect(ne).toMatchObject({
      session_id: w.T.id,
      doctor_id: doctorId(2),
      queue_group: 'A',
      state: 'waiting',
      token: mc.token,
    });
    expect(iso(ne.scheduled_at)).toBe(iso(oldEntry.scheduled_at));
    expect(iso(ne.checked_in_at)).toBe(iso(oldEntry.checked_in_at));
    expect(iso(ne.eligible_at)).toBe(iso(oldEntry.eligible_at));
    const nv = (await t.pool.query(`SELECT * FROM visits WHERE id = $1`, [ne.visit_id])).rows[0]!;
    expect(nv).toMatchObject({
      kind: 'transfer',
      status: 'open',
      session_id: w.T.id,
      transferred_from_visit_id: w.checkedIn.visitId,
      appointment_id: null,
    });
    const oe = (await t.pool.query(`SELECT state FROM queue_entries WHERE id = $1`, [w.checkedIn.queueEntryId]))
      .rows[0]!;
    const ov = (await t.pool.query(`SELECT status FROM visits WHERE id = $1`, [w.checkedIn.visitId])).rows[0]!;
    expect(oe.state).toBe('cancelled');
    expect(ov.status).toBe('transferred');
    // the original appointment of the transferred patient is untouched
    expect((await reception.get(`/appointments/${w.apc.id}`)).body.status).toBe('checked_in');

    // walk-in: stays W with a W token, consuming a walk-in place
    const mw = out.results.find((r) => r.sourceId === w.walkIn.queueEntryId)!;
    expect(mw.token).toMatch(/^W-\d{3}$/);
    expect(
      (await t.pool.query(`SELECT queue_group FROM queue_entries WHERE id = $1`, [mw.newQueueEntryId])).rows[0]!
        .queue_group,
    ).toBe('W');

    // capacity: target holds 2 appointments + 1 transferred A (booked) and 1 walk-in; source counters unchanged (consumed never reopens)
    const capT = await capacityOf(t.pool, w.T.id);
    expect(capT).toMatchObject({ booked_reserved: 3, walkin_used: 1 });
    expect(await capacityOf(t.pool, w.S.id)).toMatchObject({ walkin_used: capS.walkin_used });
    expect((await capacityInvariant(t.pool, w.S.id)).ok).toBe(true);
    expect((await capacityInvariant(t.pool, w.T.id)).ok).toBe(true);
    // queue_version bumped on BOTH sessions
    expect(
      (await t.pool.query(`SELECT queue_version FROM sessions WHERE id = $1`, [w.S.id])).rows[0]!.queue_version,
    ).toBeGreaterThan(verS);
    expect(
      (await t.pool.query(`SELECT queue_version FROM sessions WHERE id = $1`, [w.T.id])).rows[0]!.queue_version,
    ).toBeGreaterThan(verT);
    // audit on both sides, outbox event with routing data only
    expect(
      await count(t.pool, `SELECT 1 FROM audit_events WHERE operation = 'visit.transfer_out' AND entity_id = $1`, [
        w.checkedIn.visitId,
      ]),
    ).toBe(1);
    expect(
      await count(t.pool, `SELECT 1 FROM audit_events WHERE operation = 'visit.transfer_in' AND entity_id = $1`, [
        ne.visit_id,
      ]),
    ).toBe(1);
    const ev = (
      await t.pool.query(
        `SELECT * FROM outbox_events WHERE event_type = 'QueuePatientTransferred' AND entity_id = $1`,
        [mc.newQueueEntryId],
      )
    ).rows[0]!;
    expect(ev).toMatchObject({ entity_type: 'queue_entry', session_id: w.T.id, patient_id: w.pc.id });
    expect(ev.payload).toMatchObject({ token: mc.token, fromSessionId: w.S.id });
    expect(typeof ev.payload.queueVersion).toBe('number');
    // the patient's own Today now shows the transferred visit
    const today = (await w.pc.client.get('/me/visits/today')).body as unknown[];
    expect(today.map((x) => MyTodayVisit.parse(x))).toEqual([
      expect.objectContaining({ sessionId: w.T.id, kind: 'transfer', token: mc.token, queueState: 'waiting' }),
    ]);

    // a retried batch (same key, same body) never moves twice
    const again = await reception.post(
      `/sessions/${w.S.id}/affected/move`,
      {
        targetSessionId: w.T.id,
        appointmentIds: [w.a1.id, w.a2.id],
        queueEntryIds: [w.checkedIn.queueEntryId, w.walkIn.queueEntryId],
      },
      key,
    );
    expect(again.status).toBe(200);
    const replay = MoveAffectedResult.parse(again.body);
    expect(replay.moved).toBe(4);
    expect(replay.results.map((r) => r.newQueueEntryId ?? r.newAppointmentId).sort()).toEqual(
      out.results.map((r) => r.newQueueEntryId ?? r.newAppointmentId).sort(),
    );
    expect(await capacityOf(t.pool, w.T.id)).toMatchObject({ booked_reserved: 3, walkin_used: 1 });
    expect(await count(t.pool, `SELECT 1 FROM queue_entries WHERE session_id = $1`, [w.T.id])).toBe(2);
    // the same key with another target is a reuse error, not a second move
    const reuse = await reception.post(
      `/sessions/${w.S.id}/affected/move`,
      { targetSessionId: (await mk(2, addDays(w.day, 1))).id, appointmentIds: [w.a1.id] },
      key,
    );
    expect(reuse.status).toBe(409);
    expect(code(reuse.body)).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('a full target skips only the items that do not fit (CAPACITY_FULL) and the rest continue', async () => {
    const w = await story();
    const T2 = await mk(2, w.day, { from: '14:00', to: '17:00', booked: 2, walkin: 0 });
    const res = await reception.post(`/sessions/${w.S.id}/affected/move`, {
      targetSessionId: T2.id,
      appointmentIds: [w.a1.id, w.a2.id],
      queueEntryIds: [w.checkedIn.queueEntryId, w.walkIn.queueEntryId],
    });
    expect(res.status).toBe(200);
    const out = MoveAffectedResult.parse(res.body);
    // two booked places: the two appointments take them, the transferred A patient and the walk-in do not fit
    expect(out.moved).toBe(2);
    expect(out.skipped).toBe(2);
    for (const id of [w.checkedIn.queueEntryId, w.walkIn.queueEntryId]) {
      expect(out.results.find((r) => r.sourceId === id)).toMatchObject({ outcome: 'skipped', code: 'CAPACITY_FULL' });
      expect((await t.pool.query(`SELECT state FROM queue_entries WHERE id = $1`, [id])).rows[0]!.state).toBe(
        'waiting',
      );
    }
    expect((await capacityInvariant(t.pool, T2.id)).ok).toBe(true);
    expect((await capacityInvariant(t.pool, w.S.id)).ok).toBe(true);
  });

  it('skips a patient who already holds a place in the target (CONFLICT), a called patient and a foreign id', async () => {
    const w = await story(9, 10); /* doctors 9 and 10: no called entries left over by other test files */
    // pw is also admitted as a walk-in in the target before the move
    t.clock.set(ist(w.day, '09:00'));
    expect((await reception.post(`/sessions/${w.T.id}/walk-ins`, { patientId: w.pw.id })).status).toBe(201);
    // the checked-in A patient has been called by the doctor in the meantime
    await t.pool.query(`UPDATE queue_entries SET state = 'called', called_at = now() WHERE id = $1`, [
      w.checkedIn.queueEntryId,
    ]);
    const other = await mk(2, addDays(w.day, 1));
    const foreign = await book(other, await newPatient(reception, 'Foreign Appointment'));
    const res = await reception.post(`/sessions/${w.S.id}/affected/move`, {
      targetSessionId: w.T.id,
      appointmentIds: [foreign.id, w.a1.id],
      queueEntryIds: [w.checkedIn.queueEntryId, w.walkIn.queueEntryId],
    });
    expect(res.status).toBe(200);
    const out = MoveAffectedResult.parse(res.body);
    expect(out.results.find((r) => r.sourceId === foreign.id)).toMatchObject({ outcome: 'skipped', code: 'NOT_FOUND' });
    expect(out.results.find((r) => r.sourceId === w.a1.id)!.outcome).toBe('moved');
    expect(out.results.find((r) => r.sourceId === w.checkedIn.queueEntryId)).toMatchObject({
      outcome: 'skipped',
      code: 'INVALID_TRANSITION',
    });
    expect(out.results.find((r) => r.sourceId === w.walkIn.queueEntryId)).toMatchObject({
      outcome: 'skipped',
      code: 'CONFLICT',
    });
    expect(out).toMatchObject({ moved: 1, skipped: 3 });
    expect((await reception.get(`/appointments/${foreign.id}`)).body.status).toBe('booked');
  });

  it('transfers an absent patient too (still parked there) and keeps an assigned clinical priority', async () => {
    const w = await story();
    await t.pool.query(`UPDATE queue_entries SET state = 'absent' WHERE id = $1`, [w.walkIn.queueEntryId]);
    const doc = await t.pool.query(`SELECT id FROM users WHERE email = 'doctor@hqms.test'`);
    await t.pool.query(
      `UPDATE queue_entries SET priority_class = 2, priority_reason = 'fever', priority_set_by = $2, priority_set_at = now() WHERE id = $1`,
      [w.checkedIn.queueEntryId, doc.rows[0]!.id],
    );
    const res = await reception.post(`/sessions/${w.S.id}/affected/move`, {
      targetSessionId: w.T.id,
      queueEntryIds: [w.checkedIn.queueEntryId, w.walkIn.queueEntryId],
    });
    const out = MoveAffectedResult.parse(res.body);
    expect(out.moved).toBe(2);
    const ne = (
      await t.pool.query(`SELECT state, priority_class, priority_reason FROM queue_entries WHERE id = $1`, [
        out.results[0]!.newQueueEntryId,
      ])
    ).rows[0]!;
    expect(ne).toMatchObject({ priority_class: 2, priority_reason: 'fever' });
    const wi = (await t.pool.query(`SELECT state FROM queue_entries WHERE id = $1`, [out.results[1]!.newQueueEntryId]))
      .rows[0]!;
    expect(wi.state).toBe('absent'); // a parked patient stays parked in the target (re-entry is reception's call there)
  });
});
