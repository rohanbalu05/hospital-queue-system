import { createHash } from 'node:crypto';
import type { Queryable } from './pool.js';

/** Identity of one idempotent command: unique (actor, operation, key) + a hash of the request. */
export interface IdempotencyOptions {
  actorId: string;
  operation: string;
  key: string;
  requestHash: string;
}

/** What an idempotent command returns and what is stored for replay. */
export interface IdempotentResponse<B = unknown> {
  status: number;
  body: B;
}

export type IdempotentResult<B = unknown> = IdempotentResponse<B> & { replayed: boolean };

/** Canonical JSON: object keys sorted recursively, `undefined` members dropped, Dates as ISO strings. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonicalize(v)));
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    if (v !== undefined) out[k] = canonicalize(v);
  }
  return out;
}

/** SHA-256 (hex) of the canonical JSON of `value`. Key order and undefined members do not matter. */
export function hashRequest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * Rank 0 of the lock order (before doctor): a transaction-scoped advisory lock on the hash of
 * (actor, operation, key). Two concurrent requests with the same identity therefore run one after
 * the other; the second then finds the first one's stored response and replays it.
 */
export async function lockIdempotencyIdentity(db: Queryable, id: IdempotencyOptions): Promise<void> {
  const identity = JSON.stringify([id.actorId, id.operation, id.key]); // unambiguous, no separator collisions
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [identity]);
}

export interface StoredIdempotencyRecord {
  requestHash: string;
  status: number;
  body: unknown;
}

export async function findIdempotencyRecord(
  db: Queryable,
  id: Pick<IdempotencyOptions, 'actorId' | 'operation' | 'key'>,
): Promise<StoredIdempotencyRecord | null> {
  const res = await db.query<{ request_hash: string; response_status: number; response_body: unknown }>(
    `SELECT request_hash, response_status, response_body
       FROM idempotency_records
      WHERE actor_id = $1 AND operation = $2 AND idem_key = $3`,
    [id.actorId, id.operation, id.key],
  );
  const row = res.rows[0];
  return row ? { requestHash: row.request_hash, status: row.response_status, body: row.response_body } : null;
}

export async function storeIdempotencyRecord(
  db: Queryable,
  id: IdempotencyOptions,
  response: IdempotentResponse,
): Promise<void> {
  await db.query(
    `INSERT INTO idempotency_records (actor_id, operation, idem_key, request_hash, response_status, response_body)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [id.actorId, id.operation, id.key, id.requestHash, response.status, JSON.stringify(response.body ?? null)],
  );
}
