/**
 * Global setup for the black-box suites (integration + concurrency).
 *
 * 1. (Re)create the scratch database `hqms_test_blackbox`, migrate and seed it (real PostgreSQL, no mocks).
 * 2. Build the API bundle (tsup, ~2 s) so the tests always run the current source.
 * 3. Start `node apps/api/dist/main.js` as a child process on a free port with DB_POOL_MAX=30
 *    (>= 20, so 50 parallel requests are limited by Postgres locks, not by a tiny pool).
 * 4. Wait for GET /health, hand the URLs to the tests with `provide`, and stop the child on teardown.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { GlobalSetupContext } from 'vitest/node';
import { createPool, migrate } from '@hqms/db';
import { seed } from '../../db/seed/seed.js';

declare module 'vitest' {
  export interface ProvidedContext {
    apiUrl: string;
    databaseUrl: string;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const DB_NAME = process.env['BLACKBOX_DB_NAME'] ?? 'hqms_test_blackbox';
const ADMIN_URL = process.env['TEST_ADMIN_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/postgres';

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => ok(port));
    });
  });
}

async function recreateDatabase(): Promise<string> {
  if (!/(^|_)test($|_)/.test(DB_NAME)) throw new Error(`refusing to recreate non-test database ${DB_NAME}`);
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${DB_NAME}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${DB_NAME}`;
  const databaseUrl = url.toString();
  const pool = createPool(databaseUrl, { max: 2 });
  try {
    await migrate(pool);
    await seed(pool);
  } finally {
    await pool.end();
  }
  return databaseUrl;
}

function buildApi(): void {
  if (process.env['SKIP_API_BUILD'] === '1' && existsSync(resolve(repoRoot, 'apps/api/dist/main.js'))) return;
  try {
    execFileSync('pnpm', ['--filter', '@hqms/api', 'build'], { cwd: repoRoot, stdio: 'pipe' });
  } catch (err) {
    throw new Error(
      `Could not build the API. Run \`pnpm --filter @hqms/api build\` and fix the errors first.\n${String(err)}`,
    );
  }
  if (!existsSync(resolve(repoRoot, 'apps/api/dist/main.js'))) {
    throw new Error('apps/api/dist/main.js is missing after the build: run `pnpm --filter @hqms/api build`.');
  }
}

async function waitForHealth(url: string, child: ChildProcess, logs: string[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API exited early (code ${child.exitCode}):\n${logs.join('')}`);
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`API did not become healthy within 30 s:\n${logs.join('')}`);
}

export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  const databaseUrl = await recreateDatabase();
  buildApi();
  const port = await freePort();
  const logs: string[] = [];
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: resolve(repoRoot, 'apps/api'),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PORT: String(port),
      NODE_ENV: 'test',
      DB_POOL_MAX: process.env['DB_POOL_MAX'] ?? '30',
      LOGIN_RATE_LIMIT_MAX: '100000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const keep = (b: Buffer) => {
    logs.push(b.toString());
    if (logs.length > 400) logs.shift();
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  const apiUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(apiUrl, child, logs);
  } catch (err) {
    child.kill('SIGKILL');
    throw err;
  }
  provide('apiUrl', apiUrl);
  provide('databaseUrl', databaseUrl);

  return async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((done) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          done();
        }, 5000);
        child.once('exit', () => {
          clearTimeout(t);
          done();
        });
      });
    }
    // Server-side error lines are surfaced so a 5xx or deadlock never goes unnoticed.
    const bad = logs
      .join('')
      .split('\n')
      .filter((l) => /ERROR|Unhandled|deadlock/i.test(l));
    if (bad.length > 0) {
      console.warn(`[blackbox] API log contains ${bad.length} error line(s):\n${bad.slice(0, 10).join('\n')}`);
    }
  };
}
