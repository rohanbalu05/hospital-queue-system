/**
 * CLI: `pnpm --filter @hqms/db migrate | seed | reset [--force]`
 *
 *   migrate  create the database if missing, apply pending migrations
 *   seed     migrate, then idempotent demo seed (demo password demo1234)
 *   reset    drop + recreate the public schema, migrate, seed. Refuses unless the database name has a
 *            `test` segment (hqms_test, ...), NODE_ENV=development, or --force is given.
 */
import {
  createPool,
  DEFAULT_DATABASE_URL,
  databaseName,
  dropPublicSchema,
  ensureDatabase,
  isTestDatabaseName,
  migrate,
} from './index.js';
import { seed } from '../../../db/seed/seed.js';

async function main(): Promise<void> {
  const [command, ...flags] = process.argv.slice(2);
  const url = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
  const name = databaseName(url);
  const log = (m: string) => console.log(`[db] ${m}`);

  if (command !== 'migrate' && command !== 'seed' && command !== 'reset') {
    console.error('usage: cli.ts migrate | seed | reset [--force]');
    process.exitCode = 2;
    return;
  }

  if (command === 'reset') {
    const allowed = isTestDatabaseName(name) || process.env['NODE_ENV'] === 'development' || flags.includes('--force');
    if (!allowed) {
      console.error(
        `[db] refusing to reset "${name}": not a test database. Use --force or NODE_ENV=development if you really mean it.`,
      );
      process.exitCode = 1;
      return;
    }
  }

  if (await ensureDatabase(url)) log(`created database ${name}`);
  const pool = createPool(url, { max: 4, applicationName: 'hqms-db-cli' });
  try {
    if (command === 'reset') {
      await dropPublicSchema(pool);
      log(`dropped and recreated schema public in ${name}`);
    }
    const res = await migrate(pool, { log });
    log(`migrations: ${res.applied.length} applied, ${res.skipped.length} already applied`);
    if (command === 'seed' || command === 'reset') await seed(pool, { log });
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
