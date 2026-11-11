/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ArrivalResult, StaffQueueSnapshot } from '@hqms/contracts';
import { type Client, type MadeSession, type TestApp, at, createTestApp, doctorId, loginAs, makeSession, patientId } from './helpers.js';

let t: TestApp;
let admin: Client;
let reception: Client;
let doctor: Client;

beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  doctor = await loginAs(t.server, 'doctor@hqms.test');
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => t.clock.reset());

async function fresh(opts: { walkin?: number } = {}): Promise<MadeSession> {
  await t.pool.query(
    `UPDATE queue_entries SET state = 'skipped', skipped_at = now() WHERE doctor_id = $1 AND state IN ('called','in_service')`,
    [doctorId(1)],
  );
  return makeSession(admin, { doctor: 1, ...opts });
}

async function walkIn(s: MadeSession, p: number, minute: number): Promise<ArrivalResult> {
  t.clock.set(at(s, minute));
  const res = await reception.post(`/sessions/${s.id}/walk-ins`, { patientId: patientId(p) });
  expect(res.status).toBe(201);
  return ArrivalResult.parse(res.body);
}

async function staffView(s: MadeSession, minute: number): Promise<StaffQueueSnapshot> {
  t.clock.set(at(s, minute));
  const res = await doctor.get(`/sessions/${s.id}/queue`);
  expect(res.status).toBe(200);
  return StaffQueueSnapshot.parse(res.body);
}

describe('§6.6 workload pressure in the staff snapshot', () => {
  it('normal: a short queue with room in the session', async () => {
    const s = await fresh();
    await walkIn(s, 1, 0);
    await walkIn(s, 2, 1);
    const snap = await staffView(s, 5);
    expect(snap.pressure).toEqual({ level: 'normal', reasons: [] });
  });

  it('an empty queue is normal', async () => {
    const s = await fresh();
    expect((await staffView(s, 0)).pressure).toEqual({ level: 'normal', reasons: [] });
  });

  it('overloaded: the last waiting patient is projected to finish after the session ends', async () => {
    const s = await fresh();
    // 12:30 with four people waiting at 12 min each: the last finishes about 13:18, past the 13:00 end.
    for (const p of [1, 2, 3, 4]) await walkIn(s, p, 210);
    const snap = await staffView(s, 210);
    expect(snap.pressure.level).toBe('overloaded');
    expect(snap.pressure.reasons.join(' ')).toMatch(/projected to finish about \d+ minutes after the session ends/);
  });

  it('high: someone has waited past the aging trigger (count and longest wait in plain words)', async () => {
    const s = await fresh();
    await walkIn(s, 1, 0);
    const snap = await staffView(s, 50);
    expect(snap.pressure.level).toBe('high');
    expect(snap.pressure.reasons).toEqual([
      expect.stringMatching(/1 patient has waited longer than the 45-minute aging trigger \(longest 50 minutes\)/),
    ]);
  });

  it('overloaded: aging is blocked by clinical priority while an older patient has waited past the trigger', async () => {
    const s = await fresh();
    await walkIn(s, 1, 0);
    const w2 = await walkIn(s, 2, 50);
    t.clock.set(at(s, 51));
    expect((await doctor.post(`/queue-entries/${w2.queueEntryId}/priority`, { priorityClass: 1, reason: 'Chest pain on arrival' })).status).toBe(
      200,
    );
    const snap = await staffView(s, 52);
    expect(snap.pressure.level).toBe('overloaded');
    expect(snap.pressure.reasons.some((r) => /Clinical priority is being called first/.test(r))).toBe(true);
    expect(snap.pressure.reasons.some((r) => /aging trigger \(longest 52 minutes\)/.test(r))).toBe(true);
  });

  it('high: walk-in places are full while patients are waiting', async () => {
    const s = await fresh({ walkin: 1 });
    await walkIn(s, 1, 0);
    const snap = await staffView(s, 1);
    expect(snap.pressure.level).toBe('high');
    expect(snap.pressure.reasons).toEqual([expect.stringMatching(/Walk-in places are full \(1 of 1\) and 1 patient is still waiting/)]);
  });
});
