import pg from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';
import { NotFoundError } from './errors.js';

const { Pool, types } = pg;

/** The documented local development database (CLAUDE.md). Only used by CLIs, never implicitly by createPool. */
export const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/hqms';

/** Anything that can run a query: a Pool (autocommit reads) or a Tx. Read repositories take this. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
}

/**
 * Value conventions (one place, so repositories and tests agree):
 *  - timestamptz  -> ISO-8601 string in UTC with a trailing `Z` (contracts' `Instant` accepts offsets incl. Z).
 *                    Chosen over Date so rows are JSON-safe and match contract types without conversion.
 *  - date         -> 'YYYY-MM-DD' string (never a JS Date, which would shift by the process time zone).
 *  - int8/bigint  -> number; throws if above Number.MAX_SAFE_INTEGER (queue_version, audit ids fit easily).
 *  - numeric      -> number (parseFloat); ewma_alpha, estimates and minutes are small decimals.
 * Input parameters may be ISO strings or Dates for timestamptz.
 */
const parseTimestamptz = types.getTypeParser(types.builtins.TIMESTAMPTZ) as (v: string) => unknown;

function parseInstant(value: string): string | number {
  const parsed = parseTimestamptz(value);
  if (parsed instanceof Date) return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  return parsed as number; // 'infinity' / '-infinity' come back as +/-Infinity
}

function parseBigint(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`bigint ${value} does not fit in a JS number`);
  return n;
}

const customTypes = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    switch (oid) {
      case types.builtins.TIMESTAMPTZ:
      case types.builtins.TIMESTAMP:
        return parseInstant;
      case types.builtins.DATE:
        return (v: string) => v;
      case types.builtins.INT8:
        return parseBigint;
      case types.builtins.NUMERIC:
        return (v: string) => parseFloat(v);
      default:
        return types.getTypeParser(oid, format as 'text');
    }
  },
};

export interface PoolOptions {
  max?: number;
  applicationName?: string;
}

export function createPool(url: string | undefined = process.env['DATABASE_URL'], options: PoolOptions = {}): pg.Pool {
  if (!url) throw new Error('DATABASE_URL is not set');
  const max = options.max ?? Number(process.env['DB_POOL_MAX'] ?? 10);
  const pool = new Pool({
    connectionString: url,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: options.applicationName ?? 'hqms',
    types: customTypes,
  });
  // An idle client dropping (e.g. Postgres restart) must not crash the process.
  pool.on('error', (err) => {
    console.error('[hqms/db] idle client error:', err.message);
  });
  return pool;
}

let singleton: pg.Pool | undefined;

/** Process-wide pool built from DATABASE_URL on first use. */
export function getPool(): pg.Pool {
  singleton ??= createPool();
  return singleton;
}

export async function closePool(): Promise<void> {
  const p = singleton;
  singleton = undefined;
  if (p) await p.end();
}

export type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/** The value, or NotFoundError(what) when it is null/undefined. Replaces `!` on lookups that must succeed. */
export function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new NotFoundError(what);
  return value;
}

/** First row of a result that must have one (e.g. INSERT ... RETURNING), else NotFoundError(what). */
export function firstRow<R extends QueryResultRow>(res: QueryResult<R>, what: string): R {
  return required(res.rows[0], what);
}

/** Run `fn` with a single query and return the first row, or null. */
export async function maybeOne<R extends QueryResultRow = QueryResultRow>(
  db: Queryable,
  text: string,
  params?: unknown[],
): Promise<R | null> {
  const res = await db.query<R>(text, params);
  return res.rows[0] ?? null;
}

export async function many<R extends QueryResultRow = QueryResultRow>(
  db: Queryable,
  text: string,
  params?: unknown[],
): Promise<R[]> {
  return (await db.query<R>(text, params)).rows;
}

/** Convert a snake_case result row to camelCase keys (shallow). */
export function camel<T = Record<string, unknown>>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out as T;
}
