import { createDatabase, TEST_DB, testUrl } from './helpers.js';
import { createPool, migrate } from '../src/index.js';

/** Fresh scratch database for this builder, so parallel builders never collide on hqms_test. */
export default async function setup(): Promise<void> {
  await createDatabase(TEST_DB);
  const pool = createPool(testUrl(TEST_DB), { max: 2 });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
