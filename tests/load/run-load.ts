/**
 * T5 / NFR-01 load run: an open-loop (constant arrival rate) generator with a documented endpoint mix against the API
 * started from its production bundle, a dataset at the Table 3 scale where feasible, and sampling of CPU, memory,
 * database connections and invariants while it runs.
 *
 *   pnpm --filter @hqms/tests load                       # defaults: phase a = 100 req/s for LOAD_A_SEC (1800), phase b = 200 req/s for 60 s
 *   LOAD_A_SEC=300 LOAD_B_SEC=60 pnpm --filter @hqms/tests load
 *
 * Everything runs on ONE machine (API, worker, PostgreSQL, this generator). Numbers are measured there, not on the
 * hosted reference environment. The script writes docs/evidence/T5-load.raw.json; it never reports a target as achieved.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are JSON of known shapes that each step narrows */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  bulkPatientLogins,
  bulkPatients,
  buildAll,
  checkInvariants,
  createSession,
  dist,
  doctorEmail,
  doctorId,
  dropDb,
  evidenceDir,
  Http,
  istDate,
  login,
  machineInfo,
  newPool,
  recreateDb,
  round1,
  rssTrend,
  Sampler,
  sleep,
  startApi,
  startWorker,
  summariseSamples,
  type MadeSession,
} from './lib/harness.js';

const DB = process.env['LOAD_DB'] ?? 'hqms_load';
const POOL_MAX = Number(process.env['LOAD_DB_POOL_MAX'] ?? 20);
const PHASES = [
  { name: 'a', rps: Number(process.env['LOAD_A_RPS'] ?? 100), sec: Number(process.env['LOAD_A_SEC'] ?? 1800) },
  { name: 'b', rps: Number(process.env['LOAD_B_RPS'] ?? 200), sec: Number(process.env['LOAD_B_SEC'] ?? 60) },
].filter((p) => (process.env['LOAD_PHASES'] ?? 'a,b').split(',').includes(p.name) && p.sec > 0);
const WARMUP_SEC = Number(process.env['LOAD_WARMUP_SEC'] ?? 20);
const OUT = process.env['LOAD_OUT'] ?? resolve(evidenceDir, 'T5-load.raw.json');
const KEEP_DB = process.env['LOAD_KEEP_DB'] === '1';

type Cls = 'snapshot_patient' | 'snapshot_staff' | 'appointments_list' | 'sessions_list' | 'book' | 'check_in' | 'walk_in' | 'call_next' | 'start' | 'complete';
const CLASSES: Cls[] = ['snapshot_patient', 'snapshot_staff', 'appointments_list', 'sessions_list', 'book', 'check_in', 'walk_in', 'call_next', 'start', 'complete'];

/** Share of ALL requests per class (documented mix). call_next/start/complete are the three requests of one cycle. */
const MIX: Record<Cls, number> = {
  snapshot_patient: 0.48,
  snapshot_staff: 0.12,
  appointments_list: 0.15,
  sessions_list: 0.1,
  book: 0.05,
  check_in: 0.025,
  walk_in: 0.025,
  call_next: 0.05 / 3,
  start: 0.05 / 3,
  complete: 0.05 / 3,
};

const log = (m: string): void => console.log(`[load ${new Date().toISOString().slice(11, 19)}] ${m}`);

interface Stat {
  lat: number[];
  byStatus: Record<string, number>;
  byCode: Record<string, number>;
  errors: Record<string, number>;
}
const newStat = (): Stat => ({ lat: [], byStatus: {}, byCode: {}, errors: {} });

async function pmap<T, R>(items: T[], conc: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: conc }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i] as T, i);
      }
    }),
  );
  return out;
}

async function main(): Promise<void> {
  const t00 = performance.now();
  log(`phases: ${PHASES.map((p) => `${p.name}=${p.rps}/s x ${p.sec}s`).join(', ')}; db ${DB}; pool ${POOL_MAX}`);
  buildAll();
  const databaseUrl = await recreateDb(DB);
  const pool = newPool(DB, 4);

  // ---------------- supply sizing (from the mix and the planned duration; +20% and a floor) ----------------
  const totalReq = (cls: Cls): number => Math.ceil(PHASES.reduce((a, p) => a + p.rps * (p.sec + 0) * MIX[cls], 0) * 1.2 + WARMUP_SEC * 100 * MIX[cls] * 1.2 + 60);
  const needBook = totalReq('book');
  const needCheckin = totalReq('check_in');
  const needWalkin = totalReq('walk_in');
  const CHECKIN_CAP = 25;
  const WALKIN_CAP = 50;
  const futureSessionsN = Math.ceil(needBook / 10);
  const checkinSessionsN = Math.ceil(needCheckin / CHECKIN_CAP);
  const walkinSessionsN = Math.ceil(needWalkin / WALKIN_CAP);
  log(`supply: ${needBook} bookings over ${futureSessionsN} future sessions; ${needCheckin} check-ins over ${checkinSessionsN} sessions; ${needWalkin} walk-ins over ${walkinSessionsN} sessions`);

  // ---------------- patients ----------------
  const PATIENTS = 10_000;
  const READ_PATIENTS = 170;
  const patientIds = await bulkPatients(pool, PATIENTS);
  const emails = await bulkPatientLogins(pool, patientIds, READ_PATIENTS);
  const supplyPatients = patientIds.slice(200);

  const api = await startApi({ dbName: DB, env: { DB_POOL_MAX: String(POOL_MAX), SSE_POLL_MS: '500' } });
  const worker = startWorker({ dbName: DB, id: 't5-load-worker' });
  log(`api pid ${api.pid} ${api.url}; worker pid ${worker.pid}`);

  const admin = await login(api.url, 'admin@hqms.test');
  const reception = await login(api.url, 'reception@hqms.test');
  const doctors = await pmap([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5, (n) => login(api.url, doctorEmail(n)));
  const patientClients = await pmap(emails, 8, (e) => login(api.url, e));
  log(`logins ready: admin, reception, ${doctors.length} doctors, ${patientClients.length} patients`);

  // ---------------- sessions ----------------
  const minute = 60_000;
  const nowMin = Math.floor(Date.now() / minute) * minute;
  const today = istDate(new Date(nowMin));
  const mk = async (admin2: Http, spec: Parameters<typeof createSession>[1]): Promise<MadeSession> => {
    const s = await createSession(admin2, spec);
    if (!s) throw new Error(`unique clash creating session for doctor ${spec.doctor} at ${spec.startMs}`);
    return s;
  };

  // read pool: 2 running sessions per doctor (Table 7 capacity 10 + 5), 170 patients with entries
  const readSessions: MadeSession[] = [];
  for (let d = 1; d <= 10; d += 1) for (const off of [-20, -21]) readSessions.push(await mk(admin, { doctor: d, startMs: nowMin + off * minute, durationMin: 240, booked: 10, walkin: 5 }));
  const readOf = new Map<number, MadeSession>(); // patient index -> session
  const setupFailures: string[] = [];
  await pmap(Array.from({ length: READ_PATIENTS }, (_, i) => i), 6, async (i) => {
    const s = readSessions[i % readSessions.length] as MadeSession;
    const k = Math.floor(i / readSessions.length);
    const pid = patientIds[i] as string;
    if (k < 3) {
      const r = await reception.post(`/sessions/${s.id}/walk-ins`, { patientId: pid });
      if (r.status !== 201) return void setupFailures.push(`read walk-in ${r.status} ${JSON.stringify(r.body)}`);
    } else {
      const b = await reception.post('/appointments', { sessionId: s.id, patientId: pid });
      if (b.status !== 201) return void setupFailures.push(`read book ${b.status} ${JSON.stringify(b.body)}`);
      const c = await reception.post(`/appointments/${b.body.id}/check-in`, {});
      if (c.status !== 200 && c.status !== 201) return void setupFailures.push(`read check-in ${c.status} ${JSON.stringify(c.body)}`);
    }
    readOf.set(i, s);
  });
  if (setupFailures.length) throw new Error(`read-pool setup failed (${setupFailures.length}): ${setupFailures.slice(0, 3).join(' | ')}`);
  log(`read pool ready: ${readSessions.length} sessions, ${readOf.size} patient entries`);

  // supply sessions
  const futureSessions: MadeSession[] = [];
  {
    const specs = Array.from({ length: futureSessionsN }, (_, i) => ({ doctor: 1 + (i % 10), day: Math.floor(i / 10) }));
    const made = await pmap(specs, 8, async (sp) => {
      const d = new Date(Date.UTC(2041, 0, 1 + sp.day));
      const date = d.toISOString().slice(0, 10);
      return mk(admin, { doctor: sp.doctor, date, startMs: Date.parse(`${date}T09:00:00+05:30`), durationMin: 240, booked: 10, walkin: 5, label: 'morning' });
    });
    futureSessions.push(...made);
  }
  const walkinSessions: MadeSession[] = [];
  {
    const specs = Array.from({ length: walkinSessionsN }, (_, i) => ({ doctor: 1 + (i % 10), k: Math.floor(i / 10) }));
    walkinSessions.push(...(await pmap(specs, 8, (sp) => mk(admin, { doctor: sp.doctor, startMs: nowMin - (1 + sp.k) * minute, durationMin: 240, booked: 0, walkin: WALKIN_CAP }))));
  }
  const checkinSessions: MadeSession[] = [];
  {
    const specs = Array.from({ length: checkinSessionsN }, (_, i) => ({ doctor: 1 + (i % 10), k: Math.floor(i / 10) }));
    checkinSessions.push(...(await pmap(specs, 8, (sp) => mk(admin, { doctor: sp.doctor, startMs: nowMin + (120 + sp.k) * minute, durationMin: 540, booked: CHECKIN_CAP, walkin: 0 }))));
  }
  log(`sessions created: ${futureSessions.length} future, ${walkinSessions.length} walk-in churn, ${checkinSessions.length} check-in churn (today ${today})`);

  // book the check-in supply (setup, not measured)
  const checkinAppointments: string[] = [];
  {
    let cursor = 0;
    const jobs = checkinSessions.flatMap((s) => Array.from({ length: CHECKIN_CAP }, () => s));
    const fails: string[] = [];
    const ids = await pmap(jobs, 8, async (s) => {
      const pid = supplyPatients[cursor++ % supplyPatients.length] as string;
      const b = await reception.post('/appointments', { sessionId: s.id, patientId: pid });
      if (b.status !== 201) {
        fails.push(`${b.status} ${b.code ?? ''}`);
        return undefined;
      }
      return b.body.id as string;
    });
    for (const id of ids) if (id) checkinAppointments.push(id);
    if (checkinAppointments.length < needCheckin) throw new Error(`only ${checkinAppointments.length}/${needCheckin} check-in appointments booked (${[...new Set(fails)].join(',')})`);
    log(`check-in supply booked: ${checkinAppointments.length} (${fails.length} failed)`);
  }
  // shuffle so check-ins hit many sessions
  for (let i = checkinAppointments.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [checkinAppointments[i], checkinAppointments[j]] = [checkinAppointments[j] as string, checkinAppointments[i] as string];
  }

  const dataset = (
    await pool.query(
      `SELECT (SELECT count(*)::int FROM patients) AS patients, (SELECT count(*)::int FROM users) AS users, (SELECT count(*)::int FROM sessions) AS sessions,
              (SELECT count(*)::int FROM appointments) AS appointments, (SELECT count(*)::int FROM queue_entries) AS queue_entries,
              (SELECT count(*)::int FROM sessions WHERE session_date = $1::date) AS sessions_today`,
      [today],
    )
  ).rows[0];
  log(`dataset before load: ${JSON.stringify(dataset)}`);

  // ---------------- generator ----------------
  let stats = new Map<Cls, Stat>(CLASSES.map((c) => [c, newStat()]));
  const unexpectedSamples: string[] = [];
  let bookCtr = 0;
  let walkCtr = 0;
  let checkCtr = 0;
  let inflight = 0;
  let peakInflight = 0;
  let skippedCycles = 0;
  let cycleNoEntry = 0;
  let completedCycles = 0;
  const doctorBusy = new Array<boolean>(10).fill(false);
  const doctorPending: Array<Map<string, number>> = Array.from({ length: 10 }, () => new Map());
  const sessionDoctor = new Map<string, number>(walkinSessions.map((s) => [s.id, s.doctor]));
  const rnd = (n: number): number => Math.floor(Math.random() * n);

  const record = (cls: Cls, r: { status: number; ms: number; code?: string; error?: string }): void => {
    const st = stats.get(cls) as Stat;
    st.lat.push(r.ms);
    st.byStatus[r.status] = (st.byStatus[r.status] ?? 0) + 1;
    if (r.code) st.byCode[r.code] = (st.byCode[r.code] ?? 0) + 1;
    if (r.error) st.errors[r.error.slice(0, 80)] = (st.errors[r.error.slice(0, 80)] ?? 0) + 1;
    if (r.status === 0 || r.status >= 500 || (r.status >= 400 && r.status !== 409)) {
      if (unexpectedSamples.length < 30) unexpectedSamples.push(`${cls} ${r.status} ${r.code ?? ''} ${r.error ?? ''}`);
    }
  };

  const track = async <T>(fn: () => Promise<T>): Promise<T> => {
    inflight += 1;
    peakInflight = Math.max(peakInflight, inflight);
    try {
      return await fn();
    } finally {
      inflight -= 1;
    }
  };

  const doOne = async (cls: Cls): Promise<void> => {
    switch (cls) {
      case 'snapshot_patient': {
        const i = rnd(READ_PATIENTS);
        const s = readOf.get(i) as MadeSession;
        return record(cls, await (patientClients[i] as Http).get(`/sessions/${s.id}/queue`));
      }
      case 'snapshot_staff': {
        const s = readSessions[rnd(readSessions.length)] as MadeSession;
        return record(cls, await (doctors[s.doctor - 1] as Http).get(`/sessions/${s.id}/queue`));
      }
      case 'appointments_list':
        return record(cls, await (patientClients[rnd(READ_PATIENTS)] as Http).get('/appointments'));
      case 'sessions_list':
        return record(cls, await reception.get(`/sessions?date=${today}&doctorId=${doctorId(1 + rnd(10))}`));
      case 'book': {
        const n = bookCtr++;
        const s = futureSessions[Math.floor(n / 10) % futureSessions.length] as MadeSession;
        const pid = supplyPatients[n % supplyPatients.length] as string;
        return record(cls, await reception.post('/appointments', { sessionId: s.id, patientId: pid }));
      }
      case 'check_in': {
        const id = checkinAppointments[checkCtr++ % checkinAppointments.length] as string;
        return record(cls, await reception.post(`/appointments/${id}/check-in`, {}));
      }
      case 'walk_in': {
        const n = walkCtr++;
        const s = walkinSessions[Math.floor(n / WALKIN_CAP) % walkinSessions.length] as MadeSession;
        const pid = supplyPatients[(n * 7 + 3) % supplyPatients.length] as string;
        const r = await reception.post(`/sessions/${s.id}/walk-ins`, { patientId: pid });
        record(cls, r);
        if (r.status === 201) {
          const m = doctorPending[s.doctor - 1] as Map<string, number>;
          m.set(s.id, (m.get(s.id) ?? 0) + 1);
        }
        return;
      }
      default:
        return;
    }
  };

  const doCycle = async (): Promise<void> => {
    const free = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((d) => !doctorBusy[d] && [...(doctorPending[d] as Map<string, number>).values()].some((v) => v > 0));
    if (free.length === 0) {
      skippedCycles += 1;
      return;
    }
    const d = free[rnd(free.length)] as number;
    doctorBusy[d] = true;
    try {
      const pending = doctorPending[d] as Map<string, number>;
      const sid = [...pending.entries()].find(([, v]) => v > 0)?.[0] as string;
      const doc = doctors[d] as Http;
      const call = await doc.post(`/sessions/${sid}/call-next`, {});
      record('call_next', call);
      const entry = call.body?.entry;
      if (call.status !== 200 || !entry) {
        if (call.status === 200) {
          cycleNoEntry += 1;
          pending.set(sid, 0);
        }
        return;
      }
      pending.set(sid, (pending.get(sid) ?? 1) - 1);
      const st = await doc.post(`/visits/${entry.visitId}/start`, {});
      record('start', st);
      if (st.status !== 200) return;
      const done = await doc.post(`/visits/${entry.visitId}/complete`, {});
      record('complete', done);
      if (done.status === 200) completedCycles += 1;
    } finally {
      doctorBusy[d] = false;
    }
  };

  // class probabilities per tick (see header of this file): one tick issues one initial request, a cycle tick issues three
  const pc = 0.05 / 2.9;
  const X = 1 + 2 * pc;
  const probs: Array<[Cls | 'cycle', number]> = [
    ['snapshot_patient', MIX.snapshot_patient * X],
    ['snapshot_staff', MIX.snapshot_staff * X],
    ['appointments_list', MIX.appointments_list * X],
    ['sessions_list', MIX.sessions_list * X],
    ['book', MIX.book * X],
    ['check_in', MIX.check_in * X],
    ['walk_in', MIX.walk_in * X],
    ['cycle', pc],
  ];
  const pick = (): Cls | 'cycle' => {
    let u = Math.random();
    for (const [c, p] of probs) {
      u -= p;
      if (u < 0) return c;
    }
    return 'snapshot_patient';
  };

  async function runLoad(name: string, rps: number, seconds: number, measured: boolean): Promise<{ issued: number; lagMs: number[]; elapsedSec: number }> {
    const tickRate = rps / X;
    const interval = 1000 / tickRate;
    const total = Math.floor(seconds * tickRate);
    const lag: number[] = [];
    const t0 = performance.now();
    let issued = 0;
    await new Promise<void>((done) => {
      const step = (): void => {
        const now = performance.now();
        while (issued < total && t0 + issued * interval <= now) {
          lag.push(now - (t0 + issued * interval));
          const c = pick();
          void track(() => (c === 'cycle' ? doCycle() : doOne(c))).catch((e: unknown) => unexpectedSamples.push(`generator ${String(e).slice(0, 100)}`));
          issued += 1;
        }
        if (issued >= total) return done();
        setTimeout(step, Math.max(0, Math.min(5, t0 + issued * interval - performance.now())));
      };
      step();
    });
    const elapsedSec = (performance.now() - t0) / 1000;
    const drainStart = performance.now();
    while (inflight > 0 && performance.now() - drainStart < 30_000) await sleep(50);
    if (measured) log(`${name}: issued ${issued} ticks in ${round1(elapsedSec)} s, in-flight left ${inflight}`);
    return { issued, lagMs: lag, elapsedSec };
  }

  // ---------------- warm-up (excluded) ----------------
  if (WARMUP_SEC > 0) {
    log(`warm-up ${WARMUP_SEC}s at 50 req/s (excluded from the statistics)`);
    await runLoad('warmup', 50, WARMUP_SEC, false);
  }

  const results: any = {
    generatedAt: new Date().toISOString(),
    environment: {
      machine: machineInfo(),
      config: {
        api: 'apps/api/dist/main.js, NODE_ENV=production, DB_POOL_MAX=' + POOL_MAX + ', SSE_POLL_MS=500, LOGIN_RATE_LIMIT_MAX=1000000',
        worker: 'apps/worker/dist/main.js (default settings: poll 500 ms, concurrency 4, outbox dispatcher on)',
        database: 'PostgreSQL 16 on localhost, default server configuration, database ' + DB,
        provider: 'identity local, OCR fake, LLM fake, storage local-disk (no external provider is called in this run)',
      },
      dataset,
      supplySessions: { future: futureSessions.length, walkinChurn: walkinSessions.length, checkinChurn: checkinSessions.length, walkinCapacityEach: WALKIN_CAP, checkinBookedCapacityEach: CHECKIN_CAP },
    },
    mix: MIX,
    phases: [] as any[],
  };

  for (const phase of PHASES) {
    stats = new Map<Cls, Stat>(CLASSES.map((c) => [c, newStat()]));
    unexpectedSamples.length = 0;
    skippedCycles = 0;
    cycleNoEntry = 0;
    completedCycles = 0;
    const before = (await pool.query(`SELECT (SELECT count(*)::int FROM appointments) AS appointments, (SELECT count(*)::int FROM queue_entries) AS entries, (SELECT count(*)::int FROM queue_entries WHERE state = 'completed') AS completed, (SELECT count(*)::int FROM idempotency_records) AS idem, (SELECT count(*)::int FROM audit_events) AS audit, (SELECT count(*)::int FROM jobs) AS jobs, (SELECT count(*)::int FROM outbox_events) AS outbox`)).rows[0];
    const sampler = new Sampler(pool, DB, { api: () => (api.alive() ? api.pid : undefined), worker: () => (worker.alive() ? worker.pid : undefined) }, 5000);
    sampler.start();
    const invariantChecks: Array<{ tSec: number; violations: number; ms: number }> = [];
    const monStart = performance.now();
    const monitor = setInterval(() => {
      void checkInvariants(pool).then((r) => {
        invariantChecks.push({ tSec: round1((performance.now() - monStart) / 1000), violations: r.violations.length, ms: r.ms });
        if (r.violations.length) log(`INVARIANT VIOLATIONS: ${r.violations.slice(0, 3).join(' | ')}`);
      });
    }, 60_000);
    log(`phase ${phase.name}: ${phase.rps} req/s for ${phase.sec} s`);
    const startedAt = new Date().toISOString();
    const run = await runLoad(phase.name, phase.rps, phase.sec, true);
    clearInterval(monitor);
    const samples = await sampler.stop();
    const finalInv = await checkInvariants(pool);
    const after = (await pool.query(`SELECT (SELECT count(*)::int FROM appointments) AS appointments, (SELECT count(*)::int FROM queue_entries) AS entries, (SELECT count(*)::int FROM queue_entries WHERE state = 'completed') AS completed, (SELECT count(*)::int FROM idempotency_records) AS idem, (SELECT count(*)::int FROM audit_events) AS audit, (SELECT count(*)::int FROM jobs) AS jobs, (SELECT count(*)::int FROM outbox_events) AS outbox`)).rows[0];

    // per class
    const perClass: any = {};
    const allLat: number[] = [];
    let n2xx = 0;
    let n409 = 0;
    let nOther4xx = 0;
    let n5xx = 0;
    let nNet = 0;
    const codes409: Record<string, number> = {};
    for (const c of CLASSES) {
      const s = stats.get(c) as Stat;
      allLat.push(...s.lat);
      for (const [st, n] of Object.entries(s.byStatus)) {
        const k = Number(st);
        if (k >= 200 && k < 300) n2xx += n;
        else if (k === 409) n409 += n;
        else if (k >= 400 && k < 500) nOther4xx += n;
        else if (k >= 500) n5xx += n;
        else nNet += n;
      }
      for (const [code, n] of Object.entries(s.byCode)) if (s.byStatus['409']) codes409[`${c}:${code}`] = n;
      perClass[c] = { ...dist(s.lat), byStatus: s.byStatus, byCode: s.byCode, ...(Object.keys(s.errors).length ? { networkErrors: s.errors } : {}) };
    }
    const issuedRequests = allLat.length;
    // classes by the "ordinary API" reading: everything except nothing is excluded here; the NFR says "ordinary API p95"
    const writes = [...(stats.get('book')?.lat ?? []), ...(stats.get('check_in')?.lat ?? []), ...(stats.get('walk_in')?.lat ?? []), ...(stats.get('call_next')?.lat ?? []), ...(stats.get('start')?.lat ?? []), ...(stats.get('complete')?.lat ?? [])];
    const reads = [...(stats.get('snapshot_patient')?.lat ?? []), ...(stats.get('snapshot_staff')?.lat ?? []), ...(stats.get('appointments_list')?.lat ?? []), ...(stats.get('sessions_list')?.lat ?? [])];
    const successes = {
      book201: stats.get('book')?.byStatus['201'] ?? 0,
      checkIn2xx: (stats.get('check_in')?.byStatus['200'] ?? 0) + (stats.get('check_in')?.byStatus['201'] ?? 0),
      walkIn201: stats.get('walk_in')?.byStatus['201'] ?? 0,
    };
    results.phases.push({
      name: phase.name,
      targetRps: phase.rps,
      plannedSeconds: phase.sec,
      startedAt,
      actualIssueSeconds: round1(run.elapsedSec),
      requestsCompleted: issuedRequests,
      achievedRps: round1(issuedRequests / run.elapsedSec),
      peakInFlight: peakInflight,
      schedulerLagMs: dist(run.lagMs),
      latencyMs: { overall: dist(allLat), reads: dist(reads), writes: dist(writes), perClass },
      status: { total: issuedRequests, ok2xx: n2xx, expected409: n409, expected409ByCode: codes409, other4xxUnexpected: nOther4xx, serverError5xx: n5xx, networkErrorOrTimeout: nNet, unexpectedRatePct: round1(((nOther4xx + n5xx + nNet) / Math.max(1, issuedRequests)) * 1000) / 10, unexpectedSamples: [...unexpectedSamples] },
      cycles: { completed: completedCycles, skippedBecauseNoDoctorWithQueuedEntries: skippedCycles, callNextReturnedNoEntry: cycleNoEntry },
      durability: {
        before,
        after,
        deltaAppointments: after.appointments - before.appointments,
        deltaQueueEntries: after.entries - before.entries,
        deltaCompletedEntries: after.completed - before.completed,
        deltaAuditEvents: after.audit - before.audit,
        deltaOutboxEvents: after.outbox - before.outbox,
        deltaJobs: after.jobs - before.jobs,
        successfulBook201: successes.book201,
        successfulArrivals: successes.checkIn2xx + successes.walkIn201,
        completedCyclesObserved: completedCycles,
        note: 'deltaAppointments must equal successfulBook201; deltaQueueEntries must equal successfulArrivals; deltaCompletedEntries must equal completed cycles (a response is only sent after the commit).',
      },
      invariants: { monitorChecks: invariantChecks, final: { sessionsChecked: finalInv.sessionsChecked, violations: finalInv.violations.length, sample: finalInv.violations.slice(0, 5) } },
      resources: summariseSamples(samples),
      apiRssTrend: rssTrend(samples, (s) => s.apiRssMb) ?? null,
      workerRssTrend: rssTrend(samples, (s) => s.workerRssMb) ?? null,
      samples,
    });
    log(`phase ${phase.name} done: ${issuedRequests} requests, p50/p95/p99 ${dist(allLat).p50}/${dist(allLat).p95}/${dist(allLat).p99} ms, 2xx ${n2xx}, 409 ${n409}, other4xx ${nOther4xx}, 5xx ${n5xx}, net ${nNet}, violations ${finalInv.violations.length}`);
    writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
    await sleep(15_000); // settle between phases
  }

  // idle RSS after the run (does memory come back?)
  const idle = await (async () => {
    await sleep(20_000);
    const s = new Sampler(pool, DB, { api: () => api.pid, worker: () => worker.pid }, 1000);
    s.start();
    await sleep(3500);
    return (await s.stop()).slice(-1)[0];
  })();
  results.idleAfterRun = { apiRssMb: idle?.apiRssMb, workerRssMb: idle?.workerRssMb, note: '~25 s after the last phase, no traffic' };
  results.apiLogErrorLines = api.logs.filter((l) => /ERROR|Unhandled|deadlock/i.test(l)).slice(0, 20);
  results.apiLogErrorCount = api.logs.filter((l) => /ERROR|Unhandled|deadlock/i.test(l)).length;
  results.workerLogErrorCount = worker.logs.filter((l) => /"level":"error"|ERROR|Unhandled/i.test(l)).length;
  results.totalWallSeconds = round1((performance.now() - t00) / 1000);
  writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
  log(`raw results written to ${OUT}`);

  await worker.stop();
  await api.stop();
  await pool.end();
  if (!KEEP_DB) await dropDb(DB);
  void databaseUrl;
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
