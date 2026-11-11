import type { ErrorCode } from '@hqms/contracts';

/**
 * Typed errors raised by @hqms/db. Each carries the contract `ErrorCode` and the HTTP status the API
 * layer should map it to, so the API error filter needs no knowledge of SQL.
 */

/** Stale state, capacity exhaustion, invalid transitions, idempotency reuse, retry exhaustion: HTTP 409. */
export class ConflictError extends Error {
  readonly status = 409 as const;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ConflictError';
  }
}

/** A row that must exist (and be visible to the caller) does not: HTTP 404. */
export class NotFoundError extends Error {
  readonly status = 404 as const;
  readonly code = 'NOT_FOUND' as const satisfies ErrorCode;
  constructor(
    readonly entity: string,
    readonly entityId?: string,
  ) {
    super(entityId ? `${entity} ${entityId} not found` : `${entity} not found`);
    this.name = 'NotFoundError';
  }
}

/**
 * Programming error: a lock was requested out of the doctor -> session -> capacity order,
 * a lower id was locked after a higher one within one rank, or a primitive ran without its lock.
 * Never retried, never a client error (HTTP 500 INTERNAL).
 */
export class LockOrderError extends Error {
  readonly status = 500 as const;
  readonly code = 'INTERNAL' as const satisfies ErrorCode;
  constructor(message: string) {
    super(message);
    this.name = 'LockOrderError';
  }
}

/** Same (actor, operation, key) reused with a different request hash: HTTP 409 IDEMPOTENCY_KEY_REUSED. */
export class IdempotencyConflictError extends ConflictError {
  constructor(details: { actorId: string; operation: string; key: string }) {
    super('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request', details);
    this.name = 'IdempotencyConflictError';
  }
}

/** A migration file that was already applied has changed on disk. */
export class MigrationChecksumError extends Error {
  constructor(
    readonly version: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Migration ${version} was modified after it was applied (checksum ${actual} != recorded ${expected})`);
    this.name = 'MigrationChecksumError';
  }
}

/** SQLSTATE of a pg error, if it is one. */
export function sqlState(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'string' && code.length === 5) return code;
  }
  return undefined;
}

/**
 * The database connection was lost, refused or could not be obtained: HTTP 503 SERVICE_UNAVAILABLE with
 * Retry-After. Never retried inside withTransaction: when `outcomeUnknown` is true the connection dropped
 * while COMMIT was in flight, so the transaction may or may not have committed. Safe client retries rely
 * on the idempotency key (a replay returns the stored response, or re-runs when nothing was stored).
 */
export class DatabaseUnavailableError extends Error {
  readonly status = 503 as const;
  readonly code = 'SERVICE_UNAVAILABLE' as const satisfies ErrorCode;
  readonly retryAfterSec = 2;
  constructor(
    message: string,
    readonly outcomeUnknown = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DatabaseUnavailableError';
  }
}

const CONNECTION_SQLSTATES = new Set([
  '57P01',
  '57P02',
  '57P03',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '53300',
]);
const CONNECTION_ERRNOS = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNABORTED',
]);
const CONNECTION_MESSAGES = [
  'connection terminated',
  'client has encountered a connection error',
  'connection error',
  'timeout exceeded when trying to connect',
  'cannot use a pool after calling end',
  'server closed the connection unexpectedly',
];

/** True for connection-level failures: terminated backend, shutdown, refused/reset socket, pool connect timeout. */
export function isConnectionError(err: unknown): boolean {
  if (err instanceof DatabaseUnavailableError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const state = sqlState(err);
  if (state && CONNECTION_SQLSTATES.has(state)) return true;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && CONNECTION_ERRNOS.has(code)) return true;
  if (err instanceof AggregateError) return err.errors.some(isConnectionError);
  const message = (err as { message?: unknown }).message;
  if (typeof message === 'string') {
    const m = message.toLowerCase();
    return CONNECTION_MESSAGES.some((s) => m.includes(s));
  }
  return false;
}

/** Retryable by the transaction helper: serialization failure or deadlock detected. */
export function isRetryable(err: unknown): boolean {
  const s = sqlState(err);
  return s === '40001' || s === '40P01';
}
