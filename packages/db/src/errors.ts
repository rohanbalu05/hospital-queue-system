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
    super(
      'IDEMPOTENCY_KEY_REUSED',
      'Idempotency-Key was already used with a different request',
      details,
    );
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

/** Retryable by the transaction helper: serialization failure or deadlock detected. */
export function isRetryable(err: unknown): boolean {
  const s = sqlState(err);
  return s === '40001' || s === '40P01';
}
