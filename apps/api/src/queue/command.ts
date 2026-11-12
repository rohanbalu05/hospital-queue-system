import { hashRequest, withTransaction, type IdempotentResult, type Pool, type Tx } from '@hqms/db';
import { conflict } from '../common/errors.js';
import type { RequestCtx } from '../common/request-context.js';

/**
 * Run one state-changing command in one short transaction. With an Idempotency-Key the response is stored
 * and replayed (same (actor, operation, key) and request hash); without one the command still runs once,
 * protected by `expectedVersion` and the state machines.
 */
export async function runCommand<B>(
  pool: Pool,
  ctx: RequestCtx,
  operation: string,
  key: string | undefined,
  requestIdentity: unknown,
  work: (tx: Tx) => Promise<{ status: number; body: B }>,
): Promise<IdempotentResult<B>> {
  if (key === undefined) {
    const r = await withTransaction(pool, work);
    return { ...r, replayed: false };
  }
  return withTransaction(pool, work, {
    idempotency: {
      actorId: ctx.user.userId,
      operation,
      key,
      requestHash: hashRequest(requestIdentity),
    },
  });
}

/** Stale expectedVersion -> controlled 409 CONFLICT (never a 500). */
export function assertVersion(expected: number | undefined, current: number, what: string): void {
  if (expected !== undefined && expected !== current) {
    throw conflict('CONFLICT', `${what} was changed by someone else; refresh and try again`, {
      expectedVersion: expected,
      currentVersion: current,
    });
  }
}
