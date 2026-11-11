/**
 * T5 / NFR-07 failure injection against the real API and worker processes (built bundles) and real PostgreSQL.
 *
 *   pnpm --filter @hqms/tests failure                 # all scenarios
 *   pnpm --filter @hqms/tests failure api-kill        # one of: api-kill, worker-kill, ocr-fail, db-conn
 *
 * Scenarios (each on its own scratch database hqms_fail_*; no other database and never the PostgreSQL server itself is touched):
 *  api-kill     kill -9 the API in the middle of a burst of bookings, restart, replay every request with its Idempotency-Key.
 *  worker-kill  kill -9 the worker while it holds job leases, restart, jobs complete once (call_timeout and reservation_release effects).
 *  ocr-fail     OCR provider fixture "fail" while a booking load runs: booking latency/errors with and without failing OCR.
 *  db-conn      pg_terminate_backend on the API's connections, and the database refusing connections for 8 s (ALLOW_CONNECTIONS false).
 *
 * Results (every number measured here, on this machine) are merged into docs/evidence/T5-failure.raw.json.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are JSON of known shapes that each step narrows */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import {
  ADMIN_URL,
  bulkPatients,
  buildAll,
  checkInvariants,
  createSession,
  dist,
  doctorEmail,
  dropDb,
  evidenceDir,
  Http,
  login,
  machineInfo,
  newPool,
  recreateDb,
  round1,
  sleep,
  startApi,
  startWorker,
  type MadeSession,
  type Proc,
} from '../load/lib/harness.js';

const OUT = resolve(evidenceDir, 'T5-failure.raw.json');
const log = (m: string): void => console.log(`[failure ${new Date().toISOString().slice(11, 19)}] ${m}`);

interface Check {
  check: string;
  pass: boolean;
  detail?: unknown;
}
const checks = (): { list: Check[]; ok(name: string, pass: boolean, detail?: unknown): void } => {
  const list: Check[] = [];
  return {
    list,
    ok(name, pass, detail) {
      list.push({ check: name, pass, ...(detail === undefined ? {} : { detail }) });
      log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
    },
  };
};

function save(key: string, data: unknown): void {
  let cur: Record<string, unknown> = {};
  if (existsSync(OUT)) {
    try {
      cur = JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, unknown>;
    } catch {
      cur = {};
    }
  }
  cur[key] = data;
  cur['machine'] = machineInfo();
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(cur, null, 2)}\n`);
}

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

const futureStart = (day: number): { date: string; startMs: number } => {
  const date = new Date(Date.UTC(2042, 0, 1 + day)).toISOString().slice(0, 10);
  return { date, startMs: Date.parse(`${date}T09:00:00+05:30`) };
};

async function futureSession(admin: Http, doctor: number, day: number, booked = 10): Promise<MadeSession> {
  const { date, startMs } = futureStart(day);
  const s = await createSession(admin, { doctor, date, startMs, durationMin: 240, booked, walkin: 5, label: 'morning' });
  if (!s) throw new Error('session clash');
  return s;
}

const IDLE_STATE = `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND state = 'idle in transaction'`;

// =====================================================================================================
// 1. kill -9 the API in the middle of a booking burst
// =====================================================================================================

async function apiKill(): Promise<void> {
  const DB = 'hqms_fail_api';
  const c = checks();
  await recreateDb(DB);
  const pool = newPool(DB, 4);
  let api = await startApi({ dbName: DB });
  const admin = await login(api.url, 'admin@hqms.test');
  const reception = await login(api.url, 'reception@hqms.test');
  const ROUNDS = 5;
  const SESSIONS_PER_ROUND = 3;
  const REQUESTS_PER_SESSION = 30; // capacity 10 each: far more requests than places
  const CONC = 30;
  const rounds: any[] = [];
  let dayCursor = 0;

  for (let round = 1; round <= ROUNDS; round += 1) {
    const sessions: MadeSession[] = [];
    for (let k = 0; k < SESSIONS_PER_ROUND; k += 1) sessions.push(await futureSession(admin, 1 + k, dayCursor++));
    const patients = await bulkPatients(pool, SESSIONS_PER_ROUND * REQUESTS_PER_SESSION, `FK${round}`);
    const reqs = patients.map((patientId, i) => ({ i, patientId, sessionId: (sessions[i % SESSIONS_PER_ROUND] as MadeSession).id, key: `t5-kill-r${round}-${i}` }));
    const sessionIds = sessions.map((s) => s.id);

    const outcome = new Map<number, { status: number; id?: string; code?: string }>();
    let started = 0;
    let answered = 0;
    let killedAt = -1;
    let inflightAtKill = 0;
    let killPromise: Promise<void> | undefined;
    const http = new Http(api.url, reception.cookie);
    const t0 = performance.now();
    await pmap(reqs, CONC, async (r) => {
      started += 1;
      const res = await http.post('/appointments', { sessionId: r.sessionId, patientId: r.patientId }, r.key);
      outcome.set(r.i, { status: res.status, ...(res.body?.id ? { id: res.body.id } : {}), ...(res.code ? { code: res.code } : {}) });
      answered += res.status === 0 ? 0 : 1;
      if (killedAt < 0 && answered >= 18 + round) {
        killedAt = performance.now() - t0;
        inflightAtKill = started - outcome.size;
        killPromise = api.kill9();
      }
    });
    await killPromise;
    const exitedAt = performance.now();

    // State right after the crash, before any restart: nothing half-written.
    const idleTx = (await pool.query(IDLE_STATE, [DB])).rows[0].n;
    const invBefore = await checkInvariants(pool);
    const committedKeys = new Set<string>((await pool.query(`SELECT idem_key FROM idempotency_records WHERE idem_key LIKE $1`, [`t5-kill-r${round}-%`])).rows.map((r) => r.idem_key as string));
    const apptBefore = (await pool.query(`SELECT count(*)::int AS n FROM appointments WHERE session_id = ANY($1::uuid[])`, [sessionIds])).rows[0].n as number;
    const unanswered = reqs.filter((r) => outcome.get(r.i)?.status === 0);
    const committedButUnanswered = unanswered.filter((r) => committedKeys.has(r.key));
    const got201 = reqs.filter((r) => outcome.get(r.i)?.status === 201);
    const lost = [];
    for (const r of got201) {
      const row = await pool.query(`SELECT 1 FROM appointments WHERE id = $1`, [outcome.get(r.i)?.id]);
      if (row.rowCount !== 1) lost.push(r.key);
    }

    // Restart on a fresh port; the login cookie of the earlier process must still be valid (sessions live in Postgres).
    const restartT0 = performance.now();
    api = await startApi({ dbName: DB });
    const restartMs = performance.now() - restartT0;
    const http2 = new Http(api.url, reception.cookie);

    // Replay EVERY request with the same Idempotency-Key and the same body.
    const replay = await pmap(reqs, 10, async (r) => ({ r, res: await http2.post('/appointments', { sessionId: r.sessionId, patientId: r.patientId }, r.key) }));
    const apptAfter = (await pool.query(`SELECT count(*)::int AS n FROM appointments WHERE session_id = ANY($1::uuid[])`, [sessionIds])).rows[0].n as number;
    const byStatus: Record<string, number> = {};
    for (const { res } of replay) byStatus[res.status] = (byStatus[res.status] ?? 0) + 1;
    // Committed keys must replay their stored outcome: 201 with the SAME appointment id that is in the database.
    const dbIdByKey = new Map<string, string>();
    for (const row of (await pool.query(`SELECT i.idem_key, (i.response_body->>'id') AS id FROM idempotency_records i WHERE i.idem_key LIKE $1`, [`t5-kill-r${round}-%`])).rows) dbIdByKey.set(row.idem_key, row.id);
    const replayMismatch: string[] = [];
    for (const { r, res } of replay) {
      if (committedKeys.has(r.key) && !(res.status === 201 && res.body?.id === dbIdByKey.get(r.key))) replayMismatch.push(`${r.key}:${res.status}`);
      const first = outcome.get(r.i);
      if (first?.status === 201 && !(res.status === 201 && res.body?.id === first.id)) replayMismatch.push(`${r.key}:answered-201-then-${res.status}`);
    }
    const perSession = (await pool.query(`SELECT session_id, count(*)::int AS n, count(DISTINCT patient_id)::int AS patients FROM appointments WHERE session_id = ANY($1::uuid[]) AND status = 'booked' GROUP BY 1`, [sessionIds])).rows;
    const inv = await checkInvariants(pool);
    const audits = (await pool.query(`SELECT (SELECT count(*)::int FROM appointments WHERE session_id = ANY($1::uuid[])) AS appts,
        (SELECT count(*)::int FROM audit_events e JOIN appointments a ON a.id = e.entity_id WHERE e.operation = 'appointment.book' AND a.session_id = ANY($1::uuid[])) AS audits,
        (SELECT count(*)::int FROM outbox_events o JOIN appointments a ON a.id = o.entity_id WHERE o.event_type = 'AppointmentBooked' AND a.session_id = ANY($1::uuid[])) AS outbox,
        (SELECT count(*)::int FROM jobs j JOIN appointments a ON (j.payload->>'appointmentId')::uuid = a.id WHERE j.job_type = 'reservation_release' AND a.session_id = ANY($1::uuid[])) AS jobs`, [sessionIds])).rows[0];

    rounds.push({
      round,
      requests: reqs.length,
      answeredBeforeKill: reqs.length - unanswered.length - (reqs.length - outcome.size),
      killedAfterMs: round1(killedAt),
      requestsInFlightWhenKilled: inflightAtKill,
      noResponse: unanswered.length,
      committedButNeverAnswered: committedButUnanswered.length,
      answered201BeforeKill: got201.length,
      lostCommittedBookings: lost.length,
      idleInTransactionAfterCrash: idleTx,
      invariantViolationsRightAfterCrash: invBefore.violations.length,
      appointmentsBeforeReplay: apptBefore,
      appointmentsAfterReplay: apptAfter,
      restartToHealthyMs: round1(restartMs),
      replayStatus: byStatus,
      replayMismatches: replayMismatch,
      finalBookedPerSession: perSession.map((r) => r.n),
      distinctPatientsPerSession: perSession.map((r) => r.patients),
      invariantViolationsAfterReplay: inv.violations.length,
      rowsPerAppointment: audits,
    });
    log(`round ${round}: in flight at kill ${inflightAtKill}, no response ${unanswered.length}, committed-but-unanswered ${committedButUnanswered.length}, replay ${JSON.stringify(byStatus)}, per session ${perSession.map((r) => r.n)}`);
    c.ok(`round ${round}: no committed booking lost`, lost.length === 0, { answered201: got201.length });
    c.ok(`round ${round}: no half-written state right after the crash`, invBefore.violations.length === 0 && idleTx === 0, { violations: invBefore.violations.slice(0, 3), idleInTransaction: idleTx });
    c.ok(`round ${round}: replay returns the stored outcome for every committed key`, replayMismatch.length === 0, replayMismatch.slice(0, 5));
    c.ok(`round ${round}: every session ends with exactly its capacity (10) booked, distinct patients`, perSession.length === SESSIONS_PER_ROUND && perSession.every((r) => r.n === 10 && r.patients === 10), perSession);
    c.ok(`round ${round}: capacity/allocation invariants hold after replay`, inv.violations.length === 0, inv.violations.slice(0, 3));
    c.ok(`round ${round}: one audit row, one AppointmentBooked event and one timer job per appointment`, audits.appts === audits.audits && audits.appts === audits.outbox && audits.appts === audits.jobs, audits);
    c.ok(`round ${round}: no 5xx during replay`, !Object.keys(byStatus).some((s) => Number(s) >= 500 || s === '0'), byStatus);
  }
  await api.stop();
  await pool.end();
  await dropDb(DB);
  const totals = {
    inFlightWhenKilled: rounds.reduce((a, r) => a + r.requestsInFlightWhenKilled, 0),
    committedButNeverAnswered: rounds.reduce((a, r) => a + r.committedButNeverAnswered, 0),
    noResponse: rounds.reduce((a, r) => a + r.noResponse, 0),
  };
  save('apiKill', { description: 'kill -9 of the API during a burst of 90 bookings (30 in flight) per round, 5 rounds, then restart and replay of every request with its Idempotency-Key', totals, rounds, checks: c.list, allPass: c.list.every((x) => x.pass) });
}

// =====================================================================================================
// 2. kill -9 the worker while it holds leases
// =====================================================================================================

async function workerKill(): Promise<void> {
  const DB = 'hqms_fail_worker';
  const c = checks();
  await recreateDb(DB);
  const pool = newPool(DB, 4);
  await pool.query(`UPDATE queue_policies SET called_timeout_sec = 3`); // test shortcut: 3 s call timeout instead of 120 s (declared)
  const api = await startApi({ dbName: DB });
  const admin = await login(api.url, 'admin@hqms.test');
  const reception = await login(api.url, 'reception@hqms.test');
  const doctors = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => login(api.url, doctorEmail(n))));

  // 200 booked appointments (two sessions of 100) -> 200 reservation_release jobs
  const s1 = await futureSession(admin, 1, 0, 100);
  const s2 = await futureSession(admin, 2, 0, 100);
  const patients = await bulkPatients(pool, 200, 'WK');
  await pmap(patients, 10, async (p, i) => {
    const r = await reception.post('/appointments', { sessionId: (i < 100 ? s1 : s2).id, patientId: p });
    if (r.status !== 201) throw new Error(`booking failed ${r.status} ${JSON.stringify(r.body)}`);
  });
  // 10 called entries (one per doctor) -> 10 call_timeout jobs
  const nowMs = Math.floor(Date.now() / 60_000) * 60_000;
  const callSessions: MadeSession[] = [];
  for (let d = 1; d <= 10; d += 1) {
    const s = await createSession(admin, { doctor: d, startMs: nowMs - (30 + d) * 60_000, durationMin: 240, booked: 5, walkin: 5 });
    if (!s) throw new Error('clash');
    callSessions.push(s);
    const pid = (await bulkPatients(pool, 1, `WKC${d}`))[0] as string;
    const w = await reception.post(`/sessions/${s.id}/walk-ins`, { patientId: pid });
    if (w.status !== 201) throw new Error(`walk-in failed ${w.status}`);
    const call = await (doctors[d - 1] as Http).post(`/sessions/${s.id}/call-next`, {});
    if (call.status !== 200 || !call.body.entry) throw new Error(`call-next failed ${call.status} ${JSON.stringify(call.body)}`);
  }
  // Test shortcut (declared): the 200 appointments' slots are in 2042, so move them into the past by SQL, distinct instants,
  // and make every job due at the same moment so the worker has a lot to do while it holds leases.
  await pool.query(`UPDATE appointments SET scheduled_at = now() - interval '3 hours' - (row_number_ * interval '1 minute') FROM (SELECT id, row_number() OVER (ORDER BY id) AS row_number_ FROM appointments) x WHERE appointments.id = x.id`);
  await pool.query(`UPDATE jobs SET run_at = now() WHERE state = 'pending' AND job_type IN ('reservation_release','call_timeout')`);
  await sleep(3500); // the 3 s call timeout has elapsed
  const jobsBefore = (await pool.query(`SELECT job_type, state, count(*)::int AS n FROM jobs GROUP BY 1, 2 ORDER BY 1, 2`)).rows;
  const dueBefore = (await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE job_type IN ('reservation_release','call_timeout') AND state = 'pending'`)).rows[0].n as number;

  // Worker 1: slow poll off, short lease so the lease of the killed worker expires quickly (declared: lease 3 s instead of 30 s).
  const wenv = { WORKER_LEASE_SEC: '3', WORKER_POLL_MS: '50', WORKER_CONCURRENCY: '4', WORKER_OUTBOX_BATCH: '50' };
  let worker: Proc = startWorker({ dbName: DB, id: 't5-worker-1', env: wenv });
  const t0 = performance.now();
  let runningAtKill: any[] = [];
  for (;;) {
    const r = await pool.query(`SELECT id, job_type, attempts, lease_owner, lease_expires_at FROM jobs WHERE state = 'running'`);
    if (r.rowCount && r.rowCount >= 1) {
      // let it process for a moment so the kill lands in the middle of the backlog, not before the first claim
      await sleep(250);
      runningAtKill = (await pool.query(`SELECT id, job_type, attempts, lease_owner FROM jobs WHERE state = 'running'`)).rows;
      await worker.kill9();
      break;
    }
    if (performance.now() - t0 > 30_000) throw new Error('worker never claimed a job');
    await sleep(5);
  }
  const killedAfterMs = round1(performance.now() - t0);
  const afterKill = (await pool.query(`SELECT state, count(*)::int AS n FROM jobs WHERE job_type IN ('reservation_release','call_timeout') GROUP BY 1 ORDER BY 1`)).rows;
  const missedAtKill = (await pool.query(`SELECT count(*)::int AS n FROM appointments WHERE status = 'missed'`)).rows[0].n as number;
  c.ok('the worker was killed while holding leases and with work left', runningAtKill.length > 0 && missedAtKill < 200, { runningAtKill: runningAtKill.length, appointmentsAlreadyMissed: missedAtKill, jobStatesAfterKill: afterKill });

  await sleep(1000);
  const stalled = (await pool.query(`SELECT count(*)::int AS n FROM appointments WHERE status = 'missed'`)).rows[0].n as number;
  c.ok('nothing advances while the worker is down', stalled === missedAtKill, { before: missedAtKill, after: stalled });

  const restartT0 = performance.now();
  worker = startWorker({ dbName: DB, id: 't5-worker-2', env: wenv });
  for (;;) {
    const open = (await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE job_type IN ('reservation_release','call_timeout') AND state IN ('pending','running','failed')`)).rows[0].n as number;
    if (open === 0) break;
    if (performance.now() - restartT0 > 90_000) break;
    await sleep(200);
  }
  const drainMs = round1(performance.now() - restartT0);
  const jobStates = (await pool.query(`SELECT job_type, state, count(*)::int AS n, max(attempts)::int AS max_attempts, count(*) FILTER (WHERE attempts > 1)::int AS retried FROM jobs WHERE job_type IN ('reservation_release','call_timeout') GROUP BY 1, 2 ORDER BY 1, 2`)).rows;
  const effects = (await pool.query(`SELECT
      (SELECT count(*)::int FROM appointments WHERE status = 'missed') AS missed,
      (SELECT count(*)::int FROM appointments WHERE status = 'booked') AS still_booked,
      (SELECT count(*)::int FROM appointments WHERE version <> 2) AS appointments_not_version_2,
      (SELECT count(*)::int FROM audit_events WHERE operation = 'appointment.reservation_release') AS release_audits,
      (SELECT count(DISTINCT entity_id)::int FROM audit_events WHERE operation = 'appointment.reservation_release') AS release_audits_distinct,
      (SELECT count(*)::int FROM outbox_events WHERE event_type = 'ReservationReleased') AS release_events,
      (SELECT count(*)::int FROM queue_entries WHERE state = 'skipped') AS skipped_entries,
      (SELECT count(*)::int FROM audit_events WHERE operation = 'queue.call_timeout') AS timeout_audits,
      (SELECT count(DISTINCT entity_id)::int FROM audit_events WHERE operation = 'queue.call_timeout') AS timeout_audits_distinct,
      (SELECT count(*)::int FROM outbox_events WHERE event_type = 'QueuePatientSkipped') AS timeout_events,
      (SELECT count(*)::int FROM queue_entries WHERE version <> 3) AS entries_not_version_3,
      (SELECT booked_reserved FROM session_capacity WHERE session_id = $1) AS booked_reserved_s1,
      (SELECT booked_reserved FROM session_capacity WHERE session_id = $2) AS booked_reserved_s2`, [s1.id, s2.id])).rows[0];
  const inv = await checkInvariants(pool);
  const dead = (await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE state = 'dead'`)).rows[0].n as number;
  c.ok('all 210 timer jobs reach a terminal state after the restart', jobStates.every((r) => r.state === 'succeeded' || r.state === 'cancelled') && dead === 0, { drainMs, jobStates, dead });
  c.ok('reservation_release effect applied exactly once for each of the 200 appointments (1 status change, 1 audit row, 1 event)', effects.missed === 200 && effects.still_booked === 0 && effects.appointments_not_version_2 === 0 && effects.release_audits === 200 && effects.release_audits_distinct === 200 && effects.release_events === 200, effects);
  c.ok('call_timeout effect applied exactly once for each of the 10 called entries', effects.skipped_entries === 10 && effects.timeout_audits === 10 && effects.timeout_audits_distinct === 10 && effects.timeout_events === 10 && effects.entries_not_version_3 === 0, effects);
  c.ok('released capacity is returned exactly once (counters 0)', effects.booked_reserved_s1 === 0 && effects.booked_reserved_s2 === 0, { s1: effects.booked_reserved_s1, s2: effects.booked_reserved_s2 });
  c.ok('capacity/allocation invariants hold', inv.violations.length === 0, inv.violations.slice(0, 3));
  await worker.stop();
  await api.stop();
  await pool.end();
  await dropDb(DB);
  save('workerKill', {
    description: 'kill -9 of the worker while jobs were running (lease held), restart, drain',
    declaredShortcuts: ['called_timeout_sec set to 3 s in the scratch database', 'appointment slots moved into the past by SQL so the release timers are due', 'WORKER_LEASE_SEC=3, WORKER_POLL_MS=50'],
    jobsBefore, dueJobsBefore: dueBefore, killedAfterMsSinceWorkerStart: killedAfterMs, runningAtKill, jobStatesAfterKill: afterKill, appointmentsMissedAtKill: missedAtKill, drainAfterRestartMs: drainMs, jobStatesFinal: jobStates, effects, checks: c.list, allPass: c.list.every((x) => x.pass),
  });
}

// =====================================================================================================
// 3. OCR provider failing while bookings run
// =====================================================================================================

async function upload(base: string, cookie: string, patientId: string, nonce: string): Promise<{ status: number; ms: number; id?: string }> {
  const bytes = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n% ${nonce}\nHQMS-FIXTURE:fail\n%%EOF\n`, 'latin1');
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), `scan-${nonce}.pdf`);
  form.append('patientId', patientId);
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}/documents`, { method: 'POST', headers: { Cookie: cookie }, body: form, signal: AbortSignal.timeout(15_000) });
    const body: any = await res.json().catch(() => ({}));
    return { status: res.status, ms: performance.now() - t0, id: body?.id };
  } catch {
    return { status: 0, ms: performance.now() - t0 };
  }
}

async function ocrFail(): Promise<void> {
  const DB = 'hqms_fail_ocr';
  const c = checks();
  await recreateDb(DB);
  const pool = newPool(DB, 4);
  const storageDir = mkdtempSync(resolve(tmpdir(), 'hqms-t5-ocr-'));
  const env = { OCR_PROVIDER: 'fake', OBJECT_STORAGE: 'local-disk', STORAGE_DIR: storageDir };
  const api = await startApi({ dbName: DB, env });
  const worker = startWorker({ dbName: DB, id: 't5-ocr-worker', env: { ...env, WORKER_BACKOFF_CAP_SEC: '8' } });
  const admin = await login(api.url, 'admin@hqms.test');
  const reception = await login(api.url, 'reception@hqms.test');

  const RPS = 30;
  const SECONDS = 40;
  const total = RPS * SECONDS;
  const phases = ['baseline-1', 'ocr-failing', 'baseline-2'];
  const sessionsNeeded = Math.ceil((total * phases.length * 1.05) / 10);
  const sessions: MadeSession[] = [];
  await pmap(Array.from({ length: sessionsNeeded }, (_, i) => i), 6, async (i) => {
    sessions[i] = await futureSession(admin, 1 + (i % 10), Math.floor(i / 10));
  });
  const patients = await bulkPatients(pool, 3000, 'OC');
  const uploaders = patients.slice(0, 10); // linked to appointments from the first baseline phase
  let ctr = 0;
  const result: any = {};

  for (const phase of phases) {
    const lat: number[] = [];
    const status: Record<string, number> = {};
    const codes: Record<string, number> = {};
    const uploadStatus: Record<string, number> = {};
    const uploadLat: number[] = [];
    const uploadedIds: string[] = [];
    let inflight = 0;
    const t0 = performance.now();
    const interval = 1000 / RPS;
    let issued = 0;
    let uploadTimer: NodeJS.Timeout | undefined;
    if (phase === 'ocr-failing') {
      let u = 0;
      uploadTimer = setInterval(() => {
        inflight += 1;
        void upload(api.url, reception.cookie as string, uploaders[u % uploaders.length] as string, `${phase}-${u++}`).then((r) => {
          uploadStatus[r.status] = (uploadStatus[r.status] ?? 0) + 1;
          uploadLat.push(r.ms);
          if (r.id) uploadedIds.push(r.id);
          inflight -= 1;
        });
      }, 500); // 2 uploads/s for 40 s = 80 documents (Table 4 plans 5 per minute: this is a stress level)
    }
    await new Promise<void>((done) => {
      const step = (): void => {
        const now = performance.now();
        while (issued < total && t0 + issued * interval <= now) {
          const n = ctr++;
          issued += 1;
          inflight += 1;
          void reception
            .post('/appointments', { sessionId: (sessions[Math.floor(n / 10)] as MadeSession).id, patientId: patients[n % 2990] as string })
            .then((r) => {
              lat.push(r.ms);
              status[r.status] = (status[r.status] ?? 0) + 1;
              if (r.code) codes[r.code] = (codes[r.code] ?? 0) + 1;
              inflight -= 1;
            });
        }
        if (issued >= total) return done();
        setTimeout(step, 2);
      };
      step();
    });
    if (uploadTimer) clearInterval(uploadTimer);
    while (inflight > 0) await sleep(20);
    result[phase] = { bookingsIssued: total, latencyMs: dist(lat), status, codes, ...(phase === 'ocr-failing' ? { uploads: { count: uploadedIds.length, status: uploadStatus, latencyMs: dist(uploadLat) } } : {}) };
    log(`${phase}: ${JSON.stringify(result[phase].latencyMs)} status ${JSON.stringify(status)}`);
    await sleep(2000);
  }

  // OCR outcome: bounded retries, visible status, no wedge
  const waitStart = performance.now();
  let docs: any[] = [];
  for (;;) {
    docs = (await pool.query(`SELECT status, count(*)::int AS n, max(ocr_attempts)::int AS max_attempts FROM documents GROUP BY 1 ORDER BY 1`)).rows;
    const pendingDocs = docs.filter((d) => ['uploaded', 'accepted', 'processing'].includes(d.status)).reduce((a, d) => a + d.n, 0);
    if (pendingDocs === 0 || performance.now() - waitStart > 120_000) break;
    await sleep(1000);
  }
  const jobStates = (await pool.query(`SELECT state, count(*)::int AS n, max(attempts)::int AS max_attempts FROM jobs WHERE job_type = 'ocr_document' GROUP BY 1 ORDER BY 1`)).rows;
  const failedEvents = (await pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'DocumentOCRFailed'`)).rows[0].n as number;
  const inv = await checkInvariants(pool);
  const all201 = phases.every((p) => (result[p].status['201'] ?? 0) === total);
  const ratio = result['ocr-failing'].latencyMs.p95 / Math.max(0.1, (result['baseline-1'].latencyMs.p95 + result['baseline-2'].latencyMs.p95) / 2);
  c.ok('every booking succeeded (201) in all three phases', all201, phases.map((p) => result[p].status));
  c.ok('zero 5xx and zero network errors in all phases', phases.every((p) => Object.keys(result[p].status).every((s) => s === '201')), phases.map((p) => result[p].status));
  c.ok('documents with the failing fixture end in ocr_failed (visible, not lost) after bounded retries', docs.length > 0 && docs.every((d) => d.status === 'ocr_failed') && docs.every((d) => d.max_attempts <= 5), { docs, jobStates, ocrFailedEvents: failedEvents });
  c.ok('invariants hold', inv.violations.length === 0, inv.violations.slice(0, 3));
  // the worker is not wedged: a good document still reaches ocr_ready afterwards
  const good = await (async () => {
    const bytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\nHQMS-FIXTURE:lab-note\n%%EOF\n', 'latin1');
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'good.pdf');
    form.append('patientId', uploaders[0] as string);
    const res = await fetch(`${api.url}/documents`, { method: 'POST', headers: { Cookie: reception.cookie as string }, body: form });
    const body: any = await res.json();
    for (let i = 0; i < 40; i += 1) {
      const st = (await pool.query(`SELECT status FROM documents WHERE id = $1`, [body.id])).rows[0]?.status;
      if (st === 'ocr_ready') return { uploadStatus: res.status, final: st, seconds: i * 0.5 };
      await sleep(500);
    }
    return { uploadStatus: res.status, final: 'not ready' };
  })();
  c.ok('after the failure period the same worker still processes a good document to ocr_ready', good.final === 'ocr_ready', good);
  await worker.stop();
  await api.stop();
  await pool.end();
  await dropDb(DB);
  save('ocrFail', {
    description: 'booking at a constant 30 req/s for 40 s in three phases: baseline, OCR fixture "fail" with 2 uploads/s (80 documents), baseline again',
    phases: result,
    p95RatioFailingOverBaselineMean: round1(ratio * 100) / 100,
    ocrOutcome: { documents: docs, jobs: jobStates, ocrFailedEvents: failedEvents, waitedSecondsForFinalState: round1((performance.now() - waitStart) / 1000) },
    afterwards: good,
    checks: c.list,
    allPass: c.list.every((x) => x.pass),
  });
}

// =====================================================================================================
// 4. database connections terminated / database refusing connections
// =====================================================================================================

async function dbConn(): Promise<void> {
  const DB = 'hqms_fail_conn';
  const c = checks();
  await recreateDb(DB);
  const pool = newPool(DB, 4);
  const api = await startApi({ dbName: DB, env: { DB_POOL_MAX: '10' } });
  const worker = startWorker({ dbName: DB, id: 't5-conn-worker' });
  const admin = await login(api.url, 'admin@hqms.test');
  const reception = await login(api.url, 'reception@hqms.test');
  const doctor = await login(api.url, doctorEmail(1));
  const RPS = 30;
  const SECONDS = 70;
  const total = RPS * SECONDS;
  const sessions: MadeSession[] = [];
  for (let i = 0; i < Math.ceil((total * 0.4) / 10) + 5; i += 1) sessions.push(await futureSession(admin, 1 + (i % 10), Math.floor(i / 10)));
  const patients = await bulkPatients(pool, 2000, 'CN');
  const readSession = await (async () => {
    const nowMs = Math.floor(Date.now() / 60_000) * 60_000;
    const s = await createSession(admin, { doctor: 1, startMs: nowMs - 10 * 60_000, durationMin: 240, booked: 10, walkin: 5 });
    if (!s) throw new Error('clash');
    return s;
  })();
  void doctor;

  interface Rec { t: number; kind: 'read' | 'book'; status: number; ms: number; code?: string; key?: string; sessionId?: string; patientId?: string; error?: string }
  const recs: Rec[] = [];
  const health: Array<{ t: number; status: number; ms: number }> = [];
  const events: Array<{ t: number; what: string }> = [];
  const T0 = performance.now();
  const now = (): number => round1((performance.now() - T0) / 1000);
  const healthTimer = setInterval(() => {
    const t = now();
    const t1 = performance.now();
    void fetch(`${api.url}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => health.push({ t, status: r.status, ms: performance.now() - t1 })).catch(() => health.push({ t, status: 0, ms: performance.now() - t1 }));
  }, 250);

  const terminate = async (all: boolean): Promise<number> => {
    const r = await pool.query(`SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid() AND ($2::boolean OR application_name = 'hqms-api')`, [DB, all]);
    return r.rows[0].n as number;
  };

  const schedule = (async () => {
    await sleep(10_000);
    events.push({ t: now(), what: `terminated ${await terminate(false)} API backends (one shot)` });
    await sleep(15_000);
    // database refuses connections for 8 s
    const adminPg = new pg.Client({ connectionString: ADMIN_URL });
    await adminPg.connect();
    await adminPg.query(`ALTER DATABASE "${DB}" WITH ALLOW_CONNECTIONS false`);
    const killed = await adminPg.query(`SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE datname = $1`, [DB]);
    events.push({ t: now(), what: `database closed to new connections; terminated ${killed.rows[0].n} backends (API pool and worker)` });
    await sleep(8000);
    await adminPg.query(`ALTER DATABASE "${DB}" WITH ALLOW_CONNECTIONS true`);
    events.push({ t: now(), what: 'database accepting connections again' });
    await adminPg.end();
    await sleep(12_000);
    for (let i = 0; i < 10; i += 1) {
      await terminate(false);
      await sleep(300);
    }
    events.push({ t: now(), what: 'flapping: API backends terminated 10 times, 300 ms apart (3 s)' });
  })();

  // steady open-loop traffic: 60% snapshot reads, 40% bookings
  let issued = 0;
  let bookCtr = 0;
  let inflight = 0;
  const interval = 1000 / RPS;
  const t0 = performance.now();
  await new Promise<void>((done) => {
    const step = (): void => {
      const nowMs = performance.now();
      while (issued < total && t0 + issued * interval <= nowMs) {
        issued += 1;
        inflight += 1;
        const t = now();
        if (Math.random() < 0.6) {
          void reception.get(`/sessions/${readSession.id}/queue`).then((r) => {
            recs.push({ t, kind: 'read', status: r.status, ms: r.ms, ...(r.code ? { code: r.code } : {}), ...(r.error ? { error: r.error } : {}) });
            inflight -= 1;
          });
        } else {
          const n = bookCtr++;
          const sessionId = (sessions[Math.floor(n / 10)] as MadeSession).id;
          const patientId = patients[n % patients.length] as string;
          const key = `t5-conn-${n}`;
          void reception.post('/appointments', { sessionId, patientId }, key).then((r) => {
            recs.push({ t, kind: 'book', status: r.status, ms: r.ms, key, sessionId, patientId, ...(r.code ? { code: r.code } : {}), ...(r.error ? { error: r.error } : {}) });
            inflight -= 1;
          });
        }
      }
      if (issued >= total) return done();
      setTimeout(step, 3);
    };
    step();
  });
  await schedule;
  while (inflight > 0) await sleep(50);
  clearInterval(healthTimer);
  await sleep(500);

  const bucket = (from: number, to: number): any => {
    const xs = recs.filter((r) => r.t >= from && r.t < to);
    const st: Record<string, number> = {};
    for (const r of xs) st[r.status] = (st[r.status] ?? 0) + 1;
    return { n: xs.length, status: st, latencyMs: dist(xs.map((r) => r.ms)) };
  };
  const bad = recs.filter((r) => r.status >= 500 || r.status === 0);
  const firstBad = bad.length ? Math.min(...bad.map((r) => r.t)) : undefined;
  const lastBad = bad.length ? Math.max(...bad.map((r) => r.t)) : undefined;
  const outage = events.find((e) => e.what.startsWith('database closed'));
  const reopened = events.find((e) => e.what.startsWith('database accepting'));
  const okAfterReopen = recs.filter((r) => reopened && r.t >= reopened.t && r.status >= 200 && r.status < 300).sort((a, b) => a.t - b.t)[0];
  const healthBad = health.filter((h) => h.status !== 200);
  const timeline: any[] = [];
  for (let s = 0; s < SECONDS + 2; s += 2) timeline.push({ fromSec: s, ...bucket(s, s + 2) });
  const retryErrors = recs.filter((r) => r.kind === 'book' && r.status !== 201 && r.status !== 409);
  const retryOutcome: Record<string, number> = {};
  for (const r of retryErrors) {
    const res = await reception.post('/appointments', { sessionId: r.sessionId, patientId: r.patientId }, r.key);
    retryOutcome[res.status] = (retryOutcome[res.status] ?? 0) + 1;
  }
  const booked201 = recs.filter((r) => r.kind === 'book' && r.status === 201).length;
  const bookedKeys = new Set(recs.filter((r) => r.kind === 'book').map((r) => r.key));
  const apptCount = (await pool.query(`SELECT count(*)::int AS n FROM appointments`)).rows[0].n as number;
  const idemCount = (await pool.query(`SELECT count(*)::int AS n FROM idempotency_records WHERE idem_key LIKE 't5-conn-%'`)).rows[0].n as number;
  const inv = await checkInvariants(pool);
  const apiAlive = api.alive();
  const workerAlive = worker.alive();
  // worker still works after the outage: enqueue-free check = a booking's timer job exists and the worker keeps polling (no crash)
  const workerLogErrors = worker.logs.filter((l) => /error/i.test(l)).length;
  const errorBodies = recs.filter((r) => r.status >= 500).reduce<Record<string, number>>((m, r) => ((m[`${r.status} ${r.code ?? 'no-code'}`] = (m[`${r.status} ${r.code ?? 'no-code'}`] ?? 0) + 1), m), {});
  const netErrors = recs.filter((r) => r.status === 0).reduce<Record<string, number>>((m, r) => ((m[(r.error ?? 'unknown').slice(0, 70)] = (m[(r.error ?? 'unknown').slice(0, 70)] ?? 0) + 1), m), {});
  c.ok('the API process survived every connection loss', apiAlive, { apiPid: api.pid });
  c.ok('errors during the outage were controlled 5xx responses with a JSON error code (no hangs)', bad.length > 0 && Object.keys(errorBodies).every((k) => /^5\d\d /.test(k)) && Math.max(...bad.map((r) => r.ms)) < 15_000, { errorBodies, networkErrors: netErrors, slowestErrorMs: bad.length ? round1(Math.max(...bad.map((r) => r.ms))) : 0 });
  c.ok('requests succeed again after the database reopens', okAfterReopen !== undefined, { reopenedAtSec: reopened?.t, firstSuccessAtSec: okAfterReopen?.t, secondsToFirstSuccess: okAfterReopen && reopened ? round1(okAfterReopen.t - reopened.t) : null });
  c.ok('idempotent retry of every failed booking returned 201 or a business 409 (never 5xx)', Object.keys(retryOutcome).every((s) => s === '201' || s === '409'), { retried: retryErrors.length, outcome: retryOutcome });
  c.ok('no duplicate or lost booking: appointments in the database equal distinct idempotency records of bookings', apptCount === idemCount && apptCount <= bookedKeys.size, { appointments: apptCount, idempotencyRecords: idemCount, distinctKeysSent: bookedKeys.size, answered201: booked201 });
  c.ok('invariants hold', inv.violations.length === 0, inv.violations.slice(0, 3));
  c.ok('the worker process survived', workerAlive, { workerLogErrorLines: workerLogErrors });
  await worker.stop();
  await api.stop();
  await pool.end();
  await dropDb(DB);
  save('dbConn', {
    description: '30 req/s (60% snapshot GET, 40% POST /appointments) for 70 s; pg_terminate_backend on the API pool at 10 s, database closed to new connections for 8 s at ~25 s, 10 terminations 300 ms apart at ~45 s',
    events, errorBodies, networkErrors: netErrors, recordsTotal: recs.length, firstBadSec: firstBad, lastBadSec: lastBad,
    health: { probes: health.length, non200: healthBad.length, non200Statuses: healthBad.reduce<Record<string, number>>((m, h) => ((m[h.status] = (m[h.status] ?? 0) + 1), m), {}) },
    timeline, retryOutcome, apiAlive, workerAlive, checks: c.list, allPass: c.list.every((x) => x.pass),
  });
}

// =====================================================================================================

const SCENARIOS: Record<string, () => Promise<void>> = { 'api-kill': apiKill, 'worker-kill': workerKill, 'ocr-fail': ocrFail, 'db-conn': dbConn };

async function main(): Promise<void> {
  buildAll();
  const wanted = process.argv.slice(2).filter((a) => a in SCENARIOS);
  for (const name of wanted.length ? wanted : Object.keys(SCENARIOS)) {
    log(`=== ${name} ===`);
    await (SCENARIOS[name] as () => Promise<void>)();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
