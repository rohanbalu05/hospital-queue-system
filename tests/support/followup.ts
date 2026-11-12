/**
 * Helpers for the T4 / T6 black-box suites: a REAL worker process (apps/worker/dist) that shares the database and the
 * object-storage directory with the API child, multipart uploads over real HTTP, fixture documents, polling.
 * Nothing here talks to the database except through the shared pool in world.ts (read-only invariant queries).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inject } from 'vitest';
import type { ApiClient, ApiResponse } from './client.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

export const storageDir = (): string => inject('storageDir');

// ---------------------------------------------------------------------------------------------------
// Worker process
// ---------------------------------------------------------------------------------------------------

export interface RunningWorker {
  child: ChildProcess;
  /** Every line the worker wrote (JSON logs), newest last, capped. */
  logs: string[];
  stop(): Promise<void>;
}

function buildWorker(): void {
  if (process.env['SKIP_WORKER_BUILD'] === '1' && existsSync(resolve(repoRoot, 'apps/worker/dist/main.js'))) return;
  try {
    execFileSync('pnpm', ['--filter', '@hqms/worker', 'build'], { cwd: repoRoot, stdio: 'pipe' });
  } catch (err) {
    throw new Error(`Could not build the worker. Run \`pnpm --filter @hqms/worker build\` first.\n${String(err)}`);
  }
}

/**
 * Start the built worker as a child process. By default it runs only the document jobs (ocr_document,
 * reconcile_uploads) so it never touches queue timers of other suites; STORAGE_DIR is the API child's directory.
 */
export async function startWorker(
  databaseUrl: string,
  opts: { env?: Record<string, string>; backoffCapSec?: number } = {},
): Promise<RunningWorker> {
  buildWorker();
  const logs: string[] = [];
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: resolve(repoRoot, 'apps/worker'),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      STORAGE_DIR: storageDir(),
      OBJECT_STORAGE: 'local-disk',
      OCR_PROVIDER: 'fake',
      WORKER_JOB_TYPES: 'ocr_document,reconcile_uploads',
      WORKER_DISPATCH_OUTBOX: 'false',
      WORKER_POLL_MS: '100',
      WORKER_BACKOFF_CAP_SEC: String(opts.backoffCapSec ?? 1),
      WORKER_ID: `blackbox-worker-${process.pid}`,
      LOG_LEVEL: 'info',
      ...opts.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const keep = (b: Buffer): void => {
    logs.push(...b.toString().split('\n').filter(Boolean));
    while (logs.length > 2000) logs.shift();
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  // Wait until the worker reports that it started (or died).
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`worker exited early (code ${child.exitCode}):\n${logs.join('\n')}`);
    if (logs.some((l) => l.includes('worker.started'))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    child,
    logs,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise<void>((done) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          done();
        }, 8000);
        child.once('exit', () => {
          clearTimeout(t);
          done();
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A PNG-typed upload whose body carries the fake OCR provider's fixture marker. The text files under
 * tests/fixtures/documents hold the `HQMS-FIXTURE:<name>` line; the PNG magic number makes the API accept the type.
 * `nonce` keeps every upload's bytes (and hash) unique.
 */
export function fixtureDocument(name: string, nonce: string = String(Math.random())): Buffer {
  const path = resolve(here, '..', 'fixtures', 'documents', `${name}.txt`);
  const text = readFileSync(path, 'utf8');
  return Buffer.concat([PNG_MAGIC, Buffer.from(`\n${text}\nnonce:${nonce}\n`, 'latin1')]);
}

/** POST /documents as a multipart form over real HTTP with the client's cookie. */
export async function uploadDocument(
  client: ApiClient,
  patientId: string | undefined,
  bytes: Buffer,
  fileName = 'prescription.png',
  mime = 'image/png',
): Promise<ApiResponse> {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(bytes)], { type: mime }), fileName);
  if (patientId) form.set('patientId', patientId);
  const t0 = performance.now();
  const res = await fetch(`${client.baseUrl}/documents`, {
    method: 'POST',
    headers: client.cookie ? { Cookie: client.cookie } : {},
    body: form,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    /* raw text */
  }
  return { status: res.status, body: body as any, headers: res.headers, ms: performance.now() - t0 };
}

/** Download a document's bytes (GET /documents/:id/file). Returns the raw status and bytes. */
export async function downloadDocument(client: ApiClient, id: string): Promise<{ status: number; bytes: Buffer }> {
  const res = await fetch(`${client.baseUrl}/documents/${id}/file`, {
    headers: client.cookie ? { Cookie: client.cookie } : {},
  });
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
}

/** Poll `probe` until it returns a truthy value; fails with `what` and the last value after `timeoutMs`. */
export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const futureIso = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString();

/**
 * Fingerprint of the tables that decide who is booked, queued and called: queue_entries, appointments, visits,
 * session_capacity and capacity_allocations (full rows). Equal before and after means a request changed none of them.
 */
export async function coreFingerprint(query: (sql: string) => Promise<Array<{ h: string | null }>>): Promise<string> {
  const parts: string[] = [];
  for (const t of ['queue_entries', 'appointments', 'visits', 'session_capacity', 'capacity_allocations']) {
    const r = await query(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`);
    parts.push(`${t}:${r[0]?.h}`);
  }
  return parts.join(';');
}
