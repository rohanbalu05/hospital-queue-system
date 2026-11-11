import pg from 'pg';
import { createPool, migrate } from '@hqms/db';
import { seed } from '../../../db/seed/seed.js';

/** Fresh `hqms_test_api` database: created, migrated and seeded (demo password demo1234) before any test runs. */
export default async function setup(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  const adminUrl = process.env['TEST_ADMIN_DATABASE_URL'];
  if (!url || !adminUrl) throw new Error('DATABASE_URL / TEST_ADMIN_DATABASE_URL must be set by vitest.config.ts');
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!/(^|_)test($|_)/.test(name)) throw new Error(`refusing to recreate non-test database ${name}`);

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const pool = createPool(url, { max: 2 });
  try {
    await migrate(pool);
    await seed(pool);
  } finally {
    await pool.end();
  }
}
