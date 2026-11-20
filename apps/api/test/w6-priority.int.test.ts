/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
/* PR-29: a clinical priority on a present waiting patient makes them callable now (eligible_at = LEAST(eligible_at, now)). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ArrivalResult, CallNextResult } from '@hqms/contracts';
import { type Client, type MadeSession, type TestApp, at, createTestApp, doctorId, loginAs, makeSession, patientId } from './helpers.js';

let t: TestApp;
let admin: Client;
let reception: Client;
let doctor: Client;

beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  doctor = await loginAs(t.server, 'doctor6@hqms.test');
});
afterAll(() => t.close());
beforeEach(() => t.clock.reset());

async function mk(): Promise<MadeSession> {
  await t.pool.query(
    `UPDATE queue_entries SET state = 'skipped', skipped_at = now() WHERE doctor_id = $1 AND state IN ('called','in_service')`,
    [doctorId(6)],
  );
  return makeSession(admin, { doctor: 6 });
}

/** Three bookings (09:00, 09:20, 09:40); only the third patient arrives, at 09:00: eligible at 09:30. */
async function lateSlotArrived(s: MadeSession) {
  await reception.post('/appointments', { sessionId: s.id, patientId: patientId(1) });
  await reception.post('/appointments', { sessionId: s.id, patientId: patientId(2) });
  const third = await reception.post('/appointments', { sessionId: s.id, patientId: patientId(3) });
  expect(third.status).toBe(201);
  t.clock.set(at(s, 0));
  const res = await reception.post(`/appointments/${third.body.id}/check-in`, {});
  expect(res.status).toBe(201);
  return ArrivalResult.parse(res.body);
}

describe('PR-29 clinical priority refreshes eligibility', () => {
  it('class 1 on an appointment patient 30 min from eligible: next call-next selects them as CLINICAL_PRIORITY', async () => {
    const s = await mk();
    const a3 = await lateSlotArrived(s);
    const before = await t.pool.query(`SELECT eligible_at FROM queue_entries WHERE id = $1`, [a3.queueEntryId]);
    expect(new Date(before.rows[0]!.eligible_at as string).getTime()).toBe(at(s, 30).getTime());

    // Without priority, nobody is eligible yet at 09:05.
    t.clock.set(at(s, 5));
    const none = await doctor.post(`/sessions/${s.id}/call-next`, {});
    expect(none.status).toBe(200);
    expect(CallNextResult.parse(none.body).entry).toBeNull();

    const prio = await doctor.post(`/queue-entries/${a3.queueEntryId}/priority`, { priorityClass: 1, reason: 'Chest pain, ECG changes' });
    expect(prio.status).toBe(200);

    const row = await t.pool.query(`SELECT eligible_at, priority_class FROM queue_entries WHERE id = $1`, [a3.queueEntryId]);
    expect(new Date(row.rows[0]!.eligible_at as string).getTime()).toBe(at(s, 5).getTime());

    const called = CallNextResult.parse((await doctor.post(`/sessions/${s.id}/call-next`, {})).body);
    expect(called.entry?.id).toBe(a3.queueEntryId);
    expect(called.decision.reason).toBe('CLINICAL_PRIORITY');
  });

  it('audits previous and next eligibleAt; an already eligible patient keeps the earlier time (LEAST)', async () => {
    const s = await mk();
    const a3 = await lateSlotArrived(s);
    t.clock.set(at(s, 5));
    await doctor.post(`/queue-entries/${a3.queueEntryId}/priority`, { priorityClass: 2, reason: 'Elderly, breathless' });
    const audit = await t.pool.query(
      `SELECT previous, next FROM audit_events WHERE operation = 'queue.priority' AND entity_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [a3.queueEntryId],
    );
    expect(audit.rows[0]!.previous).toMatchObject({ eligibleAt: at(s, 30).toISOString() });
    expect(audit.rows[0]!.next).toMatchObject({ eligibleAt: at(s, 5).toISOString(), priorityClass: 2 });

    // Raising the class later (now 09:10) must not move eligibility forward again.
    t.clock.set(at(s, 10));
    const v = (await t.pool.query(`SELECT version FROM queue_entries WHERE id = $1`, [a3.queueEntryId])).rows[0]!.version as number;
    const again = await doctor.post(`/queue-entries/${a3.queueEntryId}/priority`, {
      priorityClass: 1,
      reason: 'Worse now',
      expectedVersion: v,
    });
    expect(again.status).toBe(200);
    const row = await t.pool.query(`SELECT eligible_at FROM queue_entries WHERE id = $1`, [a3.queueEntryId]);
    expect(new Date(row.rows[0]!.eligible_at as string).getTime()).toBe(at(s, 5).getTime());
  });

  it('clearing the priority does not restore the old eligibility', async () => {
    const s = await mk();
    const a3 = await lateSlotArrived(s);
    t.clock.set(at(s, 5));
    await doctor.post(`/queue-entries/${a3.queueEntryId}/priority`, { priorityClass: 3, reason: 'Pain' });
    const v = (await t.pool.query(`SELECT version FROM queue_entries WHERE id = $1`, [a3.queueEntryId])).rows[0]!.version as number;
    const cleared = await doctor.post(`/queue-entries/${a3.queueEntryId}/priority`, { priorityClass: null, reason: 'Mistake', expectedVersion: v });
    expect(cleared.status).toBe(200);
    const row = await t.pool.query(`SELECT eligible_at, priority_class FROM queue_entries WHERE id = $1`, [a3.queueEntryId]);
    expect(row.rows[0]!.priority_class).toBeNull();
    expect(new Date(row.rows[0]!.eligible_at as string).getTime()).toBe(at(s, 5).getTime());
  });
});
