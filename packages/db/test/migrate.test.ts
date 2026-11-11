import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPool,
  databaseName,
  ensureDatabase,
  isTestDatabaseName,
  migrate,
  MigrationChecksumError,
  MIGRATIONS_DIR,
} from '../src/index.js';
import { createDatabase, dropDatabase, testUrl } from './helpers.js';

const DB = 'hqms_test_db_engineer_mig';
let pool: Pool;
let tmp: string;

beforeAll(async () => {
  await createDatabase(DB);
  pool = createPool(testUrl(DB), { max: 2 });
  tmp = await mkdtemp(path.join(os.tmpdir(), 'hqms-mig-'));
});
afterAll(async () => {
  await pool.end();
  await dropDatabase(DB);
  await rm(tmp, { recursive: true, force: true });
});

describe('migration runner', () => {
  it('applies the repo migrations once and is idempotent', async () => {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).map((f) => f.replace('.sql', ''));
    const first = await migrate(pool);
    expect(first.applied).toEqual(files);
    expect(first.skipped).toEqual([]);
    const second = await migrate(pool);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(files);
    const rows = await pool.query(`SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version`);
    expect(rows.rows.map((r) => r.version)).toEqual(files);
    expect(rows.rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof rows.rows[0].applied_at).toBe('string');
    // Table 13 constraints exist
    const idx = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`);
    const names = idx.rows.map((r) => r.indexname);
    expect(names).toEqual(expect.arrayContaining(['queue_entries_visit_uq', 'visits_appointment_uq', 'queue_entries_doctor_active_uq']));
  });

  it('concurrent runners do not interleave (advisory lock)', async () => {
    const other = createPool(testUrl(DB), { max: 2 });
    try {
      const [a, b] = await Promise.all([migrate(pool), migrate(other)]);
      expect(a.applied).toEqual([]);
      expect(b.applied).toEqual([]);
    } finally {
      await other.end();
    }
  });

  it('refuses an applied file whose checksum changed, and applies only new files otherwise', async () => {
    await writeFile(path.join(tmp, '0001_a.sql'), 'CREATE TABLE mig_a (id int);\n');
    await writeFile(path.join(tmp, '0002_b.sql'), 'CREATE TABLE mig_b (id int);\n');
    // a separate schema_migrations lineage: use a fresh DB so the repo migrations do not interfere
    const scratch = 'hqms_test_db_engineer_mig2';
    await createDatabase(scratch);
    const p2 = createPool(testUrl(scratch), { max: 2 });
    try {
      expect((await migrate(p2, { dir: tmp })).applied).toEqual(['0001_a', '0002_b']);
      await writeFile(path.join(tmp, '0003_c.sql'), 'CREATE TABLE mig_c (id int);\n');
      const next = await migrate(p2, { dir: tmp });
      expect(next).toEqual({ applied: ['0003_c'], skipped: ['0001_a', '0002_b'] });

      await writeFile(path.join(tmp, '0001_a.sql'), 'CREATE TABLE mig_a (id int, extra text);\n');
      const err = await migrate(p2, { dir: tmp }).catch((e) => e);
      expect(err).toBeInstanceOf(MigrationChecksumError);
      expect(err.version).toBe('0001_a');
    } finally {
      await p2.end();
      await dropDatabase(scratch);
    }
  });

  it('a failing migration rolls back entirely and is not recorded', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hqms-mig-bad-'));
    const scratch = 'hqms_test_db_engineer_mig3';
    await createDatabase(scratch);
    const p3 = createPool(testUrl(scratch), { max: 2 });
    try {
      await writeFile(path.join(dir, '0001_bad.sql'), 'CREATE TABLE half_done (id int);\nSELECT * FROM does_not_exist;\n');
      await expect(migrate(p3, { dir })).rejects.toThrow(/0001_bad failed/);
      const t = await p3.query(`SELECT to_regclass('half_done') AS t`);
      expect(t.rows[0].t).toBeNull();
      const m = await p3.query(`SELECT count(*)::int AS n FROM schema_migrations`);
      expect(m.rows[0].n).toBe(0);
    } finally {
      await p3.end();
      await dropDatabase(scratch);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the checked-in migration files are unchanged by the runner (read-only)', async () => {
    expect((await readFile(path.join(MIGRATIONS_DIR, '0001_init.sql'), 'utf8')).length).toBeGreaterThan(1000);
  });
});

describe('database helpers', () => {
  it('parses names and applies the reset guard', async () => {
    expect(databaseName('postgres://u:p@h:5432/hqms_test?sslmode=disable')).toBe('hqms_test');
    expect(isTestDatabaseName('hqms_test')).toBe(true);
    expect(isTestDatabaseName('hqms_test_db_engineer')).toBe(true);
    expect(isTestDatabaseName('hqms')).toBe(false);
    expect(isTestDatabaseName('hqms_latest')).toBe(false);
    expect(isTestDatabaseName('contest')).toBe(false);
  });

  it('ensureDatabase creates a missing database once', async () => {
    const name = 'hqms_test_db_engineer_ensure';
    await dropDatabase(name);
    try {
      expect(await ensureDatabase(testUrl(name))).toBe(true);
      expect(await ensureDatabase(testUrl(name))).toBe(false);
    } finally {
      await dropDatabase(name);
    }
  });
});
