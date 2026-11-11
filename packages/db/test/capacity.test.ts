import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admitWalkin,
  capacityInvariant,
  ConflictError,
  consumeAllocation,
  createPool,
  getAppointment,
  insertAppointment,
  lockCapacities,
  lockCapacity,
  lockDoctor,
  lockSession,
  lockSessions,
  releaseAllocation,
  reserveBooked,
  setAppointmentStatus,
  updateCapacity,
  type Tx,
  withTransaction,
} from '../src/index.js';
import { addSession, bookOne, makeFixture, TEST_DB, testUrl, type Fixture } from './helpers.js';

let pool: Pool;
beforeAll(() => {
  pool = createPool(testUrl(TEST_DB), { max: 20 });
});
afterAll(async () => {
  await pool.end();
});

/** The booking transaction every racer runs: doctor -> session -> capacity, reserve, insert appointment. */
function race(f: Fixture, patientId: string) {
  return withTransaction(pool, async (tx) => {
    await lockDoctor(tx, f.doctorId);
    const s = await lockSession(tx, f.sessionId);
    await lockCapacity(tx, f.sessionId);
    const allocationId = await reserveBooked(tx, f.sessionId);
    const a = await insertAppointment(tx, {
      patientId,
      sessionId: f.sessionId,
      doctorId: f.doctorId,
      scheduledAt: s.startsAt,
      allocationId,
      bookedBy: f.userId,
    });
    return a.id;
  });
}

describe('T1 (persistence level): N parallel connections race for the last place', () => {
  it('20 concurrent bookings, 1 place left: exactly one succeeds; counters match allocation rows', async () => {
    const f = await makeFixture(pool, { booked: 5, patients: 20 });
    for (let i = 0; i < 4; i++) await bookOne(pool, f, f.patientIds[i]!); // 4 of 5 taken, 1 left
    expect((await capacityInvariant(pool, f.sessionId)).counters.bookedReserved).toBe(4);

    const racers = f.patientIds.slice(0, 20).map((p) => race(f, p).then((id) => ({ ok: true as const, id }), (e) => ({ ok: false as const, e })));
    const results = await Promise.all(racers);

    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r): r is { ok: false; e: any } => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(19);
    for (const l of losses) {
      expect(l.e).toBeInstanceOf(ConflictError);
      expect(l.e.code).toBe('CAPACITY_FULL');
    }

    const inv = await capacityInvariant(pool, f.sessionId);
    expect(inv).toMatchObject({ ok: true, counters: { bookedReserved: 5 }, counted: { booked: 5 } });
    const appts = await pool.query(`SELECT count(*)::int AS n FROM appointments WHERE session_id = $1`, [f.sessionId]);
    expect(appts.rows[0].n).toBe(5);
    const allocs = await pool.query(`SELECT count(*)::int AS n FROM capacity_allocations WHERE session_id = $1`, [f.sessionId]);
    expect(allocs.rows[0].n).toBe(5); // losers left no orphan allocation rows
  });

  it('repeats the race several times with different capacities', async () => {
    for (const booked of [1, 3, 7]) {
      const f = await makeFixture(pool, { booked, patients: 20 });
      const results = await Promise.all(f.patientIds.map((p) => race(f, p).then(() => true, () => false)));
      expect(results.filter(Boolean)).toHaveLength(booked);
      expect((await capacityInvariant(pool, f.sessionId)).ok).toBe(true);
    }
  });

  it('walk-in admissions race the same way against walk-in capacity', async () => {
    const f = await makeFixture(pool, { booked: 5, walkin: 2 });
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        withTransaction(pool, async (tx) => {
          await lockDoctor(tx, f.doctorId);
          await lockSession(tx, f.sessionId);
          await lockCapacity(tx, f.sessionId);
          return admitWalkin(tx, f.sessionId);
        }).then(() => true, (e) => (e instanceof ConflictError && e.code === 'CAPACITY_FULL' ? false : Promise.reject(e))),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(await capacityInvariant(pool, f.sessionId)).toMatchObject({ ok: true, counters: { walkinUsed: 2 } });
  });
});

describe('allocation state machine', () => {
  it('release gives the place back; releasing twice does not double-decrement', async () => {
    const f = await makeFixture(pool, { booked: 2, patients: 1 });
    const { allocationId } = await bookOne(pool, f, f.patientIds[0]!);
    const out = await withTransaction(pool, async (tx) => {
      await lockSession(tx, f.sessionId);
      await lockCapacity(tx, f.sessionId);
      const first = await releaseAllocation(tx, allocationId);
      const second = await releaseAllocation(tx, allocationId);
      return [first, second];
    });
    expect(out).toEqual(['released', 'already_released']);
    expect(await capacityInvariant(pool, f.sessionId)).toMatchObject({ ok: true, counters: { bookedReserved: 0 } });
  });

  it('consumed never reopens (FR-04): release is refused and counters stay', async () => {
    const f = await makeFixture(pool, { booked: 2, patients: 1 });
    const { allocationId } = await bookOne(pool, f, f.patientIds[0]!);
    await withTransaction(pool, async (tx) => {
      await lockSession(tx, f.sessionId);
      await lockCapacity(tx, f.sessionId);
      await consumeAllocation(tx, allocationId);
    });
    const err = await withTransaction(pool, async (tx) => {
      await lockSession(tx, f.sessionId);
      await lockCapacity(tx, f.sessionId);
      await releaseAllocation(tx, allocationId);
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('INVALID_TRANSITION');
    const st = await pool.query(`SELECT state FROM capacity_allocations WHERE id = $1`, [allocationId]);
    expect(st.rows[0].state).toBe('consumed');
    expect(await capacityInvariant(pool, f.sessionId)).toMatchObject({ ok: true, counters: { bookedReserved: 1 } });
    // and a consumed allocation cannot be consumed twice
    const again = await withTransaction(pool, async (tx) => {
      await lockSession(tx, f.sessionId);
      await lockCapacity(tx, f.sessionId);
      await consumeAllocation(tx, allocationId);
    }).catch((e) => e);
    expect(again.code).toBe('INVALID_TRANSITION');
  });

  it('a released allocation cannot be consumed', async () => {
    const f = await makeFixture(pool, { booked: 2, patients: 1 });
    const { allocationId } = await bookOne(pool, f, f.patientIds[0]!);
    const err = await withTransaction(pool, async (tx) => {
      await lockSession(tx, f.sessionId);
      await lockCapacity(tx, f.sessionId);
      await releaseAllocation(tx, allocationId);
      await consumeAllocation(tx, allocationId);
    }).catch((e) => e);
    expect(err.code).toBe('INVALID_TRANSITION');
    // whole transaction rolled back: still reserved
    const st = await pool.query(`SELECT state FROM capacity_allocations WHERE id = $1`, [allocationId]);
    expect(st.rows[0].state).toBe('reserved');
  });
});

describe('updateCapacity', () => {
  it('rejects reduction below current usage, accepts at or above, and bumps versions', async () => {
    const f = await makeFixture(pool, { booked: 5, walkin: 2, patients: 3 });
    for (const p of f.patientIds) await bookOne(pool, f, p);
    await withTransaction(pool, async (tx) => {
      await lockSession(tx, f.sessionId);
      await lockCapacity(tx, f.sessionId);
      await admitWalkin(tx, f.sessionId);
    });

    const lock = async (tx: Tx) => {
      await lockSession(tx, f.sessionId);
      await lockCapacity(tx, f.sessionId);
    };
    const tooLow = await withTransaction(pool, async (tx) => {
      await lock(tx);
      await updateCapacity(tx, f.sessionId, 2, 2);
    }).catch((e) => e);
    expect(tooLow).toBeInstanceOf(ConflictError);
    expect(tooLow.code).toBe('INVALID_CAPACITY_REDUCTION');
    expect(tooLow.details).toMatchObject({ bookedReserved: 3, walkinUsed: 1 });

    const walkTooLow = await withTransaction(pool, async (tx) => {
      await lock(tx);
      await updateCapacity(tx, f.sessionId, 5, 0);
    }).catch((e) => e);
    expect(walkTooLow.code).toBe('INVALID_CAPACITY_REDUCTION');

    const ok = await withTransaction(pool, async (tx) => {
      await lock(tx);
      return updateCapacity(tx, f.sessionId, 3, 1);
    });
    expect(ok).toMatchObject({ bookedCapacity: 3, walkinCapacity: 1, bookedAvailable: 0, walkinAvailable: 0 });
    const grown = await withTransaction(pool, async (tx) => {
      await lock(tx);
      return updateCapacity(tx, f.sessionId, 12, 6);
    });
    expect(grown).toMatchObject({ bookedAvailable: 9, walkinAvailable: 5 });
  });

  it('expectedVersion is a compare-and-set on the session version', async () => {
    const f = await makeFixture(pool);
    const err = await withTransaction(pool, async (tx) => {
      await lockSession(tx, f.sessionId);
      await lockCapacity(tx, f.sessionId);
      await updateCapacity(tx, f.sessionId, 6, 2, { expectedVersion: 99 });
    }).catch((e) => e);
    expect(err.code).toBe('CONFLICT');
  });
});

describe('reschedule atomicity (reserve target, then release original, one transaction)', () => {
  /** Reschedule as the scheduling module will do it: lock both guards in sorted order. */
  function reschedule(f: Fixture, appointmentId: string, targetSessionId: string, failAfterRelease = false) {
    return withTransaction(pool, async (tx) => {
      const appt = (await getAppointment(tx, appointmentId))!;
      await lockDoctor(tx, f.doctorId);
      const sessions = await lockSessions(tx, [appt.sessionId, targetSessionId]);
      await lockCapacities(tx, [appt.sessionId, targetSessionId]);
      const target = sessions.find((s) => s.id === targetSessionId)!;
      const newAlloc = await reserveBooked(tx, targetSessionId); // CAPACITY_FULL here aborts before anything is released
      await releaseAllocation(tx, appt.allocationId);
      await setAppointmentStatus(tx, appt.id, 'rescheduled');
      const moved = await insertAppointment(tx, {
        patientId: appt.patientId,
        sessionId: targetSessionId,
        doctorId: f.doctorId,
        scheduledAt: target.startsAt,
        allocationId: newAlloc,
        bookedBy: f.userId,
        rescheduledFromId: appt.id,
      });
      if (failAfterRelease) throw new Error('simulated failure after release');
      return moved.id;
    });
  }

  async function snapshot(sessionId: string, appointmentId: string) {
    const a = await pool.query(
      `SELECT a.status, a.version, al.state FROM appointments a JOIN capacity_allocations al ON al.id = a.allocation_id WHERE a.id = $1`,
      [appointmentId],
    );
    return { appt: a.rows[0], cap: await capacityInvariant(pool, sessionId) };
  }

  it('target full: the reschedule fails and the original appointment is intact', async () => {
    const f = await makeFixture(pool, { booked: 5, patients: 2 });
    const target = await addSession(pool, f, { booked: 1 });
    const original = await bookOne(pool, f, f.patientIds[0]!);
    await bookOne(pool, f, f.patientIds[1]!, target); // target now full
    const before = await snapshot(f.sessionId, original.appointmentId);

    const err = await reschedule(f, original.appointmentId, target).catch((e) => e);
    expect(err.code).toBe('CAPACITY_FULL');

    expect(await snapshot(f.sessionId, original.appointmentId)).toEqual(before);
    expect(before.appt).toMatchObject({ status: 'booked', state: 'reserved' });
    expect((await capacityInvariant(pool, target)).counters.bookedReserved).toBe(1);
  });

  it('failure after the release rolls everything back, including the release', async () => {
    const f = await makeFixture(pool, { booked: 5, patients: 1 });
    const target = await addSession(pool, f, { booked: 3 });
    const original = await bookOne(pool, f, f.patientIds[0]!);
    const before = await snapshot(f.sessionId, original.appointmentId);
    await expect(reschedule(f, original.appointmentId, target, true)).rejects.toThrow('simulated failure');
    expect(await snapshot(f.sessionId, original.appointmentId)).toEqual(before);
    expect((await capacityInvariant(pool, target)).counters.bookedReserved).toBe(0);
    const moved = await pool.query(`SELECT count(*)::int AS n FROM appointments WHERE session_id = $1`, [target]);
    expect(moved.rows[0].n).toBe(0);
  });

  it('success: target reserved, original released, link recorded', async () => {
    const f = await makeFixture(pool, { booked: 5, patients: 1 });
    const target = await addSession(pool, f, { booked: 3 });
    const original = await bookOne(pool, f, f.patientIds[0]!);
    const movedId = await reschedule(f, original.appointmentId, target);
    const moved = (await getAppointment(pool, movedId))!;
    expect(moved).toMatchObject({ sessionId: target, status: 'booked', rescheduledFromId: original.appointmentId });
    expect((await getAppointment(pool, original.appointmentId))!.status).toBe('rescheduled');
    expect((await capacityInvariant(pool, f.sessionId)).counters.bookedReserved).toBe(0);
    expect((await capacityInvariant(pool, target)).counters.bookedReserved).toBe(1);
  });

  it('two patients rescheduling in opposite directions at once do not deadlock or oversubscribe', async () => {
    const f = await makeFixture(pool, { booked: 1, patients: 2 });
    const other = await addSession(pool, f, { booked: 1 });
    const a = await bookOne(pool, f, f.patientIds[0]!, f.sessionId);
    const b = await bookOne(pool, f, f.patientIds[1]!, other);
    // both sessions are full: each reschedule must fail cleanly (CAPACITY_FULL), none may deadlock
    const results = await Promise.all([
      reschedule(f, a.appointmentId, other).catch((e) => e.code),
      reschedule(f, b.appointmentId, f.sessionId).catch((e) => e.code),
    ]);
    expect(results).toEqual(['CAPACITY_FULL', 'CAPACITY_FULL']);
    expect((await capacityInvariant(pool, f.sessionId)).ok).toBe(true);
    expect((await capacityInvariant(pool, other)).ok).toBe(true);
  });
});
