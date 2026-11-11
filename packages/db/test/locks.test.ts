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
import { addSession, makeFixture, nth, TEST_DB, testUrl } from './helpers.js';

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

  it('throws LockOrderError for session -> doctor (a second doctor after a session)', async () => {
    const f = await makeFixture(pool);
    const other = await pool.query<{ id: string }>(
      `INSERT INTO doctors (hospital_id, full_name, department, room) VALUES ($1, 'Dr Other', 'ENT', 'OPD 9') RETURNING id`,
      [f.hospitalId],
    );
    const err = await withTransaction(pool, async (tx) => {
      await lockDoctor(tx, f.doctorId);
      await lockSession(tx, f.sessionId);
      await lockDoctor(tx, nth(other.rows, 0).id);
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LockOrderError);
    expect(err.message).toMatch(/doctor lock requested after session/);
  });

  it('lockSession without the doctor lock throws LockOrderError and takes no session lock', async () => {
    const f = await makeFixture(pool);
    const err = await withTransaction(pool, async (tx) => {
      await lockSession(tx, f.sessionId);
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LockOrderError);
    expect(err.message).toMatch(/requires the doctor lock/);
    // a holder of a different doctor does not satisfy the assertion either
    const other = await pool.query<{ id: string }>(
      `INSERT INTO doctors (hospital_id, full_name, department, room) VALUES ($1, 'Dr Other', 'ENT', 'OPD 9') RETURNING id`,
      [f.hospitalId],
    );
    const wrong = await withTransaction(pool, async (tx) => {
      await lockDoctor(tx, nth(other.rows, 0).id);
      await lockSessions(tx, [f.sessionId]);
    }).catch((e) => e);
    expect(wrong).toBeInstanceOf(LockOrderError);
  });

  it('lockSessions asserts the doctor of every session in the batch', async () => {
    const f = await makeFixture(pool);
    const g = await makeFixture(pool);
    const err = await withTransaction(pool, async (tx) => {
      await lockDoctor(tx, f.doctorId);
      await lockSessions(tx, [f.sessionId, g.sessionId]); // g's doctor is not held
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LockOrderError);
  });

  it('lockCapacity / lockCapacities without the session lock throw LockOrderError', async () => {
    const f = await makeFixture(pool);
    const one = await withTransaction(pool, async (tx) => {
      await lockDoctor(tx, f.doctorId);
      await lockCapacity(tx, f.sessionId);
    }).catch((e) => e);
    expect(one).toBeInstanceOf(LockOrderError);
    expect(one.message).toMatch(/requires the session lock/);
    const s2 = await addSession(pool, f);
    const many = await withTransaction(pool, async (tx) => {
      await lockDoctor(tx, f.doctorId);
      await lockSession(tx, f.sessionId);
      await lockCapacities(tx, [f.sessionId, s2]); // s2's session is not locked
    }).catch((e) => e);
    expect(many).toBeInstanceOf(LockOrderError);
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
      await lockDoctor(tx, f.doctorId);
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

  it('a held doctor lock does not block FK key-share inserts (why guards use FOR NO KEY UPDATE, D-017)', async () => {
    const f = await makeFixture(pool);
    let holderDone = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let locked: () => void = () => {};
    const hasLock = new Promise<void>((r) => (locked = r));
    const holder = withTransaction(pool, async (tx) => {
      await lockDoctor(tx, f.doctorId);
      locked();
      await gate;
      holderDone = true;
    });
    await hasLock;
    // Inserting a session row takes FOR KEY SHARE on the doctor; with FOR UPDATE guards this would wait
    // for the holder (and deadlock against a booking that holds a later guard). It must go straight through.
    await addSession(pool, f);
    expect(holderDone).toBe(false);
    release();
    await holder;
  });
});
