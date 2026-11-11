import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bumpQueueVersion,
  createPool,
  LockOrderError,
  lockCapacities,
  lockCapacity,
  lockDoctor,
  lockDoctors,
  lockSession,
  lockSessions,
  NotFoundError,
  reserveBooked,
  withTransaction,
} from '../src/index.js';
import { addSession, makeFixture, TEST_DB, testUrl } from './helpers.js';

let pool: Pool;
beforeAll(() => {
  pool = createPool(testUrl(TEST_DB), { max: 10 });
});
afterAll(async () => {
  await pool.end();
});

describe('lock order doctor -> session -> capacity', () => {
  it('allows the canonical order and tracks what is held', async () => {
    const f = await makeFixture(pool);
    await withTransaction(pool, async (tx) => {
      await lockDoctor(tx, f.doctorId);
      await lockSession(tx, f.sessionId);
      await lockCapacity(tx, f.sessionId);
      expect(tx.holds('doctor', f.doctorId)).toBe(true);
      expect(tx.holds('session', f.sessionId)).toBe(true);
      expect(tx.holds('capacity', f.sessionId)).toBe(true);
    });
  });

  it('throws LockOrderError for session -> doctor', async () => {
    const f = await makeFixture(pool);
    const err = await withTransaction(pool, async (tx) => {
      await lockSession(tx, f.sessionId);
      await lockDoctor(tx, f.doctorId);
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LockOrderError);
    expect(err.message).toMatch(/doctor lock requested after session/);
  });

  it('throws LockOrderError for capacity -> session and capacity -> doctor', async () => {
    const f = await makeFixture(pool);
    const e1 = await withTransaction(pool, async (tx) => {
      await lockCapacity(tx, f.sessionId);
      await lockSession(tx, f.sessionId);
    }).catch((e) => e);
    const e2 = await withTransaction(pool, async (tx) => {
      await lockCapacity(tx, f.sessionId);
      await lockDoctor(tx, f.doctorId);
    }).catch((e) => e);
    expect(e1).toBeInstanceOf(LockOrderError);
    expect(e2).toBeInstanceOf(LockOrderError);
  });

  it('does not retry a LockOrderError (programming error)', async () => {
    const f = await makeFixture(pool);
    let calls = 0;
    await withTransaction(pool, async (tx) => {
      calls++;
      await lockSession(tx, f.sessionId);
      await lockDoctor(tx, f.doctorId);
    }).catch(() => {});
    expect(calls).toBe(1);
  });

  it('requires ascending ids within one rank: lock a batch, not one by one in the wrong order', async () => {
    const a = await makeFixture(pool);
    const b = await makeFixture(pool);
    const [lo, hi] = [a.doctorId, b.doctorId].sort() as [string, string];
    const wrong = await withTransaction(pool, async (tx) => {
      await lockDoctor(tx, hi);
      await lockDoctor(tx, lo);
    }).catch((e) => e);
    expect(wrong).toBeInstanceOf(LockOrderError);
    const rows = await withTransaction(pool, (tx) => lockDoctors(tx, [hi, lo, hi]));
    expect(rows.map((r) => r.id)).toEqual([lo, hi]); // sorted, de-duplicated
  });

  it('re-locking an already held id is a harmless no-op', async () => {
    const f = await makeFixture(pool);
    await withTransaction(pool, async (tx) => {
      await lockDoctor(tx, f.doctorId);
      await lockDoctor(tx, f.doctorId);
      await lockSession(tx, f.sessionId);
      await lockSession(tx, f.sessionId);
    });
  });

  it('missing rows raise NotFoundError', async () => {
    const err = await withTransaction(pool, (tx) => lockDoctor(tx, '00000000-0000-4000-8000-000000000000')).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it('capacity primitives and bumpQueueVersion refuse to run without their lock', async () => {
    const f = await makeFixture(pool);
    const noCap = await withTransaction(pool, (tx) => reserveBooked(tx, f.sessionId)).catch((e) => e);
    expect(noCap).toBeInstanceOf(LockOrderError);
    const noSession = await withTransaction(pool, (tx) => bumpQueueVersion(tx, f.sessionId)).catch((e) => e);
    expect(noSession).toBeInstanceOf(LockOrderError);
    const v = await withTransaction(pool, async (tx) => {
      await lockSession(tx, f.sessionId);
      return bumpQueueVersion(tx, f.sessionId);
    });
    expect(v).toBe(1);
  });

  it('batches locked in opposite orders by two transactions never deadlock (sorted internally)', async () => {
    const f = await makeFixture(pool);
    const s2 = await addSession(pool, f);
    const attempts: number[] = [];
    const run = (ids: string[]) =>
      withTransaction(pool, async (tx) => {
        attempts.push(tx.attempt);
        await lockDoctor(tx, f.doctorId);
        await lockSessions(tx, ids);
        await lockCapacities(tx, ids);
        await new Promise((r) => setTimeout(r, 5));
      });
    for (let i = 0; i < 10; i++) {
      await Promise.all([run([f.sessionId, s2]), run([s2, f.sessionId]), run([f.sessionId, s2]), run([s2, f.sessionId])]);
    }
    expect(Math.max(...attempts)).toBe(1); // no deadlock retries were needed
  });

  it('a booking holding the capacity lock does not deadlock with a call-next holding the doctor lock (FK key-share vs NO KEY UPDATE)', async () => {
    const f = await makeFixture(pool, { patients: 1 });
    const { insertAppointment } = await import('../src/index.js');
    const attempts: number[] = [];
    const booking = withTransaction(pool, async (tx) => {
      attempts.push(tx.attempt);
      const s = await lockSession(tx, f.sessionId);
      await lockCapacity(tx, f.sessionId);
      await new Promise((r) => setTimeout(r, 100));
      const allocationId = await reserveBooked(tx, f.sessionId);
      // FK check on doctors/sessions takes FOR KEY SHARE; must not wait for a doctor FOR NO KEY UPDATE holder
      await insertAppointment(tx, {
        patientId: f.patientIds[0]!,
        sessionId: f.sessionId,
        doctorId: f.doctorId,
        scheduledAt: s.startsAt,
        allocationId,
        bookedBy: f.userId,
      });
    });
    await new Promise((r) => setTimeout(r, 20));
    const callNext = withTransaction(pool, async (tx) => {
      attempts.push(tx.attempt);
      await lockDoctor(tx, f.doctorId);
      await lockSession(tx, f.sessionId); // waits for the booking to finish
    });
    await Promise.all([booking, callNext]);
    expect(Math.max(...attempts)).toBe(1);
  });
});
