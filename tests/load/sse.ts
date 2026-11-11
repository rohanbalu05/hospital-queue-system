/**
 * T3 (report Table 5; FR-09, FR-10, NFR-02): 200 live clients with commands running, reconnect recovery and ETA calibration.
 *
 *   pnpm --filter @hqms/tests load:sse
 *   SSE_SECONDS=60 pnpm --filter @hqms/tests load:sse        # shorter run
 *
 * Part 1  200 SSE clients (170 patient-scoped, 22 staff, 8 display) while doctors run call-next/start/complete cycles and reception
 *         admits walk-ins at randomised moments. For every commit and every interested client: time from the command response
 *         (the commit precedes it) to (a) the first notice with version >= the commit's and (b) the first snapshot refetch that
 *         shows that version (clients refetch the authoritative snapshot when a notice arrives). Missing = no notice with version
 *         >= V within the grace period after the run; stale = client's final version differs from the database.
 * Part 2  Drop 50 clients, run commits while they are away, reconnect them: the first notice must carry the committed version and
 *         the snapshot must match it.
 * Part 3  ETA observed error: two scripted sessions with known consultation durations; predicted start range (patient snapshot)
 *         against the actual call time. Small synthetic sample, time-scaled (see the evidence file).
 *
 * One machine runs the API (production bundle), the worker, PostgreSQL and these clients. Raw numbers: docs/evidence/T3-live-freshness-200.raw.json.
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
  dropDb,
  evidenceDir,
  Http,
  istDate,
  login,
  machineInfo,
  newPool,
  recreateDb,
  round1,
  Sampler,
  sleep,
  startApi,
  startWorker,
  summariseSamples,
  type MadeSession,
} from './lib/harness.js';

const DB = process.env['SSE_DB'] ?? 'hqms_load_sse';
const SECONDS = Number(process.env['SSE_SECONDS'] ?? 180);
const OUT = process.env['SSE_OUT'] ?? resolve(evidenceDir, 'T3-live-freshness-200.raw.json');
const DISPLAY_REFETCH = (process.env['SSE_DISPLAY_REFETCH'] ?? 'true') !== 'false';
const log = (m: string): void => console.log(`[sse ${new Date().toISOString().slice(11, 19)}] ${m}`);
const rnd = (n: number): number => Math.floor(Math.random() * n);
const between = (a: number, b: number): number => a + Math.random() * (b - a);

interface Notice {
  sessionId: string;
  queueVersion: number;
  eventType: string;
}

type Kind = 'patient' | 'staff' | 'display';

/** One live client: SSE stream with parsed notices, plus the refetch a real screen does when a notice arrives. */
class Client {
  readonly notices: Array<{ at: number; sessionId: string; version: number; type: string }> = [];
  readonly snaps: Array<{ at: number; sessionId: string; version: number; ms: number; status: number }> = [];
  readonly maxBySession = new Map<string, number>();
  pings = 0;
  regress = 0; // a notice with a version lower than one already seen for that session
  errorEvents = 0;
  private abort = new AbortController();
  private done: Promise<void> = Promise.resolve();
  private fetching = false;
  private wanted = new Map<string, number>();
  connectedAt = 0;
  connectMs = 0;
  closed = false;

  constructor(
    readonly id: number,
    readonly kind: Kind,
    readonly http: Http,
    readonly sessions: string[],
    readonly refetch: boolean,
  ) {}

  async connect(): Promise<void> {
    this.abort = new AbortController();
    this.closed = false;
    const path = this.kind === 'display' ? '/display/events' : `/sessions/${this.sessions[0]}/events`;
    const t0 = performance.now();
    const res = await fetch(`${this.http.base}${path}`, { headers: { ...(this.http.cookie ? { Cookie: this.http.cookie } : {}), Accept: 'text/event-stream' }, signal: this.abort.signal });
    if (res.status !== 200) throw new Error(`SSE ${path}: ${res.status} ${await res.text()}`);
    this.connectMs = performance.now() - t0;
    this.connectedAt = performance.now();
    this.done = this.pump(res);
  }

  private async pump(res: Response): Promise<void> {
    const reader = res.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const at = performance.now();
        buffer += decoder.decode(value, { stream: true });
        let cut = buffer.indexOf('\n\n');
        while (cut >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event === 'ping') this.pings += 1;
          if (event === 'error') this.errorEvents += 1;
          if (event === 'queue' && data) {
            const n = JSON.parse(data) as Notice;
            const prev = this.maxBySession.get(n.sessionId) ?? -1;
            if (n.queueVersion < prev) this.regress += 1;
            this.maxBySession.set(n.sessionId, Math.max(prev, n.queueVersion));
            this.notices.push({ at, sessionId: n.sessionId, version: n.queueVersion, type: n.eventType });
            if (this.refetch) this.want(n.sessionId, n.queueVersion);
          }
          cut = buffer.indexOf('\n\n');
        }
      }
    } catch {
      /* aborted on purpose */
    }
  }

  /** Coalesced refetch: at most one snapshot request in flight per client, re-run if a newer version arrived meanwhile. */
  private want(sessionId: string, version: number): void {
    this.wanted.set(sessionId, Math.max(version, this.wanted.get(sessionId) ?? 0));
    if (this.fetching) return;
    this.fetching = true;
    void (async () => {
      try {
        while (this.wanted.size > 0 && !this.closed) {
          const [sid, v] = [...this.wanted.entries()][0] as [string, number];
          this.wanted.delete(sid);
          const t0 = performance.now();
          const path = this.kind === 'display' ? '/display/sessions' : `/sessions/${sid}/queue`;
          const r = await this.http.get(path);
          const at = performance.now();
          if (r.status === 200) {
            if (this.kind === 'display') {
              for (const col of r.body.columns ?? []) this.snaps.push({ at, sessionId: col.sessionId, version: col.queueVersion, ms: at - t0, status: 200 });
            } else this.snaps.push({ at, sessionId: sid, version: r.body.queueVersion, ms: at - t0, status: 200 });
          } else this.snaps.push({ at, sessionId: sid, version: -1, ms: at - t0, status: r.status });
          void v;
        }
      } finally {
        this.fetching = false;
      }
    })();
  }

  firstNotice(sessionId: string, version: number): number | undefined {
    for (const n of this.notices) if (n.sessionId === sessionId && n.version >= version) return n.at;
    return undefined;
  }
  firstSnapshot(sessionId: string, version: number): number | undefined {
    for (const s of this.snaps) if (s.sessionId === sessionId && s.version >= version) return s.at;
    return undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    await this.done;
  }
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

interface Commit {
  sessionId: string;
  version: number;
  receivedAt: number;
  sentAt: number;
  kind: string;
}

async function main(): Promise<void> {
  buildAll();
  await recreateDb(DB);
  const pool = newPool(DB, 4);
  const today = istDate(new Date());
  // keep the scale at Table 3: the seeded sessions of today (20) are closed, the 20 sessions below are the day's schedule
  await pool.query(`UPDATE sessions SET status = 'closed' WHERE session_date = $1::date`, [today]);
  const api = await startApi({ dbName: DB, env: { DB_POOL_MAX: '20', SSE_POLL_MS: '500', SSE_PING_MS: '15000' } });
  const worker = startWorker({ dbName: DB, id: 't3-worker' });
  log(`api ${api.url} pid ${api.pid}`);

  const admin = await login(api.url, 'admin@hqms.test');
  const admin2 = await login(api.url, 'admin2@hqms.test');
  const receptions = await pmap([1, 2, 3, 4, 5, 6], 6, (n) => login(api.url, n === 1 ? 'reception@hqms.test' : `reception${n}@hqms.test`));
  const doctors = await pmap([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5, (n) => login(api.url, doctorEmail(n)));

  // 20 running sessions (10 doctors x 2), 170 patients with logins and an entry each
  const nowMin = Math.floor(Date.now() / 60_000) * 60_000;
  const sessions: MadeSession[] = [];
  for (let d = 1; d <= 10; d += 1) for (const off of [-20, -21]) {
    const s = await createSession(admin, { doctor: d, startMs: nowMin + off * 60_000, durationMin: 240, booked: 10, walkin: 60 });
    if (!s) throw new Error('clash');
    sessions.push(s);
    const o = await (receptions[0] as Http).post(`/sessions/${s.id}/open`, {});
    if (o.status !== 200) throw new Error(`open failed ${o.status}`);
  }
  const patientIds = await bulkPatients(pool, 800, 'SS');
  const emails = await bulkPatientLogins(pool, patientIds, 170, 'ssepatient');
  const patientHttp = await pmap(emails, 8, (e) => login(api.url, e));
  const sessionOfPatient: MadeSession[] = [];
  await pmap(patientIds.slice(0, 170), 6, async (pid, i) => {
    const s = sessions[i % sessions.length] as MadeSession;
    sessionOfPatient[i] = s;
    const k = Math.floor(i / sessions.length);
    if (k < 3) {
      const r = await (receptions[i % 6] as Http).post(`/sessions/${s.id}/walk-ins`, { patientId: pid });
      if (r.status !== 201) throw new Error(`walk-in ${r.status} ${JSON.stringify(r.body)}`);
    } else {
      const b = await (receptions[i % 6] as Http).post('/appointments', { sessionId: s.id, patientId: pid });
      if (b.status !== 201) throw new Error(`book ${b.status} ${JSON.stringify(b.body)}`);
      const c = await (receptions[i % 6] as Http).post(`/appointments/${b.body.id}/check-in`, {});
      if (c.status !== 200 && c.status !== 201) throw new Error(`check-in ${c.status} ${JSON.stringify(c.body)}`);
    }
  });
  const extraPatients = patientIds.slice(170);
  log(`setup done: ${sessions.length} sessions, 170 patient entries`);

  // ---------------- clients: 170 patient + 22 staff + 8 display ----------------
  const clients: Client[] = [];
  let cid = 0;
  for (let i = 0; i < 170; i += 1) clients.push(new Client(cid++, 'patient', patientHttp[i] as Http, [(sessionOfPatient[i] as MadeSession).id], true));
  for (let d = 0; d < 10; d += 1) clients.push(new Client(cid++, 'staff', doctors[d] as Http, [(sessions[d * 2] as MadeSession).id], true)); // 10 doctors
  for (let r = 0; r < 6; r += 1) clients.push(new Client(cid++, 'staff', receptions[r] as Http, [(sessions[r * 3] as MadeSession).id], true)); // 6 reception
  clients.push(new Client(cid++, 'staff', admin, [(sessions[1] as MadeSession).id], true), new Client(cid++, 'staff', admin2, [(sessions[2] as MadeSession).id], true)); // 2 admin
  for (let d = 0; d < 4; d += 1) clients.push(new Client(cid++, 'staff', doctors[d] as Http, [(sessions[d * 2 + 1] as MadeSession).id], true)); // 4 second tabs (follow-up users have no session stream route)
  for (let k = 0; k < 8; k += 1) clients.push(new Client(cid++, 'display', new Http(api.url), [], DISPLAY_REFETCH));
  const kinds = { patient: clients.filter((c) => c.kind === 'patient').length, staff: clients.filter((c) => c.kind === 'staff').length, display: clients.filter((c) => c.kind === 'display').length };
  const t0c = performance.now();
  await pmap(clients, 40, (c) => c.connect());
  log(`${clients.length} SSE clients connected in ${round1(performance.now() - t0c)} ms (${JSON.stringify(kinds)})`);
  await sleep(1500);

  const sampler = new Sampler(pool, DB, { api: () => api.pid, worker: () => worker.pid }, 5000);
  sampler.start();
  const commits: Commit[] = [];
  const cmdStatus: Record<string, number> = {};
  let running = true;
  const note = (kind: string, status: number): void => void (cmdStatus[`${kind} ${status}`] = (cmdStatus[`${kind} ${status}`] ?? 0) + 1);

  // doctor loops: call-next -> start -> complete with random think times
  const doctorLoop = async (d: number): Promise<void> => {
    const http = doctors[d] as Http;
    const mine = [sessions[d * 2], sessions[d * 2 + 1]] as MadeSession[];
    while (running) {
      await sleep(between(250, 1200));
      if (!running) return;
      const s = mine[rnd(2)] as MadeSession;
      const sentAt = performance.now();
      const call = await http.post(`/sessions/${s.id}/call-next`, {});
      const receivedAt = performance.now();
      note('call-next', call.status);
      if (call.status !== 200) continue;
      commits.push({ sessionId: s.id, version: call.body.decision.queueVersion, receivedAt, sentAt, kind: 'call-next' });
      const entry = call.body.entry;
      if (!entry) continue;
      await sleep(between(250, 1200));
      let t1 = performance.now();
      const st = await http.post(`/visits/${entry.visitId}/start`, {});
      note('start', st.status);
      if (st.status === 200) commits.push({ sessionId: s.id, version: st.body.queueVersion, receivedAt: performance.now(), sentAt: t1, kind: 'start' });
      await sleep(between(250, 1200));
      t1 = performance.now();
      const done = await http.post(`/visits/${entry.visitId}/complete`, {});
      note('complete', done.status);
      if (done.status === 200) commits.push({ sessionId: s.id, version: done.body.queueVersion, receivedAt: performance.now(), sentAt: t1, kind: 'complete' });
    }
  };
  let extraCtr = 0;
  const receptionLoop = async (r: number): Promise<void> => {
    const http = receptions[r] as Http;
    while (running) {
      await sleep(between(300, 1500));
      if (!running) return;
      const s = sessions[rnd(sessions.length)] as MadeSession;
      const pid = extraPatients[extraCtr++ % extraPatients.length] as string;
      const sentAt = performance.now();
      const w = await http.post(`/sessions/${s.id}/walk-ins`, { patientId: pid });
      note('walk-in', w.status);
      if (w.status === 201) commits.push({ sessionId: s.id, version: w.body.queueVersion, receivedAt: performance.now(), sentAt, kind: 'walk-in' });
    }
  };

  log(`running commands for ${SECONDS} s (10 doctor loops, 6 reception loops, randomised 0.25 to 1.5 s think times)`);
  const loops = [...Array.from({ length: 10 }, (_, d) => doctorLoop(d)), ...Array.from({ length: 6 }, (_, r) => receptionLoop(r))];
  const runStart = performance.now();
  await sleep(SECONDS * 1000);
  running = false;
  await Promise.all(loops);
  const runSeconds = (performance.now() - runStart) / 1000;
  await sleep(6000); // grace for the last notices and refetches
  const samples = await sampler.stop();

  // ---------------- analysis part 1 ----------------
  const versionsInDb = new Map<string, number>((await pool.query(`SELECT id, queue_version::int AS v FROM sessions`)).rows.map((r) => [r.id as string, r.v as number]));
  const interested = (c: Client, sessionId: string): boolean => c.kind === 'display' || c.sessions.includes(sessionId);
  const noticeFromResponse: number[] = [];
  const noticeFromSend: number[] = [];
  const snapFromResponse: number[] = [];
  const perKind: Record<Kind, { notice: number[]; snap: number[] }> = { patient: { notice: [], snap: [] }, staff: { notice: [], snap: [] }, display: { notice: [], snap: [] } };
  let expectedDeliveries = 0;
  let missingNotices = 0;
  let missingSnapshots = 0;
  let early = 0;
  const worstCommit: { kind: string; ms: number }[] = [];
  for (const cm of commits) {
    let worst = 0;
    for (const c of clients) {
      if (!interested(c, cm.sessionId)) continue;
      expectedDeliveries += 1;
      const n = c.firstNotice(cm.sessionId, cm.version);
      if (n === undefined) {
        missingNotices += 1;
      } else {
        if (n < cm.receivedAt) early += 1;
        const dt = Math.max(0, n - cm.receivedAt);
        noticeFromResponse.push(dt);
        noticeFromSend.push(n - cm.sentAt);
        perKind[c.kind].notice.push(dt);
        worst = Math.max(worst, dt);
      }
      if (c.refetch) {
        const s = c.firstSnapshot(cm.sessionId, cm.version);
        if (s === undefined) missingSnapshots += 1;
        else {
          const dt = Math.max(0, s - cm.receivedAt);
          snapFromResponse.push(dt);
          perKind[c.kind].snap.push(dt);
        }
      }
    }
    worstCommit.push({ kind: cm.kind, ms: worst });
  }
  // stale: a client whose last seen version differs from the database version of a session it follows
  let staleClients = 0;
  const staleDetail: string[] = [];
  for (const c of clients) {
    const sess = c.kind === 'display' ? [...c.maxBySession.keys()] : c.sessions;
    for (const sid of sess) {
      const dbv = versionsInDb.get(sid);
      if (dbv !== undefined && c.maxBySession.get(sid) !== dbv) {
        staleClients += 1;
        if (staleDetail.length < 5) staleDetail.push(`client ${c.id} ${c.kind} session ${sid.slice(0, 8)} saw ${c.maxBySession.get(sid)} db ${dbv}`);
      }
    }
  }
  const snapStatus: Record<string, number> = {};
  const snapMs: number[] = [];
  for (const c of clients) for (const s of c.snaps) {
    snapStatus[s.status] = (snapStatus[s.status] ?? 0) + 1;
    snapMs.push(s.ms);
  }
  const part1 = {
    clients: { total: clients.length, ...kinds, note: 'staff = 10 doctors + 6 reception + 2 admin + 4 second doctor tabs (follow-up users have no session stream route)' },
    runSecondsCommands: round1(runSeconds),
    commits: commits.length,
    commitsPerSecond: round1(commits.length / runSeconds),
    commandOutcomes: cmdStatus,
    expectedDeliveries,
    noticeFreshnessMs_commitResponseToNotice: dist(noticeFromResponse),
    noticeFreshnessMs_commandSentToNotice: dist(noticeFromSend),
    perClientKindNoticeMs: Object.fromEntries(Object.entries(perKind).map(([k, v]) => [k, dist(v.notice)])),
    worstCommitMs_maxAcrossClients: dist(worstCommit.map((w) => w.ms)),
    snapshotFreshnessMs_commitResponseToSnapshotWithVersion: dist(snapFromResponse),
    perClientKindSnapshotMs: Object.fromEntries(Object.entries(perKind).map(([k, v]) => [k, dist(v.snap)])),
    snapshotRefetchRequestMs: dist(snapMs),
    snapshotRefetchStatus: snapStatus,
    refetchNote: DISPLAY_REFETCH ? 'every client refetches its snapshot after a notice (displays: GET /display/sessions)' : 'patient and staff clients refetch; displays do not',
    missingNotices,
    missingSnapshots,
    noticesBeforeCommandResponse: early,
    clientsWithFinalVersionDifferentFromDb: staleClients,
    staleDetail,
    versionRegressions: clients.reduce((a, c) => a + c.regress, 0),
    sseErrorEvents: clients.reduce((a, c) => a + c.errorEvents, 0),
    pingsSeen: clients.reduce((a, c) => a + c.pings, 0),
    target: 'NFR-02: p95 commit-to-client freshness <= 5 s with 200 clients, unexpected server errors < 1% (targets, not results)',
    resources: summariseSamples(samples),
  };
  log(`part 1: ${commits.length} commits, ${expectedDeliveries} deliveries; notice p50/p95/p99/max ${JSON.stringify(part1.noticeFreshnessMs_commitResponseToNotice)}; snapshot ${JSON.stringify(part1.snapshotFreshnessMs_commitResponseToSnapshotWithVersion)}; missing ${missingNotices}, stale ${staleClients}`);

  // ---------------- part 2: reconnect ----------------
  const dropped = clients.filter((_, i) => i % 4 === 0).slice(0, 50); // mix of kinds
  const droppedKinds = { patient: dropped.filter((c) => c.kind === 'patient').length, staff: dropped.filter((c) => c.kind === 'staff').length, display: dropped.filter((c) => c.kind === 'display').length };
  await Promise.all(dropped.map((c) => c.close()));
  // commits while they are away
  running = true;
  const awayCommits: Commit[] = [];
  const before = commits.length;
  const awayLoops = [...Array.from({ length: 10 }, (_, d) => doctorLoop(d)), ...Array.from({ length: 6 }, (_, r) => receptionLoop(r))];
  await sleep(8000);
  running = false;
  await Promise.all(awayLoops);
  awayCommits.push(...commits.slice(before));
  await sleep(1000); // quiet: nothing commits from here on
  const committedAtReconnect = new Map<string, number>((await pool.query(`SELECT id, queue_version::int AS v FROM sessions`)).rows.map((r) => [r.id as string, r.v as number]));
  const tR = performance.now();
  for (const c of dropped) {
    c.notices.length = 0;
    c.snaps.length = 0;
    c.maxBySession.clear();
  }
  await pmap(dropped, 50, (c) => c.connect());
  await sleep(2500);
  let firstNoticeCorrect = 0;
  let snapshotCorrect = 0;
  let neverGotNotice = 0;
  const wrong: string[] = [];
  const reconnectMs: number[] = [];
  for (const c of dropped) {
    const sids = c.kind === 'display' ? [...c.maxBySession.keys()].filter((s) => committedAtReconnect.has(s)) : c.sessions;
    const first = c.notices[0];
    if (!first) {
      neverGotNotice += 1;
      continue;
    }
    reconnectMs.push(first.at - tR);
    if (c.kind === 'display') {
      // a display gets one `connected` notice per open session of today; each must equal the committed version
      const bad = c.notices.filter((n) => committedAtReconnect.get(n.sessionId) !== n.version);
      if (bad.length === 0 && c.notices.length >= 1) firstNoticeCorrect += 1;
      else wrong.push(`display ${c.id}: ${bad.length} of ${c.notices.length} notices differ from the committed version`);
      const snap = await c.http.get('/display/sessions');
      const ok = (snap.body.columns ?? []).every((col: any) => committedAtReconnect.get(col.sessionId) === col.queueVersion);
      if (ok) snapshotCorrect += 1;
      else wrong.push(`display ${c.id}: snapshot version mismatch`);
    } else {
      const sid = sids[0] as string;
      const v = committedAtReconnect.get(sid);
      if (first.type === 'connected' && first.version === v) firstNoticeCorrect += 1;
      else wrong.push(`client ${c.id} ${c.kind}: first notice ${first.type} v${first.version}, committed v${v}`);
      const snap = await c.http.get(`/sessions/${sid}/queue`);
      if (snap.status === 200 && snap.body.queueVersion === v) snapshotCorrect += 1;
      else wrong.push(`client ${c.id} ${c.kind}: snapshot ${snap.status} v${snap.body?.queueVersion}, committed v${v}`);
    }
  }
  const part2 = {
    dropped: dropped.length,
    droppedKinds,
    commitsWhileAway: awayCommits.length,
    reconnectedAndFirstNoticeEqualsCommittedVersion: firstNoticeCorrect,
    snapshotVersionEqualsCommittedVersion: snapshotCorrect,
    neverReceivedNotice: neverGotNotice,
    mismatches: wrong.slice(0, 10),
    reconnectToFirstNoticeMs: dist(reconnectMs),
    connectResponseHeadersMs: dist(dropped.map((c) => c.connectMs)),
    note: 'all 50 reconnect at the same instant; commands are paused from one second before the committed versions are read until the check ends',
  };
  log(`part 2: ${firstNoticeCorrect}/${dropped.length} first notices equal the committed version, ${snapshotCorrect}/${dropped.length} snapshots`);

  await Promise.all(clients.map((c) => c.close()));

  // ---------------- part 3: ETA calibration ----------------
  const part3 = await etaCalibration(api.url, admin, receptions[0] as Http, doctors, pool, extraPatients);

  const inv = await checkInvariants(pool);
  const serverErrors = [...api.logs, ...worker.logs].filter((l) => /\bERROR\b|Unhandled|deadlock/i.test(l));
  const all = {
    generatedAt: new Date().toISOString(),
    environment: { machine: machineInfo(), config: 'API apps/api/dist/main.js NODE_ENV=production DB_POOL_MAX=20 SSE_POLL_MS=500 SSE_PING_MS=15000; worker default; PostgreSQL 16 localhost; clients and command generator in this Node process; fakes for OCR/LLM; seeded sessions of today closed so the day has exactly the 20 sessions below (+ ETA sessions)' },
    part1, part2, part3,
    unexpectedServerErrors: { apiOrWorkerLogErrorLines: serverErrors.length, sample: serverErrors.slice(0, 5), commandStatusesOtherThan2xx: Object.fromEntries(Object.entries(cmdStatus).filter(([k]) => !/ 2\d\d$/.test(k))), snapshotRefetchStatusOtherThan200: Object.fromEntries(Object.entries(snapStatus).filter(([k]) => k !== '200')) },
    invariants: { violations: inv.violations.length, sample: inv.violations.slice(0, 3) },
  };
  writeFileSync(OUT, `${JSON.stringify(all, null, 2)}\n`);
  log(`written ${OUT}`);
  await worker.stop();
  await api.stop();
  await pool.end();
  await dropDb(DB);
}

// =====================================================================================================
// Part 3
// =====================================================================================================

async function etaCalibration(apiUrl: string, admin: Http, reception: Http, doctors: Http[], pool: ReturnType<typeof newPool>, spare: string[]): Promise<unknown> {
  // Time scaling (declared): the initial estimate is 0.25 min (15 s) instead of 12 min, so a scripted consultation of a few seconds
  // exercises the same model (EWMA, range +-50% cold start, residual of the active consultation) in a feasible time.
  await pool.query(`UPDATE queue_policies SET initial_estimate_min = 0.25`);
  const runs = [
    { name: 'durations match the assumed mean (about 15 s each)', doctor: 9, durations: [12, 18, 14, 16, 11, 19, 15, 13, 17, 15] },
    { name: 'durations about 1.6x the assumed mean (about 24 s each)', doctor: 10, durations: [22, 28, 24, 20, 26, 25, 23, 27, 21, 24] },
  ];
  const out = await Promise.all(
    runs.map(async (run) => {
      const nowMin = Math.floor(Date.now() / 60_000) * 60_000;
      const s = await createSession(admin, { doctor: run.doctor, startMs: nowMin - 40 * 60_000 - run.doctor * 60_000, durationMin: 240, booked: 10, walkin: 40, label: 'morning' });
      if (!s) throw new Error('clash');
      await reception.post(`/sessions/${s.id}/open`, {});
      const n = run.durations.length;
      const ids = await bulkPatients(pool, n, `ETA${run.doctor}`);
      const emails = await bulkPatientLogins(pool, ids, n, `etapatient${run.doctor}x`);
      const logins = await Promise.all(emails.map((e) => login(apiUrl, e)));
      for (const pid of ids) {
        const w = await reception.post(`/sessions/${s.id}/walk-ins`, { patientId: pid });
        if (w.status !== 201) throw new Error(`eta walk-in ${w.status}`);
      }
      void spare;
      const doc = doctors[run.doctor - 1] as Http;
      interface Pred { patient: number; at: number; low: number | null; high: number | null; mean: number; samples: number; position: number | null; status: string; uncertainty: string | null }
      const preds: Pred[] = [];
      const waiting = new Set<number>(ids.map((_, i) => i));
      const snapAll = async (): Promise<void> => {
        await Promise.all([...waiting].map(async (i) => {
          const r = await (logins[i] as Http).get(`/sessions/${s.id}/queue`);
          if (r.status !== 200) return;
          const e = r.body.myEntry.eta;
          preds.push({ patient: i, at: performance.now(), low: e.lowMinutes, high: e.highMinutes, mean: e.estimatorMeanMinutes, samples: e.estimatorSamples, position: r.body.myEntry.position, status: e.status, uncertainty: e.uncertainty });
        }));
      };
      const calledAt = new Map<number, number>();
      const entryPatient = new Map<string, number>();
      const preQueue = (await Promise.all(ids.map(async (_, i) => (await (logins[i] as Http).get(`/sessions/${s.id}/queue`)).body.myEntry.queueEntryId as string)));
      preQueue.forEach((eid, i) => entryPatient.set(eid, i));
      await snapAll(); // at check-in: every patient's first prediction (nobody called yet)
      const atCheckInCount = preds.length;
      for (let k = 0; k < n; k += 1) {
        const call = await doc.post(`/sessions/${s.id}/call-next`, {});
        if (call.status !== 200 || !call.body.entry) throw new Error(`eta call-next ${call.status}`);
        const who = entryPatient.get(call.body.entry.id) as number;
        calledAt.set(who, performance.now());
        waiting.delete(who);
        const st = await doc.post(`/visits/${call.body.entry.visitId}/start`, {});
        if (st.status !== 200) throw new Error(`eta start ${st.status}`);
        await sleep((run.durations[k] as number) * 1000);
        const done = await doc.post(`/visits/${call.body.entry.visitId}/complete`, {});
        if (done.status !== 200) throw new Error(`eta complete ${done.status}`);
        await snapAll(); // refreshed predictions for those still waiting
      }
      const rows = preds.filter((p) => p.status === 'ok' && p.low !== null && p.high !== null).map((p) => {
        const actualMin = ((calledAt.get(p.patient) as number) - p.at) / 60_000;
        return { ...p, actualMin, inside: actualMin >= (p.low as number) && actualMin <= (p.high as number), midErrorMin: actualMin - ((p.low as number) + (p.high as number)) / 2 };
      });
      const lastPred = preds[preds.length - 1];
      const checkIn = rows.slice(0, atCheckInCount);
      const refreshed = rows.slice(atCheckInCount);
      const share = (xs: typeof rows): { n: number; inside: number; insidePct: number } => ({ n: xs.length, inside: xs.filter((x) => x.inside).length, insidePct: xs.length ? round1((100 * xs.filter((x) => x.inside).length) / xs.length) : NaN });
      const bucket = (xs: typeof rows, lo: number, hi: number): ReturnType<typeof share> => share(xs.filter((x) => x.position !== null && x.position >= lo && x.position <= hi));
      return {
        scenario: run.name,
        doctor: run.doctor,
        patients: n,
        knownDurationsSeconds: run.durations,
        atCheckInPrediction: { ...share(checkIn), signedErrorMinutesFromRangeMidpoint: dist(checkIn.map((x) => Math.abs(x.midErrorMin))), meanSignedErrorMin: round1(checkIn.reduce((a, x) => a + x.midErrorMin, 0) / Math.max(1, checkIn.length) * 100) / 100, note: 'actual wait (from the prediction until the patient was called) vs predicted [low, high]; every patient predicted at the same moment, cold start (0 samples, range +-50%)' },
        refreshedAfterEachCompletion: { ...share(refreshed), positions1to2: bucket(refreshed, 1, 2), positions3to5: bucket(refreshed, 3, 5), positions6plus: bucket(refreshed, 6, 99) },
        estimatorAtEnd: lastPred ? { meanMinutes: lastPred.mean, samples: lastPred.samples } : null,
        rangeWidthAtCheckInMinutes: checkIn.slice(0, 3).map((x) => [x.low, x.high]),
      };
    }),
  );
  return { timeScaling: 'initial estimate set to 0.25 min (15 s) in the scratch database; durations in seconds; the structure of the model is exercised, the 12-minute calibration is not', sample: 'small synthetic sample, 10 patients per scenario, two scenarios', scenarios: out };
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
