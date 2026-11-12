/**
 * Shared harness for the T5 load and failure scripts (not vitest): scratch databases, the API and worker as real child
 * processes started from their built bundles, a small timed HTTP client, a /proc sampler and the invariant checks.
 * Everything talks to the real API over HTTP and to the real PostgreSQL; nothing is mocked.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { cpus, totalmem, loadavg } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createPool, migrate } from '@hqms/db';
import { seed, stableId } from '../../../db/seed/seed.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are JSON of known shapes that each script narrows */

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..', '..', '..');
export const evidenceDir = resolve(repoRoot, 'docs', 'evidence');
export const ADMIN_URL = process.env['TEST_ADMIN_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/postgres';
export const PASSWORD = 'demo1234';

export const dbUrl = (name: string): string => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  return u.toString();
};

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const round1 = (n: number): number => Math.round(n * 10) / 10;
export const doctorId = (n: number): string => stableId(`doctor:${n}`);
export const doctorEmail = (n: number): string => (n === 1 ? 'doctor@hqms.test' : `doctor${n}@hqms.test`);

export function istDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export function percentile(values: ArrayLike<number>, p: number): number {
  if (values.length === 0) return NaN;
  const sorted = Float64Array.from(values as ArrayLike<number>).sort();
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

export function dist(values: number[]): { n: number; p50: number; p95: number; p99: number; max: number; mean: number } {
  if (values.length === 0) return { n: 0, p50: NaN, p95: NaN, p99: NaN, max: NaN, mean: NaN };
  const sorted = Float64Array.from(values).sort();
  const at = (p: number): number => sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1] as number;
  let sum = 0;
  for (const v of values) sum += v;
  return {
    n: values.length,
    p50: round1(at(50)),
    p95: round1(at(95)),
    p99: round1(at(99)),
    max: round1(sorted[sorted.length - 1] as number),
    mean: round1(sum / values.length),
  };
}

// ---------------------------------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------------------------------

export async function adminQuery(sql: string): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

/** Own databases only: the name must start with one of the prefixes this evidence run owns. */
const OWN_PREFIXES = ['hqms_load', 'hqms_restore', 'hqms_fail', 'hqms_test_blackbox_t5'];
function assertOwn(name: string): void {
  if (!OWN_PREFIXES.some((p) => name.startsWith(p))) throw new Error(`refusing to touch database ${name} (not one of ours)`);
}

export async function dropDb(name: string): Promise<void> {
  assertOwn(name);
  await adminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

/** Drop and create `name`, migrate and (by default) seed the demo data. */
export async function recreateDb(name: string, opts: { seed?: boolean } = {}): Promise<string> {
  assertOwn(name);
  await dropDb(name);
  await adminQuery(`CREATE DATABASE "${name}"`);
  const url = dbUrl(name);
  const pool = createPool(url, { max: 2 });
  try {
    await migrate(pool);
    if (opts.seed !== false) await seed(pool, { env: { ...process.env, NODE_ENV: 'development' } });
  } finally {
    await pool.end();
  }
  return url;
}

export function newPool(name: string, max = 4): pg.Pool {
  return new pg.Pool({ connectionString: dbUrl(name), max });
}

// ---------------------------------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------------------------------

export function buildAll(): void {
  if (process.env['SKIP_BUILD'] === '1' && existsSync(resolve(repoRoot, 'apps/api/dist/main.js')) && existsSync(resolve(repoRoot, 'apps/worker/dist/main.js'))) return;
  execFileSync('pnpm', ['--filter', '@hqms/api', 'build'], { cwd: repoRoot, stdio: 'pipe' });
  execFileSync('pnpm', ['--filter', '@hqms/worker', 'build'], { cwd: repoRoot, stdio: 'pipe' });
}

export function freePort(): Promise<number> {
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

export interface Proc {
  child: ChildProcess;
  pid: number;
  logs: string[];
  /** Resolves with the exit code or signal. */
  exited: Promise<string>;
  /** Filled when the process exits: exact code, signal and time (null until then). */
  exitInfo(): { code: number | null; signal: string | null; at: string } | null;
  /** Path of the file that receives its stdout and stderr (when LOAD_LOG_DIR is set). */
  logFile?: string;
  alive(): boolean;
  kill9(): Promise<void>;
  stop(): Promise<void>;
}

function wrap(child: ChildProcess, logs: string[], logName?: string): Proc {
  let file: WriteStream | undefined;
  let logFile: string | undefined;
  const dir = process.env['LOAD_LOG_DIR'];
  if (dir && logName) {
    mkdirSync(dir, { recursive: true });
    logFile = resolve(dir, `${logName}.log`);
    file = createWriteStream(logFile, { flags: 'a' });
    file.write(`[t5-harness] ${logName} pid ${child.pid} started ${new Date().toISOString()}\n`);
  }
  const info: { exitInfo: ReturnType<Proc['exitInfo']> } = { exitInfo: null };
  const exited = new Promise<string>((ok) =>
    child.once('exit', (code, sig) => {
      const what = `${String(code ?? sig)}`;
      info.exitInfo = { code, signal: sig, at: new Date().toISOString() };
      const line = `[t5-harness] process ${child.pid} exited (code=${String(code)} signal=${String(sig)}) at ${info.exitInfo.at}`;
      logs.push(line);
      file?.write(`${line}\n`);
      ok(what);
    }),
  );
  const keep = (b: Buffer): void => {
    file?.write(b);
    for (const line of b.toString().split('\n')) if (line) logs.push(line);
    if (logs.length > 5000) logs.splice(0, logs.length - 5000);
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  const alive = (): boolean => child.exitCode === null && child.signalCode === null;
  return {
    child,
    pid: child.pid ?? -1,
    logs,
    exited,
    exitInfo: () => info.exitInfo,
    ...(logFile ? { logFile } : {}),
    alive,
    async kill9() {
      if (alive()) child.kill('SIGKILL');
      await exited;
    },
    async stop() {
      if (!alive()) return;
      child.kill('SIGTERM');
      const t = setTimeout(() => child.kill('SIGKILL'), 8000);
      await exited;
      clearTimeout(t);
    },
  };
}

export interface ApiProc extends Proc {
  url: string;
  port: number;
}

/** Start `node apps/api/dist/main.js` on a free (or given) port and wait for /health. */
export async function startApi(opts: { dbName: string; port?: number; env?: Record<string, string> }): Promise<ApiProc> {
  const port = opts.port ?? (await freePort());
  const logs: string[] = [];
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: resolve(repoRoot, 'apps/api'),
    env: {
      ...process.env,
      DATABASE_URL: dbUrl(opts.dbName),
      PORT: String(port),
      NODE_ENV: 'production',
      DB_POOL_MAX: '20',
      LOGIN_RATE_LIMIT_MAX: '1000000',
      // All test clients come from one IP, which a hospital deployment would not have: lift the per-IP caps (declared in the evidence).
      SSE_MAX_PER_IP: '1000',
      SSE_MAX_DISPLAY: '200',
      DISPLAY_RATE_LIMIT_PER_MIN: '100000',
      ...opts.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const proc = wrap(child, logs, 'api');
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 40_000;
  for (;;) {
    if (!proc.alive()) throw new Error(`API exited early:\n${logs.slice(-20).join('\n')}`);
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      await proc.kill9();
      throw new Error(`API did not become healthy:\n${logs.slice(-20).join('\n')}`);
    }
    await sleep(120);
  }
  return { ...proc, url, port };
}

export function startWorker(opts: { dbName: string; id?: string; env?: Record<string, string> }): Proc {
  const logs: string[] = [];
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: resolve(repoRoot, 'apps/worker'),
    env: {
      ...process.env,
      DATABASE_URL: dbUrl(opts.dbName),
      NODE_ENV: 'production',
      WORKER_ID: opts.id ?? `t5-worker-${process.pid}`,
      ...opts.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return wrap(child, logs, 'worker');
}

// ---------------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------------

export interface Res<T = any> {
  /** 0 = network error or timeout (no HTTP response). */
  status: number;
  body: T;
  ms: number;
  code?: string;
  error?: string;
}

export class Http {
  constructor(
    readonly base: string,
    readonly cookie?: string,
    readonly email?: string,
  ) {}

  async call<T = any>(method: string, path: string, body?: unknown, key?: string | null, timeoutMs = 15_000): Promise<Res<T>> {
    const headers: Record<string, string> = {};
    if (this.cookie) headers['Cookie'] = this.cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (key !== null && key !== undefined) headers['Idempotency-Key'] = key;
    const t0 = performance.now();
    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      const ms = performance.now() - t0;
      let parsed: any = text;
      try {
        parsed = text === '' ? null : JSON.parse(text);
      } catch {
        /* keep raw */
      }
      return { status: res.status, body: parsed, ms, ...(parsed?.error?.code ? { code: String(parsed.error.code) } : {}) };
    } catch (err) {
      const cause = err instanceof Error ? (err.cause as { code?: string; message?: string } | undefined) : undefined;
      return { status: 0, body: null as T, ms: performance.now() - t0, error: err instanceof Error ? `${err.name}: ${err.message}${cause ? ` (${cause.code ?? cause.message ?? 'cause'})` : ''}` : String(err) };
    }
  }
  get<T = any>(path: string) {
    return this.call<T>('GET', path);
  }
  post<T = any>(path: string, body: unknown = {}, key?: string | null) {
    return this.call<T>('POST', path, body, key === undefined ? crypto.randomUUID() : key);
  }
}

export async function login(base: string, email: string, password = PASSWORD): Promise<Http> {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login as ${email} failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('hqms_session='));
  if (!cookie) throw new Error(`no session cookie for ${email}`);
  return new Http(base, cookie.split(';')[0], email);
}

// ---------------------------------------------------------------------------------------------------
// Sessions and patients
// ---------------------------------------------------------------------------------------------------

export interface MadeSession {
  id: string;
  doctor: number;
  date: string;
  startsAt: string;
  endsAt: string;
}

/**
 * Create a session. `startMs` is exact (minute-aligned by the caller); today's date is the IST date of `startMs`.
 * A 409 (unique doctor + start) returns undefined.
 */
export async function createSession(
  admin: Http,
  spec: { doctor: number; startMs: number; durationMin: number; booked: number; walkin: number; label?: string; date?: string },
): Promise<MadeSession | undefined> {
  const startsAt = new Date(spec.startMs).toISOString();
  const endsAt = new Date(spec.startMs + spec.durationMin * 60_000).toISOString();
  const date = spec.date ?? istDate(new Date(spec.startMs));
  const res = await admin.post(
    '/sessions',
    {
      doctorId: doctorId(spec.doctor),
      sessionDate: date,
      label: spec.label ?? 'afternoon',
      startsAt,
      endsAt,
      bookedCapacity: spec.booked,
      walkinCapacity: spec.walkin,
    },
    null,
  );
  if (res.status === 201) return { id: res.body.id, doctor: spec.doctor, date, startsAt, endsAt };
  if (res.status === 409) return undefined;
  throw new Error(`could not create session: ${res.status} ${JSON.stringify(res.body)}`);
}

/** Insert `count` synthetic patients by SQL (MRN LD-<n>), return their ids in order. */
export async function bulkPatients(pool: pg.Pool, count: number, prefix = 'LD'): Promise<string[]> {
  const hospital = (await pool.query(`SELECT id FROM hospitals LIMIT 1`)).rows[0].id;
  const r = await pool.query(
    `INSERT INTO patients (id, hospital_id, mrn, full_name, phone)
     SELECT gen_random_uuid(), $1, $2 || '-' || g::text, 'Synthetic Patient ' || g::text, '+91 9' || lpad((g % 1000000000)::text, 9, '0')
       FROM generate_series(1, $3) g
     RETURNING id`,
    [hospital, prefix, count],
  );
  return r.rows.map((x) => x.id as string);
}

/** Give the first `count` of `patientIds` a login: loadpatient<N>@hqms.test with the demo password hash. */
export async function bulkPatientLogins(pool: pg.Pool, patientIds: string[], count: number, prefix = 'loadpatient'): Promise<string[]> {
  const hash = (await pool.query(`SELECT password_hash FROM users WHERE email = 'patient@hqms.test'`)).rows[0].password_hash;
  const hospital = (await pool.query(`SELECT id FROM hospitals LIMIT 1`)).rows[0].id;
  const emails: string[] = [];
  for (let i = 0; i < count; i += 1) emails.push(`${prefix}${i + 1}@hqms.test`);
  await pool.query(
    `INSERT INTO users (id, hospital_id, email, display_name, role, password_hash, patient_id)
     SELECT gen_random_uuid(), $1, e, 'Load Patient', 'patient', $2, p FROM unnest($3::text[], $4::uuid[]) AS t(e, p)`,
    [hospital, hash, emails, patientIds.slice(0, count)],
  );
  return emails;
}

// ---------------------------------------------------------------------------------------------------
// Invariants (same checks as tests/support/world.ts checkGlobalInvariants; that file needs vitest's inject)
// ---------------------------------------------------------------------------------------------------

export interface InvariantReport {
  sessionsChecked: number;
  violations: string[];
  ms: number;
}

export async function checkInvariants(pool: pg.Pool): Promise<InvariantReport> {
  const t0 = performance.now();
  const q = async (sql: string): Promise<any[]> => (await pool.query(sql)).rows;
  const violations: string[] = [];
  const counters = await q(
    `SELECT c.session_id, c.booked_capacity, c.walkin_capacity, c.booked_reserved, c.walkin_used,
            count(a.*) FILTER (WHERE a.kind = 'booked' AND a.state IN ('reserved','consumed'))::int AS booked_alloc,
            count(a.*) FILTER (WHERE a.kind = 'walkin' AND a.state IN ('reserved','consumed'))::int AS walkin_alloc
       FROM session_capacity c LEFT JOIN capacity_allocations a ON a.session_id = c.session_id
      GROUP BY c.session_id, c.booked_capacity, c.walkin_capacity, c.booked_reserved, c.walkin_used`,
  );
  for (const r of counters) {
    if (r.booked_reserved !== r.booked_alloc) violations.push(`session ${r.session_id}: booked_reserved ${r.booked_reserved} != allocations ${r.booked_alloc}`);
    if (r.walkin_used !== r.walkin_alloc) violations.push(`session ${r.session_id}: walkin_used ${r.walkin_used} != allocations ${r.walkin_alloc}`);
    if (r.booked_alloc > r.booked_capacity) violations.push(`session ${r.session_id}: booked allocations ${r.booked_alloc} > capacity ${r.booked_capacity}`);
    if (r.walkin_alloc > r.walkin_capacity) violations.push(`session ${r.session_id}: walk-in allocations ${r.walkin_alloc} > capacity ${r.walkin_capacity}`);
  }
  for (const r of await q(`SELECT session_id, scheduled_at, count(*)::int AS n FROM appointments WHERE status IN ('booked','checked_in','completed') GROUP BY session_id, scheduled_at HAVING count(*) > 1`))
    violations.push(`session ${r.session_id}: ${r.n} active appointments at ${r.scheduled_at}`);
  for (const r of await q(
    `SELECT p.session_id, count(*)::int AS n, max(c.booked_capacity) AS cap FROM appointments p JOIN session_capacity c ON c.session_id = p.session_id
      WHERE p.status IN ('booked','checked_in','completed') GROUP BY p.session_id HAVING count(*) > max(c.booked_capacity)`,
  ))
    violations.push(`session ${r.session_id}: ${r.n} active appointments > capacity ${r.cap}`);
  for (const r of await q(
    `SELECT p.id, p.status, a.state FROM appointments p JOIN capacity_allocations a ON a.id = p.allocation_id
      WHERE (p.status = 'booked' AND a.state <> 'reserved') OR (p.status IN ('cancelled','rescheduled') AND a.state <> 'released')
         OR (p.status IN ('checked_in','completed') AND a.state <> 'consumed' AND NOT EXISTS (SELECT 1 FROM visits v WHERE v.appointment_id = p.id AND v.kind = 'late_admission'))`,
  ))
    violations.push(`appointment ${r.id}: status ${r.status} but allocation ${r.state}`);
  for (const r of await q(`SELECT appointment_id, count(*)::int AS n FROM visits WHERE appointment_id IS NOT NULL GROUP BY appointment_id HAVING count(*) > 1`))
    violations.push(`appointment ${r.appointment_id}: ${r.n} visits`);
  for (const r of await q(`SELECT visit_id, count(*)::int AS n FROM queue_entries GROUP BY visit_id HAVING count(*) > 1`))
    violations.push(`visit ${r.visit_id}: ${r.n} queue entries`);
  for (const r of await q(`SELECT doctor_id, count(*)::int AS n FROM queue_entries WHERE state IN ('called','in_service') GROUP BY doctor_id HAVING count(*) > 1`))
    violations.push(`doctor ${r.doctor_id}: ${r.n} called/in-service entries`);
  for (const r of await q(`SELECT v.id FROM visits v LEFT JOIN queue_entries q ON q.visit_id = v.id WHERE q.id IS NULL`))
    violations.push(`visit ${r.id}: no queue entry`);
  return { sessionsChecked: counters.length, violations, ms: round1(performance.now() - t0) };
}

// ---------------------------------------------------------------------------------------------------
// Sampling: /proc per process, postgres backends of one database, system CPU
// ---------------------------------------------------------------------------------------------------

const CLK_TCK = 100;
function procTicks(pid: number): number | undefined {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return Number(rest[11]) + Number(rest[12]); // utime + stime (fields 14, 15)
  } catch {
    return undefined;
  }
}
function procRssMb(pid: number): number | undefined {
  try {
    const statm = readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ');
    return (Number(statm[1]) * 4096) / 1048576;
  } catch {
    return undefined;
  }
}
function systemTicks(): { busy: number; total: number } {
  const l = (readFileSync('/proc/stat', 'utf8').split('\n')[0] ?? '').split(/\s+/).slice(1).map(Number);
  const idle = (l[3] ?? 0) + (l[4] ?? 0);
  const total = l.reduce((a, b) => a + b, 0);
  return { busy: total - idle, total };
}

export interface Sample {
  tSec: number;
  apiCpuPct?: number;
  apiRssMb?: number;
  workerCpuPct?: number;
  workerRssMb?: number;
  pgCpuPct: number;
  pgRssMb: number;
  pgBackends: number;
  pgActive: number;
  pgWaiting: number;
  apiConns: number;
  apiActive: number;
  apiIdleInTx: number;
  genCpuPct: number;
  systemCpuPct: number;
  load1: number;
  otherDbTxPerSec: number;
}

const opt = (key: string, v: number | undefined): Record<string, number> => (v === undefined ? {} : { [key]: round1(v) });

export class Sampler {
  readonly samples: Sample[] = [];
  private timer: NodeJS.Timeout | undefined;
  private t0 = performance.now();
  private prev: { at: number; api?: number; worker?: number; pg: Map<number, number>; gen: number; sys: { busy: number; total: number }; otherTx: number } | undefined;
  private busy = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly dbName: string,
    private readonly pids: { api?: () => number | undefined; worker?: () => number | undefined },
    private readonly intervalMs = 5000,
  ) {}

  start(): void {
    this.t0 = performance.now();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  async stop(): Promise<Sample[]> {
    if (this.timer) clearInterval(this.timer);
    while (this.busy) await sleep(50);
    return this.samples;
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const at = performance.now();
      const apiPid = this.pids.api?.();
      const workerPid = this.pids.worker?.();
      const act = await this.pool.query(
        `SELECT pid, datname, application_name, state, wait_event_type FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()`,
      );
      const mine = act.rows.filter((r) => r.datname === this.dbName);
      const other = await this.pool.query(`SELECT coalesce(sum(xact_commit + xact_rollback), 0)::float8 AS tx FROM pg_stat_database WHERE datname IS NOT NULL AND datname <> $1`, [this.dbName]);
      const pgPids = new Map<number, number>();
      let pgRss = 0;
      for (const r of mine) {
        const t = procTicks(r.pid);
        if (t !== undefined) pgPids.set(r.pid, t);
        pgRss += procRssMb(r.pid) ?? 0;
      }
      const apiT = apiPid ? procTicks(apiPid) : undefined;
      const workerT = workerPid ? procTicks(workerPid) : undefined;
      const genT = procTicks(process.pid) ?? 0;
      const sys = systemTicks();
      const otherTx = Number(other.rows[0].tx);
      if (this.prev) {
        const dt = (at - this.prev.at) / 1000;
        const pct = (a?: number, b?: number): number | undefined => (a === undefined || b === undefined ? undefined : ((a - b) / CLK_TCK / dt) * 100);
        let pgDelta = 0;
        for (const [pid, t] of pgPids) pgDelta += t - (this.prev.pg.get(pid) ?? t);
        const sample: Sample = {
          tSec: round1((at - this.t0) / 1000),
          ...opt('apiCpuPct', pct(apiT, this.prev.api)),
          ...opt('apiRssMb', apiPid ? procRssMb(apiPid) : undefined),
          ...opt('workerCpuPct', pct(workerT, this.prev.worker)),
          ...opt('workerRssMb', workerPid ? procRssMb(workerPid) : undefined),
          pgCpuPct: round1((pgDelta / CLK_TCK / dt) * 100),
          pgRssMb: round1(pgRss),
          pgBackends: mine.length,
          pgActive: mine.filter((r) => r.state === 'active').length,
          pgWaiting: mine.filter((r) => r.wait_event_type === 'Lock').length,
          apiConns: mine.filter((r) => r.application_name === 'hqms-api').length,
          apiActive: mine.filter((r) => r.application_name === 'hqms-api' && r.state === 'active').length,
          apiIdleInTx: mine.filter((r) => r.application_name === 'hqms-api' && r.state === 'idle in transaction').length,
          genCpuPct: round1(((genT - this.prev.gen) / CLK_TCK / dt) * 100),
          systemCpuPct: round1(((sys.busy - this.prev.sys.busy) / (sys.total - this.prev.sys.total)) * 100),
          load1: round1(loadavg()[0] ?? 0),
          otherDbTxPerSec: round1((otherTx - this.prev.otherTx) / dt),
        };
        this.samples.push(sample);
      }
      this.prev = { at, ...(apiT !== undefined ? { api: apiT } : {}), ...(workerT !== undefined ? { worker: workerT } : {}), pg: pgPids, gen: genT, sys, otherTx };
    } catch {
      /* a sample is best effort */
    } finally {
      this.busy = false;
    }
  }
}

export function summariseSamples(samples: Sample[]): Record<string, unknown> {
  const col = (f: (s: Sample) => number | undefined): number[] => samples.map(f).filter((v): v is number => v !== undefined);
  const stat = (xs: number[]): { mean: number; max: number } => ({
    mean: xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : NaN,
    max: xs.length ? round1(Math.max(...xs)) : NaN,
  });
  return {
    samples: samples.length,
    apiCpuPct: stat(col((s) => s.apiCpuPct)),
    apiRssMb: stat(col((s) => s.apiRssMb)),
    workerCpuPct: stat(col((s) => s.workerCpuPct)),
    workerRssMb: stat(col((s) => s.workerRssMb)),
    postgresBackendsOfThisDbCpuPct: stat(col((s) => s.pgCpuPct)),
    postgresBackendsRssMb: stat(col((s) => s.pgRssMb)),
    postgresBackendsOfThisDb: stat(col((s) => s.pgBackends)),
    postgresActiveBackends: stat(col((s) => s.pgActive)),
    postgresBackendsWaitingOnLock: stat(col((s) => s.pgWaiting)),
    apiConnectionsOpen: stat(col((s) => s.apiConns)),
    apiConnectionsActive: stat(col((s) => s.apiActive)),
    apiConnectionsIdleInTransaction: stat(col((s) => s.apiIdleInTx)),
    loadGeneratorCpuPct: stat(col((s) => s.genCpuPct)),
    wholeMachineCpuPct: stat(col((s) => s.systemCpuPct)),
    loadAvg1: stat(col((s) => s.load1)),
    otherDatabasesTxPerSec: stat(col((s) => s.otherDbTxPerSec)),
  };
}

/** RSS growth: least-squares slope (MB per minute) over the samples, plus first/last/max. */
export function rssTrend(samples: Sample[], pick: (s: Sample) => number | undefined): { first: number; last: number; max: number; slopeMbPerMin: number; n: number } | undefined {
  const pts = samples.map((s) => [s.tSec, pick(s)] as const).filter((p): p is readonly [number, number] => p[1] !== undefined);
  if (pts.length < 3) return undefined;
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p[0], 0) / n;
  const my = pts.reduce((a, p) => a + p[1], 0) / n;
  const sxx = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
  const sxy = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0);
  return {
    first: round1(pts[0]?.[1] ?? 0),
    last: round1(pts[n - 1]?.[1] ?? 0),
    max: round1(Math.max(...pts.map((p) => p[1]))),
    slopeMbPerMin: Math.round((sxx === 0 ? 0 : (sxy / sxx) * 60) * 100) / 100,
    n,
  };
}

export function machineInfo(): Record<string, unknown> {
  const cpu = cpus();
  let pgVersion = '';
  try {
    pgVersion = execFileSync('psql', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    /* ignore */
  }
  let kernel = '';
  try {
    kernel = readFileSync('/proc/version', 'utf8').split(' ').slice(0, 3).join(' ');
  } catch {
    /* ignore */
  }
  return {
    cpuModel: cpu[0]?.model,
    vCpus: cpu.length,
    ramGb: Math.round((totalmem() / 1073741824) * 10) / 10,
    node: process.version,
    postgresClient: pgVersion,
    kernel,
    note: 'API, worker, PostgreSQL and the load generator run on this same machine; other tenants may use the same PostgreSQL server and CPUs (see otherDatabasesTxPerSec and wholeMachineCpuPct).',
  };
}
