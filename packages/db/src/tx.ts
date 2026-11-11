import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { ConflictError, IdempotencyConflictError, LockOrderError, isRetryable, sqlState } from './errors.js';
import {
  findIdempotencyRecord,
  lockIdempotencyIdentity,
  storeIdempotencyRecord,
  type IdempotencyOptions,
  type IdempotentResponse,
  type IdempotentResult,
} from './idempotency.js';
import type { Queryable } from './pool.js';

/**
 * Lock order contract (report §6.5, DECISIONS D-005). Rank 0 is the idempotency advisory lock taken by
 * withTransaction itself; then doctor -> session -> capacity guard. A transaction may only ever move
 * to a higher rank; inside one rank ids are taken in ascending order (the lock helpers sort batches).
 */
export type LockKind = 'doctor' | 'session' | 'capacity';
export const LOCK_RANK: Record<LockKind, number> = { doctor: 1, session: 2, capacity: 3 };

export class Tx implements Queryable {
  private highestRank = 0;
  private readonly held: Record<LockKind, Set<string>> = {
    doctor: new Set(),
    session: new Set(),
    capacity: new Set(),
  };
  private readonly lastId: Partial<Record<LockKind, string>> = {};

  constructor(
    readonly client: PoolClient,
    /** 1-based attempt number (greater than 1 after a serialization/deadlock retry). */
    readonly attempt = 1,
  ) {}

  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>> {
    return this.client.query<R>(text, params);
  }

  /** True when this transaction already holds the `kind` lock for `id` (doctor id, or session id for session/capacity). */
  holds(kind: LockKind, id: string): boolean {
    return this.held[kind].has(id.toLowerCase());
  }

  /** Snapshot of everything locked so far, for diagnostics and tests. */
  lockedIds(): Record<LockKind, string[]> {
    return { doctor: [...this.held.doctor], session: [...this.held.session], capacity: [...this.held.capacity] };
  }

  /** Throws LockOrderError unless the lock is held; capacity primitives call this. */
  assertHolds(kind: LockKind, id: string, why: string): void {
    if (!this.holds(kind, id)) {
      throw new LockOrderError(`${why} requires the ${kind} lock for ${id} (lock order: doctor -> session -> capacity)`);
    }
  }

  /** @internal Validate lock order before issuing the SELECT ... FOR NO KEY UPDATE. */
  checkOrder(kind: LockKind, ids: string[]): void {
    const rank = LOCK_RANK[kind];
    if (rank < this.highestRank) {
      const higher = (Object.keys(LOCK_RANK) as LockKind[]).find((k) => LOCK_RANK[k] === this.highestRank);
      throw new LockOrderError(
        `Lock order violation: ${kind} lock requested after ${higher} lock (required order: doctor -> session -> capacity)`,
      );
    }
    const fresh = ids.map((i) => i.toLowerCase()).filter((i) => !this.held[kind].has(i));
    const last = this.lastId[kind];
    if (last !== undefined && fresh.some((i) => i < last)) {
      throw new LockOrderError(
        `Lock order violation: ${kind} ids must be locked in ascending order within a transaction (last locked ${last}); lock them in one batch`,
      );
    }
  }

  /** @internal Record locks after the SELECT succeeded. */
  recordLocks(kind: LockKind, ids: string[]): void {
    this.highestRank = Math.max(this.highestRank, LOCK_RANK[kind]);
    for (const raw of ids) {
      const id = raw.toLowerCase();
      this.held[kind].add(id);
      const last = this.lastId[kind];
      if (last === undefined || id > last) this.lastId[kind] = id;
    }
  }
}

export interface TxOptions {
  idempotency?: IdempotencyOptions;
  /** Total attempts including the first (default 3, capped at 10). Only 40001 and 40P01 are retried. */
  maxAttempts?: number;
  /** SET LOCAL lock_timeout (default 5000 ms). On expiry (55P03) a ConflictError(CONFLICT) is raised, not retried. */
  lockTimeoutMs?: number;
  /** SET LOCAL statement_timeout (default 15000 ms). */
  statementTimeoutMs?: number;
  /** Default READ COMMITTED; the guard design relies on row locks, not on higher isolation. */
  isolation?: 'read committed' | 'repeatable read' | 'serializable';
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Small jittered exponential backoff: 10-20ms, 20-40ms, ... */
function backoffMs(attempt: number): number {
  const base = 10 * 2 ** (attempt - 1);
  return base + Math.random() * base;
}

export function withTransaction<B>(
  pool: Pool,
  fn: (tx: Tx) => Promise<IdempotentResponse<B>>,
  opts: TxOptions & { idempotency: IdempotencyOptions },
): Promise<IdempotentResult<B>>;
export function withTransaction<T>(
  pool: Pool,
  fn: (tx: Tx) => Promise<T>,
  opts?: TxOptions & { idempotency?: undefined },
): Promise<T>;
/**
 * Run `fn` in one short READ COMMITTED transaction on one checked-out client.
 *
 *  - Retries the whole function (fresh transaction, same idempotency identity) on 40001 / 40P01,
 *    at most `maxAttempts` (default 3) times; afterwards throws ConflictError(CONFLICT).
 *  - 55P03 (lock_timeout) -> ConflictError(CONFLICT), never retried forever.
 *  - With `idempotency`: takes the rank-0 advisory lock, replays a stored response when the same
 *    request hash was seen, throws IdempotencyConflictError on a different hash, otherwise runs `fn`
 *    (which must return `{status, body}`) and stores that response in the same transaction.
 *  - Callers write domain rows, audit row and outbox/job intent inside `fn`; do no external I/O there.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (tx: Tx) => Promise<T>,
  opts: TxOptions = {},
): Promise<unknown> {
  const maxAttempts = Math.min(Math.max(opts.maxAttempts ?? 3, 1), 10);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await runOnce(pool, fn, opts, attempt);
    } catch (err) {
      if (isRetryable(err)) {
        lastError = err;
        if (attempt < maxAttempts) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new ConflictError(
          'CONFLICT',
          'Could not complete the request because of concurrent updates; please retry',
          { sqlstate: sqlState(err), attempts: attempt },
          { cause: err },
        );
      }
      if (sqlState(err) === '55P03') {
        throw new ConflictError('CONFLICT', 'The resource is busy; please retry', { sqlstate: '55P03' }, { cause: err });
      }
      throw err;
    }
  }
  /* istanbul ignore next */
  throw lastError;
}

async function runOnce<T>(pool: Pool, fn: (tx: Tx) => Promise<T>, opts: TxOptions, attempt: number): Promise<unknown> {
  const client = await pool.connect();
  let rollbackFailed = false;
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${(opts.isolation ?? 'read committed').toUpperCase()}`);
    try {
      await client.query(`SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)`, [
        `${opts.lockTimeoutMs ?? 5000}ms`,
        `${opts.statementTimeoutMs ?? 15000}ms`,
      ]);
      const tx = new Tx(client, attempt);

      let result: unknown;
      const idem = opts.idempotency;
      if (idem) {
        await lockIdempotencyIdentity(tx, idem);
        const existing = await findIdempotencyRecord(tx, idem);
        if (existing) {
          if (existing.requestHash !== idem.requestHash) {
            throw new IdempotencyConflictError({ actorId: idem.actorId, operation: idem.operation, key: idem.key });
          }
          result = { status: existing.status, body: existing.body, replayed: true } satisfies IdempotentResult;
        } else {
          const response = (await fn(tx)) as IdempotentResponse;
          await storeIdempotencyRecord(tx, idem, response);
          result = { status: response.status, body: response.body, replayed: false } satisfies IdempotentResult;
        }
      } else {
        result = await fn(tx);
      }
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        rollbackFailed = true;
      }
      throw err;
    }
  } finally {
    client.release(rollbackFailed ? new Error('rollback failed') : undefined);
  }
}
