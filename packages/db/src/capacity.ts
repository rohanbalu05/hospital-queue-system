import type { Capacity } from '@hqms/contracts';
import { ConflictError, NotFoundError } from './errors.js';
import { toCapacity, type CapacityLockRow } from './locks.js';
import { firstRow } from './pool.js';
import type { Tx } from './tx.js';

/*
 * Capacity primitives: the integrity core for T1 (report §6.5, Table 13).
 *
 * Every function requires the caller to already hold the capacity lock of the session
 * (lockCapacity), taken after doctor and session. They assert that and throw LockOrderError
 * otherwise. Counters and allocation rows change in the same statement sequence, inside the
 * caller's transaction, so they cannot diverge:
 *   booked_reserved = count(booked allocations in reserved | consumed)
 *   walkin_used     = count(walkin allocations in reserved | consumed)
 * State machine: reserved -> consumed | released. Consumed never reopens (FR-04).
 */

export type AllocationKind = 'booked' | 'walkin';
export type AllocationState = 'reserved' | 'consumed' | 'released';

export interface AllocationRow {
  id: string;
  sessionId: string;
  kind: AllocationKind;
  state: AllocationState;
}

/** Reserve one booked place. Throws ConflictError(CAPACITY_FULL) when none is left. Returns the allocation id. */
export async function reserveBooked(tx: Tx, sessionId: string): Promise<string> {
  tx.assertHolds('capacity', sessionId, 'reserveBooked');
  const upd = await tx.query(
    `UPDATE session_capacity
        SET booked_reserved = booked_reserved + 1, version = version + 1, updated_at = now()
      WHERE session_id = $1 AND booked_reserved < booked_capacity`,
    [sessionId],
  );
  if (upd.rowCount === 0) await throwFull(tx, sessionId, 'booked');
  return insertAllocation(tx, sessionId, 'booked', 'reserved');
}

/**
 * Admit one walk-in (counts against walk-in capacity). The allocation is created already consumed:
 * a walk-in has no earlier reservation. Throws ConflictError(CAPACITY_FULL) when walk-in capacity is used up.
 */
export async function admitWalkin(tx: Tx, sessionId: string): Promise<string> {
  tx.assertHolds('capacity', sessionId, 'admitWalkin');
  const upd = await tx.query(
    `UPDATE session_capacity
        SET walkin_used = walkin_used + 1, version = version + 1, updated_at = now()
      WHERE session_id = $1 AND walkin_used < walkin_capacity`,
    [sessionId],
  );
  if (upd.rowCount === 0) await throwFull(tx, sessionId, 'walkin');
  return insertAllocation(tx, sessionId, 'walkin', 'consumed');
}

async function insertAllocation(tx: Tx, sessionId: string, kind: AllocationKind, state: AllocationState): Promise<string> {
  const res = await tx.query<{ id: string }>(
    `INSERT INTO capacity_allocations (session_id, kind, state) VALUES ($1, $2, $3) RETURNING id`,
    [sessionId, kind, state],
  );
  return firstRow(res, 'capacity_allocation').id;
}

async function throwFull(tx: Tx, sessionId: string, kind: AllocationKind): Promise<never> {
  const res = await tx.query(
    `SELECT booked_capacity, walkin_capacity, booked_reserved, walkin_used, version FROM session_capacity WHERE session_id = $1`,
    [sessionId],
  );
  const row = res.rows[0];
  if (!row) throw new NotFoundError('session_capacity', sessionId);
  throw new ConflictError('CAPACITY_FULL', `No ${kind === 'booked' ? 'booked' : 'walk-in'} places left in this session`, {
    kind,
    sessionId,
    capacity: kind === 'booked' ? row.booked_capacity : row.walkin_capacity,
    used: kind === 'booked' ? row.booked_reserved : row.walkin_used,
  });
}

async function readAllocation(tx: Tx, allocationId: string): Promise<AllocationRow> {
  // Unlocked read only to learn the (immutable) session id; the state is re-checked by the guarded UPDATE.
  const res = await tx.query<{ id: string; session_id: string; kind: AllocationKind; state: AllocationState }>(
    `SELECT id, session_id, kind, state FROM capacity_allocations WHERE id = $1`,
    [allocationId],
  );
  const r = res.rows[0];
  if (!r) throw new NotFoundError('capacity_allocation', allocationId);
  return { id: r.id, sessionId: r.session_id, kind: r.kind, state: r.state };
}

/** reserved -> consumed (check-in). Any other state throws ConflictError(INVALID_TRANSITION). Counters are unchanged. */
export async function consumeAllocation(tx: Tx, allocationId: string): Promise<void> {
  const a = await readAllocation(tx, allocationId);
  tx.assertHolds('capacity', a.sessionId, 'consumeAllocation');
  const upd = await tx.query(
    `UPDATE capacity_allocations SET state = 'consumed', updated_at = now() WHERE id = $1 AND state = 'reserved'`,
    [allocationId],
  );
  if (upd.rowCount === 0) {
    const cur = await readAllocation(tx, allocationId);
    throw new ConflictError('INVALID_TRANSITION', `Allocation is ${cur.state}, only a reserved allocation can be consumed`, {
      allocationId,
      state: cur.state,
    });
  }
}

/**
 * reserved -> released, giving the place back. Consumed allocations never reopen: throws
 * ConflictError(INVALID_TRANSITION). Releasing an already released allocation is a no-op returning
 * 'already_released' (timers and cancellations may race; the second one must not double-decrement).
 */
export async function releaseAllocation(tx: Tx, allocationId: string): Promise<'released' | 'already_released'> {
  const a = await readAllocation(tx, allocationId);
  tx.assertHolds('capacity', a.sessionId, 'releaseAllocation');
  const upd = await tx.query(
    `UPDATE capacity_allocations SET state = 'released', updated_at = now() WHERE id = $1 AND state = 'reserved'`,
    [allocationId],
  );
  if (upd.rowCount === 0) {
    const cur = await readAllocation(tx, allocationId);
    if (cur.state === 'released') return 'already_released';
    throw new ConflictError('INVALID_TRANSITION', 'A consumed allocation never reopens capacity', {
      allocationId,
      state: cur.state,
    });
  }
  // Only booked allocations can be 'reserved'; walk-ins are created consumed.
  await tx.query(
    `UPDATE session_capacity SET booked_reserved = booked_reserved - 1, version = version + 1, updated_at = now() WHERE session_id = $1`,
    [a.sessionId],
  );
  return 'released';
}

export interface UpdateCapacityOptions {
  /** Compare-and-set against sessions.version (the version the client last saw). Mismatch -> ConflictError(CONFLICT). */
  expectedVersion?: number;
}

/**
 * Admin capacity change. Requires the session lock (its version is bumped) and the capacity lock.
 * Reducing below current usage throws ConflictError(INVALID_CAPACITY_REDUCTION).
 */
export async function updateCapacity(
  tx: Tx,
  sessionId: string,
  bookedCapacity: number,
  walkinCapacity: number,
  opts: UpdateCapacityOptions = {},
): Promise<Capacity & { version: number }> {
  tx.assertHolds('session', sessionId, 'updateCapacity');
  tx.assertHolds('capacity', sessionId, 'updateCapacity');
  if (!Number.isInteger(bookedCapacity) || !Number.isInteger(walkinCapacity) || bookedCapacity < 0 || walkinCapacity < 0) {
    throw new TypeError('capacity must be non-negative integers (validate request bodies with the contract first)');
  }
  if (opts.expectedVersion !== undefined) {
    const v = await tx.query<{ version: number }>(`SELECT version FROM sessions WHERE id = $1`, [sessionId]);
    if (v.rows[0]?.version !== opts.expectedVersion) {
      throw new ConflictError('CONFLICT', 'Session was changed by someone else', {
        expectedVersion: opts.expectedVersion,
        currentVersion: v.rows[0]?.version ?? null,
      });
    }
  }
  const cur = await tx.query(
    `SELECT booked_reserved, walkin_used FROM session_capacity WHERE session_id = $1`,
    [sessionId],
  );
  const row = cur.rows[0];
  if (!row) throw new NotFoundError('session_capacity', sessionId);
  if (bookedCapacity < row.booked_reserved || walkinCapacity < row.walkin_used) {
    throw new ConflictError('INVALID_CAPACITY_REDUCTION', 'Capacity cannot be reduced below places already in use', {
      bookedReserved: row.booked_reserved,
      walkinUsed: row.walkin_used,
      requestedBooked: bookedCapacity,
      requestedWalkin: walkinCapacity,
    });
  }
  const upd = await tx.query(
    `UPDATE session_capacity
        SET booked_capacity = $2, walkin_capacity = $3, version = version + 1, updated_at = now()
      WHERE session_id = $1
      RETURNING session_id, booked_capacity, walkin_capacity, booked_reserved, walkin_used, version`,
    [sessionId, bookedCapacity, walkinCapacity],
  );
  await tx.query(`UPDATE sessions SET version = version + 1, updated_at = now() WHERE id = $1`, [sessionId]);
  const c: CapacityLockRow = toCapacity(firstRow(upd, 'session_capacity'));
  return c;
}

/** Re-count allocations and compare with the counters (used by tests and the admin consistency check). */
export async function capacityInvariant(
  tx: { query: Tx['query'] },
  sessionId: string,
): Promise<{ ok: boolean; counters: { bookedReserved: number; walkinUsed: number }; counted: { booked: number; walkin: number } }> {
  const res = await tx.query(
    `SELECT sc.booked_reserved, sc.walkin_used,
            count(*) FILTER (WHERE a.kind = 'booked' AND a.state IN ('reserved','consumed'))::int AS booked,
            count(*) FILTER (WHERE a.kind = 'walkin' AND a.state IN ('reserved','consumed'))::int AS walkin
       FROM session_capacity sc
       LEFT JOIN capacity_allocations a ON a.session_id = sc.session_id
      WHERE sc.session_id = $1
      GROUP BY sc.session_id`,
    [sessionId],
  );
  const r = res.rows[0];
  if (!r) throw new NotFoundError('session_capacity', sessionId);
  return {
    ok: r.booked_reserved === r.booked && r.walkin_used === r.walkin,
    counters: { bookedReserved: r.booked_reserved, walkinUsed: r.walkin_used },
    counted: { booked: r.booked, walkin: r.walkin },
  };
}
