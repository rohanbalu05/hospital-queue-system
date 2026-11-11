import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Pool } from 'pg';
import { MigrationChecksumError } from './errors.js';

/** Repository `db/migrations` directory (packages/db/src -> repo root). */
export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

/** Fixed advisory-lock key so two migrators (init.sh and a dev server) never interleave. */
const MIGRATION_LOCK_KEY = 7_263_001;

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export interface MigrateOptions {
  dir?: string;
  log?: (msg: string) => void;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Apply `*.sql` files in lexical order. One transaction per file; the version row is inserted in the
 * same transaction. A file whose checksum differs from the recorded one is refused (never re-applied,
 * never silently skipped): fix forward with a new migration.
 */
export async function migrate(pool: Pool, options: MigrateOptions = {}): Promise<MigrateResult> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const log = options.log ?? (() => {});
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  const result: MigrateResult = { applied: [], skipped: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Map<string, string>(
      (await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations')).rows.map(
        (r) => [r.version, r.checksum],
      ),
    );
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = sha256(sql);
      const recorded = done.get(version);
      if (recorded !== undefined) {
        if (recorded !== checksum) throw new MigrationChecksumError(version, recorded, checksum);
        result.skipped.push(version);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [version, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${version} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      log(`applied ${version}`);
      result.applied.push(version);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

/** Database name from a connection URL. */
export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/** Create the database named in `url` if it does not exist yet (connects to the `postgres` maintenance DB). */
export async function ensureDatabase(url: string): Promise<boolean> {
  const name = databaseName(url);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount) return false;
    await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    return true;
  } finally {
    await client.end();
  }
}

/** A database is safe to wipe when its name has a `test` segment (hqms_test, hqms_test_db_engineer, ...). */
export function isTestDatabaseName(name: string): boolean {
  return /(^|_)test($|_)/i.test(name);
}

/** Drop and recreate the public schema (all tables, sequences, the pgcrypto extension). Caller must have checked the guard. */
export async function dropPublicSchema(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
}
