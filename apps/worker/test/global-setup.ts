import pg from 'pg';
import { createPool, migrate } from '@hqms/db';
import { seed } from '../../../db/seed/seed.js';
import { TEST_DB, adminUrl, testUrl } from './helpers.js';

/** Own scratch database (hqms_test_worker_w3), so parallel builders never collide. Migrated and seeded. */
export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${TEST_DB}"`);
  } finally {
    await admin.end();
  }
  const pool = createPool(testUrl(), { max: 2 });
  try {
    await migrate(pool);
    await seed(pool);
  } finally {
    await pool.end();
  }
}
