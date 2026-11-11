/**
 * Playwright global setup: the REAL stack for the end-to-end flow, nothing mocked.
 *
 *  1. recreate the scratch database `hqms_e2e_test`, migrate and seed it (real PostgreSQL);
 *  2. build and start the API bundle (`apps/api/dist/main.js`);
 *  3. start the Vite dev server of apps/web with its `/api` proxy pointed at that API;
 *  4. wait until both answer, export their URLs to the specs through process.env, and stop both on teardown.
 *
 * Ports are fixed (and overridable) because Playwright re-reads the config in every worker.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createPool, migrate } from '@hqms/db';
import { seed } from '../../db/seed/seed.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

export const E2E_API_PORT = Number(process.env['E2E_API_PORT'] ?? 3188);
export const E2E_WEB_PORT = Number(process.env['E2E_WEB_PORT'] ?? 5188);
const DB_NAME = process.env['E2E_DB_NAME'] ?? 'hqms_e2e_test';
const ADMIN_URL = process.env['TEST_ADMIN_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/postgres';

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
  execFileSync('pnpm', ['--filter', '@hqms/api', 'build'], { cwd: repoRoot, stdio: 'pipe' });
  if (!existsSync(resolve(repoRoot, 'apps/api/dist/main.js')))
    throw new Error('apps/api/dist/main.js is missing after the build');
}

async function waitFor(url: string, child: ChildProcess, logs: string[], what: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${what} exited early (code ${child.exitCode}):\n${logs.join('')}`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${what} did not answer ${url} within ${ms / 1000} s:\n${logs.join('')}`);
}

function collect(child: ChildProcess): string[] {
  const logs: string[] = [];
  const keep = (b: Buffer): void => {
    logs.push(b.toString());
    if (logs.length > 300) logs.shift();
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  return logs;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
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

export default async function globalSetup(): Promise<() => Promise<void>> {
  const databaseUrl = await recreateDatabase();
  buildApi();

  const apiUrl = `http://127.0.0.1:${E2E_API_PORT}`;
  const webUrl = `http://127.0.0.1:${E2E_WEB_PORT}`;

  const api = spawn(process.execPath, ['dist/main.js'], {
    cwd: resolve(repoRoot, 'apps/api'),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PORT: String(E2E_API_PORT),
      NODE_ENV: 'test',
      DB_POOL_MAX: '20',
      LOGIN_RATE_LIMIT_MAX: '100000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const apiLogs = collect(api);

  const web = spawn(
    process.execPath,
    [
      resolve(repoRoot, 'apps/web/node_modules/vite/bin/vite.js'),
      '--port',
      String(E2E_WEB_PORT),
      '--strictPort',
      '--host',
      '127.0.0.1',
    ],
    { cwd: resolve(repoRoot, 'apps/web'), env: { ...process.env, API_URL: apiUrl }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const webLogs = collect(web);

  try {
    await waitFor(`${apiUrl}/health`, api, apiLogs, 'API');
    await waitFor(`${webUrl}/login`, web, webLogs, 'Vite dev server');
  } catch (err) {
    await Promise.all([stop(api), stop(web)]);
    throw err;
  }

  process.env['E2E_API_URL'] = apiUrl;
  process.env['E2E_WEB_URL'] = webUrl;
  process.env['E2E_DATABASE_URL'] = databaseUrl;

  return async () => {
    await Promise.all([stop(api), stop(web)]);
    const bad = apiLogs
      .join('')
      .split('\n')
      .filter((l) => /ERROR|Unhandled|deadlock/i.test(l));
    if (bad.length > 0)
      console.warn(`[e2e] API log contains ${bad.length} error line(s):\n${bad.slice(0, 10).join('\n')}`);
  };
}
