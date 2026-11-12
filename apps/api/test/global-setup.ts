import pg from 'pg';
import { createPool, migrate } from '@hqms/db';
import { seed } from '../../../db/seed/seed.js';

/** Fresh per-run `hqms_test_api_<pid>` database: created, migrated and seeded (demo password demo1234) before any test runs. */
export default async function setup(): Promise<() => Promise<void>> {
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
  return teardown; // vitest runs the returned function after the last test file
}

/** Drop the per-run scratch database once every test file is done. */
async function teardown(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  const adminUrl = process.env['TEST_ADMIN_DATABASE_URL'];
  if (!url || !adminUrl) return;
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!/(^|_)test($|_)/.test(name)) return;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
