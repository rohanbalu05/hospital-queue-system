import { createPool, migrate } from '@hqms/db';
import type { AppConfig } from './common/config.js';

/**
 * Optional start-up database preparation (docker-compose sets both flags):
 * RUN_MIGRATIONS_ON_START applies pending migrations, SEED_ON_START additionally loads the idempotent
 * demo seed. Runs on its own short-lived pool before the HTTP server listens.
 */
export async function prepareDatabase(config: AppConfig, log: (msg: string) => void): Promise<void> {
  if (!config.runMigrationsOnStart && !config.seedOnStart) return;
  const pool = createPool(config.databaseUrl, { max: 2, applicationName: 'hqms-api-bootstrap' });
  try {
    const res = await migrate(pool, { log });
    log(`migrations: ${res.applied.length} applied, ${res.skipped.length} already applied`);
    if (config.seedOnStart) {
      const { seed } = await import('../../../db/seed/seed.js');
      await seed(pool, { log });
    }
  } finally {
    await pool.end();
  }
}
