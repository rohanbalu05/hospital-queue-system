/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, ArrivalResult, Appointment, CallNextResult, QueueCommandResult } from '@hqms/contracts';
import {
  type Client,
  type MadeSession,
  type TestApp,
  at,
  capacityOf,
  count,
  createTestApp,
  doctorId,
  loginAs,
  makeSession,
  newPatient,
} from './helpers.js';

/**
 * Codex P1 #2: a parked (absent or skipped) queue entry still holds the patient's place. Admission paths
 * must refuse a second live place for the same patient and session, and re-entry must refuse when another
 * live place exists. DB backstop: one open/in_service visit per (session, patient) (migration 0007).
 */
const ONE_OPEN_VISIT_UQ = 'visits_one_open_per_patient_session_uq';

let t: TestApp;
let admin: Client;
let reception: Client;
let doctor: Client; // doctor 7

beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  doctor = await loginAs(t.server, 'doctor7@hqms.test');
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => t.clock.reset());

const errorCode = (body: unknown): string => ApiError.parse(body).error.code;

async function mk(): Promise<MadeSession> {
  await t.pool.query(
    `UPDATE queue_entries SET state = 'skipped', skipped_at = now() WHERE doctor_id = $1 AND state IN ('called','in_service')`,
    [doctorId(7)],
  );
  return makeSession(admin, { doctor: 7 });
}

async function walkIn(s: MadeSession, patient: string, minute: number, key: string = randomUUID()) {
  t.clock.set(at(s, minute));
  return reception.post(`/sessions/${s.id}/walk-ins`, { patientId: patient }, key);
}

async function admitOk(s: MadeSession, patient: string, minute: number): Promise<ArrivalResult> {
  const res = await walkIn(s, patient, minute);
  expect(res.status).toBe(201);
  return ArrivalResult.parse(res.body);
}

async function park(entryId: string, how: 'absent' | 'skipped'): Promise<void> {
  const version = (await t.pool.query(`SELECT version FROM queue_entries WHERE id = $1`, [entryId])).rows[0]!
    .version as number;
  const res = await reception.post(`/queue-entries/${entryId}/${how === 'absent' ? 'absent' : 'skip'}`, {
    expectedVersion: version,
  });
  expect(res.status).toBe(200);
}

async function snapshotCounts(s: MadeSession, patient: string) {
  return {
    capacity: await capacityOf(t.pool, s.id),
    visits: await count(t.pool, `SELECT 1 FROM visits WHERE session_id = $1 AND patient_id = $2`, [s.id, patient]),
    entries: await count(
      t.pool,
      `SELECT 1 FROM queue_entries qe JOIN visits v ON v.id = qe.visit_id WHERE qe.session_id = $1 AND v.patient_id = $2`,
      [s.id, patient],
    ),
    nextSeqW: (await t.pool.query(`SELECT next_seq_w FROM sessions WHERE id = $1`, [s.id])).rows[0]!
      .next_seq_w as number,
  };
}

/** Test-only SQL: a second visit + entry for the patient, the state the old code allowed. */
async function insertSecondPlace(s: MadeSession, patient: string, state: 'waiting' | 'absent'): Promise<void> {
  const alloc = await t.pool.query(
    `INSERT INTO capacity_allocations (session_id, kind, state) VALUES ($1, 'walkin', 'consumed') RETURNING id`,
    [s.id],
  );
  await t.pool.query(`UPDATE session_capacity SET walkin_used = walkin_used + 1 WHERE session_id = $1`, [s.id]);
  const by = (await t.pool.query(`SELECT id FROM users WHERE email = 'admin@hqms.test'`)).rows[0]!.id as string;
  const visit = await t.pool.query(
    `INSERT INTO visits (patient_id, session_id, doctor_id, allocation_id, kind, checked_in_at, checked_in_by)
     VALUES ($1, $2, $3, $4, 'walkin', now(), $5) RETURNING id`,
    [patient, s.id, doctorId(7), alloc.rows[0]!.id, by],
  );
  await t.pool.query(
    `INSERT INTO queue_entries (visit_id, session_id, doctor_id, queue_group, token, seq, state, checked_in_at, eligible_at)
     VALUES ($1, $2, $3, 'W', 'W-099', 99, $4, now(), now())`,
    [visit.rows[0]!.id, s.id, doctorId(7), state],
  );
}

describe('walk-in admission is refused while the patient holds a parked place', () => {
  it('(a) walk-in marked absent, then a second walk-in with a NEW key -> 409 CONFLICT, nothing consumed', async () => {
    const s = await mk();
    const p = await newPatient(reception);
    const first = await admitOk(s, p, 0);
    await park(first.queueEntryId, 'absent');
    const before = await snapshotCounts(s, p);
    expect(before).toMatchObject({ visits: 1, entries: 1 });

    const again = await walkIn(s, p, 5);
    expect(again.status).toBe(409);
    expect(errorCode(again.body)).toBe('CONFLICT');
    expect(again.body.error.message).toMatch(/already has/);
    expect(await snapshotCounts(s, p)).toEqual(before);
  });

  it('(b) called then skipped, then a second walk-in -> 409 CONFLICT, nothing consumed', async () => {
    const s = await mk();
    const p = await newPatient(reception);
    const first = await admitOk(s, p, 0);
    t.clock.set(at(s, 1));
    const called = CallNextResult.parse((await doctor.post(`/sessions/${s.id}/call-next`, {})).body);
    expect(called.entry!.id).toBe(first.queueEntryId);
    await park(first.queueEntryId, 'skipped');
    expect(
      (await t.pool.query(`SELECT state FROM queue_entries WHERE id = $1`, [first.queueEntryId])).rows[0]!.state,
    ).toBe('skipped');
    const before = await snapshotCounts(s, p);

    const again = await walkIn(s, p, 6);
    expect(again.status).toBe(409);
    expect(errorCode(again.body)).toBe('CONFLICT');
    expect(await snapshotCounts(s, p)).toEqual(before);
  });

  it('(c) an appointment patient checked in then marked absent cannot be admitted as a walk-in', async () => {
    const s = await mk();
    const p = await newPatient(reception);
    t.clock.reset();
    const appt = (await reception.post('/appointments', { sessionId: s.id, patientId: p })).body as Appointment;
    t.clock.set(at(s, -5));
    const arrival = ArrivalResult.parse((await reception.post(`/appointments/${appt.id}/check-in`, {})).body);
    await park(arrival.queueEntryId, 'absent');
    const before = await snapshotCounts(s, p);

    const again = await walkIn(s, p, 5);
    expect(again.status).toBe(409);
    expect(errorCode(again.body)).toBe('CONFLICT');
    expect(await snapshotCounts(s, p)).toEqual(before);
  });
});

describe('re-entry cannot coexist with another live place for the patient', () => {
  // The duplicate state the old code allowed can no longer be built once the DB backstop exists, so the
  // service-level guard is exercised with the index dropped for this block and recreated afterwards.
  let hadIndex = false;
  beforeAll(async () => {
    hadIndex = (await count(t.pool, `SELECT 1 FROM pg_indexes WHERE indexname = $1`, [ONE_OPEN_VISIT_UQ])) > 0;
    await t.pool.query(`DROP INDEX IF EXISTS ${ONE_OPEN_VISIT_UQ}`);
  });
  afterAll(async () => {
    if (!hadIndex) return;
    // Close every visit that is a duplicate (the fixtures above), then restore the backstop.
    await t.pool.query(
      `UPDATE visits SET status = 'left' WHERE id IN (
         SELECT id FROM (
           SELECT id, row_number() OVER (PARTITION BY session_id, patient_id ORDER BY created_at) AS rn
             FROM visits WHERE status IN ('open','in_service')
         ) d WHERE d.rn > 1)`,
    );
    await t.pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${ONE_OPEN_VISIT_UQ} ON visits (session_id, patient_id)
         WHERE status IN ('open','in_service')`,
    );
  });

  it('(d) re-entering a parked entry while another live entry exists -> 409 CONFLICT, nothing changes', async () => {
    const s = await mk();
    const p = await newPatient(reception);
    const first = await admitOk(s, p, 0);
    await park(first.queueEntryId, 'absent');
    await insertSecondPlace(s, p, 'waiting');
    const entryRow = () =>
      t.pool.query(`SELECT state, version, eligible_at FROM queue_entries WHERE id = $1`, [first.queueEntryId]);
    const before = (await entryRow()).rows[0]!;
    const audits = () =>
      count(t.pool, `SELECT 1 FROM audit_events WHERE operation = 'queue.re_enter' AND entity_id = $1`, [
        first.queueEntryId,
      ]);

    t.clock.set(at(s, 10));
    const res = await reception.post(`/queue-entries/${first.queueEntryId}/re-enter`, {});
    expect(res.status).toBe(409);
    expect(errorCode(res.body)).toBe('CONFLICT');
    expect(res.body.error.message).toMatch(/already has another place in this session/);
    expect((await entryRow()).rows[0]).toEqual(before);
    expect(await audits()).toBe(0);
  });

  it('(d) re-entering a parked entry while another PARKED entry with an open visit exists -> 409 CONFLICT', async () => {
    const s = await mk();
    const p = await newPatient(reception);
    const first = await admitOk(s, p, 0);
    await park(first.queueEntryId, 'absent');
    await insertSecondPlace(s, p, 'absent');
    t.clock.set(at(s, 10));
    const res = await reception.post(`/queue-entries/${first.queueEntryId}/re-enter`, {});
    expect(res.status).toBe(409);
    expect(errorCode(res.body)).toBe('CONFLICT');
    expect(
      (await t.pool.query(`SELECT state FROM queue_entries WHERE id = $1`, [first.queueEntryId])).rows[0]!.state,
    ).toBe('absent');
  });
});

describe('(e) regression and (f) legitimate second visits', () => {
  it('(e) re-entering a parked entry when no other live entry exists still works', async () => {
    const s = await mk();
    const p = await newPatient(reception);
    const first = await admitOk(s, p, 0);
    await park(first.queueEntryId, 'absent');
    t.clock.set(at(s, 10));
    const res = await reception.post(`/queue-entries/${first.queueEntryId}/re-enter`, {});
    expect(res.status).toBe(200);
    expect(QueueCommandResult.parse(res.body).entry).toMatchObject({ id: first.queueEntryId, state: 'waiting' });
  });

  it('(f) a patient whose earlier visit in the session is COMPLETED can be admitted as a new walk-in', async () => {
    const s = await mk();
    const p = await newPatient(reception);
    const first = await admitOk(s, p, 0);
    t.clock.set(at(s, 1));
    expect((await doctor.post(`/sessions/${s.id}/call-next`, {})).status).toBe(200);
    t.clock.set(at(s, 2));
    expect((await doctor.post(`/visits/${first.visitId}/start`, {})).status).toBe(200);
    t.clock.set(at(s, 8));
    expect((await doctor.post(`/visits/${first.visitId}/complete`, {})).status).toBe(200);

    const second = await walkIn(s, p, 20);
    expect(second.status).toBe(201);
    expect(ArrivalResult.parse(second.body).visitId).not.toBe(first.visitId);
    expect(await count(t.pool, `SELECT 1 FROM visits WHERE session_id = $1 AND patient_id = $2`, [s.id, p])).toBe(2);
  });

  it('(f) a patient whose earlier entry is cancelled and visit left can be admitted again', async () => {
    const s = await mk();
    const p = await newPatient(reception);
    const first = await admitOk(s, p, 0);
    await t.pool.query(`UPDATE queue_entries SET state = 'cancelled' WHERE id = $1`, [first.queueEntryId]);
    await t.pool.query(`UPDATE visits SET status = 'left' WHERE id = $1`, [first.visitId]);
    const second = await walkIn(s, p, 5);
    expect(second.status).toBe(201);
  });
});

describe('concurrency: duplicate admissions race', () => {
  it('10 parallel walk-ins for a patient whose entry is absent -> 0 successes', async () => {
    const s = await mk();
    const p = await newPatient(reception);
    const first = await admitOk(s, p, 0);
    await park(first.queueEntryId, 'absent');
    const before = await snapshotCounts(s, p);
    t.clock.set(at(s, 5));
    const results = await Promise.all(
      Array.from({ length: 10 }, () => reception.post(`/sessions/${s.id}/walk-ins`, { patientId: p }, randomUUID())),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(0);
    expect(results.every((r) => r.status === 409)).toBe(true);
    expect(await snapshotCounts(s, p)).toEqual(before);
  });

  it('10 parallel walk-ins for a patient with no place -> exactly 1 success', async () => {
    const s = await mk();
    const p = await newPatient(reception);
    t.clock.set(at(s, 5));
    const results = await Promise.all(
      Array.from({ length: 10 }, () => reception.post(`/sessions/${s.id}/walk-ins`, { patientId: p }, randomUUID())),
    );
    expect(results.some((r) => r.status >= 500)).toBe(false);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect(await count(t.pool, `SELECT 1 FROM visits WHERE session_id = $1 AND patient_id = $2`, [s.id, p])).toBe(1);
    expect((await capacityOf(t.pool, s.id)).walkin_used).toBe(1);
  });
});

describe('DB backstop: one open visit per patient and session', () => {
  it('a second open visit for the same patient and session is rejected by the unique index (23505)', async () => {
    // The index is dropped by an earlier block of this file and recreated in its afterAll; run this last.
    const s = await mk();
    const p = await newPatient(reception);
    await admitOk(s, p, 0);
    await expect(insertSecondPlace(s, p, 'waiting')).rejects.toMatchObject({
      code: '23505',
      constraint: ONE_OPEN_VISIT_UQ,
    });
  });
});
