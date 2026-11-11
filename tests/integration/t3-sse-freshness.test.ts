/**
 * T3 (report Table 5, FR-09, NFR-02), quick version: reconnect recovery and commit-to-client freshness of the SSE stream.
 *
 *  - Reconnect: a client that connects (or reconnects) first receives the committed version, and that version equals
 *    both `GET /sessions/:id/queue` and `sessions.queue_version` in the database, also after commits it missed.
 *  - Freshness: N = 50 simultaneous SSE clients on one session; 20 cycles of call-next, start, complete (60 commits).
 *    For every commit the time until each client holds a notice with version >= the commit's version is recorded.
 *
 * Measured with 50 clients on one machine against the default 500 ms server poll. This is NOT the 200-client
 * target of NFR-02 and not a hosted-environment number; see docs/evidence/T3-live-freshness.md.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are JSON of known shapes that each test narrows */
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { percentile, type ApiClient } from '../support/client.js';
import { recordResult, T3_RESULTS_FILE } from '../support/results.js';
import {
  admitWalkIns,
  apiUrl,
  closePool,
  doctorEmail,
  loginAs,
  makeRunningSession,
  openSession,
  registerPatients,
  round1,
  sqlRows,
} from '../support/world.js';

const CLIENTS = Number(process.env['T3_CLIENTS'] ?? 50);
const CYCLES = Number(process.env['T3_CYCLES'] ?? 20);
const DOCTOR = 9;

interface Notice {
  sessionId: string;
  queueVersion: number;
  eventType: string;
  committedAt: string;
}

/** A real SSE connection: Cookie auth, parsed `event: queue` notices with their arrival time. */
class SseClient {
  readonly notices: Array<{ at: number; notice: Notice }> = [];
  private readonly done: Promise<void>;
  private waiters: Array<() => void> = [];
  maxVersion = -1;
  pings = 0;

  private constructor(
    res: Response,
    private readonly abort: AbortController,
  ) {
    this.done = this.pump(res);
  }

  static async connect(base: string, path: string, cookie: string | undefined): Promise<SseClient> {
    const abort = new AbortController();
    const res = await fetch(`${base}${path}`, {
      headers: { ...(cookie ? { Cookie: cookie } : {}), Accept: 'text/event-stream' },
      signal: abort.signal,
    });
    if (res.status !== 200) throw new Error(`SSE ${path}: ${res.status} ${await res.text()}`);
    return new SseClient(res, abort);
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
          if (event === 'queue' && data) {
            const notice = JSON.parse(data) as Notice;
            this.notices.push({ at, notice });
            this.maxVersion = Math.max(this.maxVersion, notice.queueVersion);
            for (const w of this.waiters.splice(0)) w();
          }
          cut = buffer.indexOf('\n\n');
        }
      }
    } catch {
      /* aborted on purpose */
    }
  }

  /** Resolves when a notice with version >= `v` has arrived; returns that notice's arrival time. */
  async reached(v: number, timeoutMs = 10_000): Promise<number> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const hit = this.notices.find((n) => n.notice.queueVersion >= v);
      if (hit) return hit.at;
      const left = deadline - performance.now();
      if (left <= 0)
        throw new Error(`no notice with version >= ${v} within ${timeoutMs} ms (max seen ${this.maxVersion})`);
      await new Promise<void>((ok) => {
        const t = setTimeout(ok, left);
        this.waiters.push(() => {
          clearTimeout(t);
          ok();
        });
      });
    }
  }

  async close(): Promise<void> {
    this.abort.abort();
    await this.done;
  }
}

let admin: ApiClient;
let reception: ApiClient;
let doctor: ApiClient;
const record: Record<string, unknown> = {};

beforeAll(async () => {
  admin = await loginAs('admin@hqms.test');
  reception = await loginAs('reception@hqms.test');
  doctor = await loginAs(doctorEmail(DOCTOR));
}, 120_000);

afterAll(async () => {
  recordResult('t3SseFreshness', record, T3_RESULTS_FILE);
  await closePool();
});

const dbVersion = async (sessionId: string): Promise<number> =>
  Number((await sqlRows(`SELECT queue_version::int AS v FROM sessions WHERE id = $1`, [sessionId]))[0]?.['v']);

describe('T3 live updates: reconnect and freshness', () => {
  it('a (re)connecting client gets the committed version and the matching snapshot, including commits it missed', async () => {
    const session = await makeRunningSession(admin, {
      doctor: DOCTOR,
      startOffsetMin: -30,
      walkin: 10,
      label: 'morning',
    });
    await openSession(reception, session.id);
    const patients = await registerPatients(reception, 4, 'T3 Reconnect');
    await admitWalkIns(reception, session.id, patients.slice(0, 2));
    const cookie = doctor.cookie;

    const first = await SseClient.connect(apiUrl(), `/sessions/${session.id}/events`, cookie);
    await first.reached(0);
    const v1 = await dbVersion(session.id);
    await first.reached(v1);
    const snap1 = await doctor.get(`/sessions/${session.id}/queue`);
    expect(first.notices[0]?.notice.eventType).toBe('connected');
    expect(snap1.body.queueVersion).toBe(v1);
    expect(first.maxVersion).toBe(v1);
    await first.close();

    // Two commits while the client is away.
    const call = await doctor.post(`/sessions/${session.id}/call-next`, {});
    expect(call.status).toBe(200);
    await admitWalkIns(reception, session.id, patients.slice(2, 3));
    const vMissed = await dbVersion(session.id);
    expect(vMissed).toBeGreaterThan(v1);

    const second = await SseClient.connect(apiUrl(), `/sessions/${session.id}/events`, cookie);
    await second.reached(vMissed);
    const snap2 = await doctor.get(`/sessions/${session.id}/queue`);
    expect(second.notices[0]?.notice.queueVersion, 'first notice after reconnect is the committed version').toBe(
      vMissed,
    );
    expect(second.notices[0]?.notice.eventType).toBe('connected');
    expect(snap2.body.queueVersion).toBe(vMissed);
    expect(snap2.body.active.token).toBe(call.body.entry.token);
    expect(snap2.body.waiting.map((e: { token: string }) => e.token)).toEqual(['W-002', 'W-003']);
    await second.close();

    await doctor.post(`/visits/${call.body.entry.visitId}/start`, {});
    await doctor.post(`/visits/${call.body.entry.visitId}/complete`, {});
    record['reconnect'] = {
      versionBeforeDisconnect: v1,
      versionAfterMissedCommits: vMissed,
      firstNoticeAfterReconnect: second.notices[0]?.notice,
      snapshotVersionMatches: true,
      snapshotActiveToken: snap2.body.active.token,
    };
  }, 60_000);

  it(`${CLIENTS} SSE clients, ${CYCLES} cycles of call-next, start, complete: commit-to-client latency`, async () => {
    const session = await makeRunningSession(admin, {
      doctor: DOCTOR,
      startOffsetMin: -45,
      walkin: 40,
      label: 'afternoon',
    });
    await openSession(reception, session.id);
    const patients = await registerPatients(reception, CYCLES + 2, 'T3 Fresh');
    await admitWalkIns(reception, session.id, patients);

    const clients = await Promise.all(
      Array.from({ length: CLIENTS }, () =>
        SseClient.connect(apiUrl(), `/sessions/${session.id}/events`, doctor.cookie),
      ),
    );
    const v0 = await dbVersion(session.id);
    await Promise.all(clients.map((c) => c.reached(v0)));

    const fromResponse: number[] = []; // client notice arrival minus the moment the command's response reached the test (commit is before the response)
    const fromRequest: number[] = []; // client notice arrival minus the moment the command was sent (includes the command's own processing)
    const perKind: Record<string, number[]> = { 'call-next': [], start: [], complete: [] };
    let negative = 0;
    const commitsMeasured: Array<{ kind: string; version: number; p50: number; max: number }> = [];

    const measure = async (
      kind: string,
      send: () => Promise<{ status: number; body: any }>,
      versionOf: (b: any) => number,
    ): Promise<void> => {
      // Random phase against the server's 500 ms poll: sending right after a notice would lock every commit just after a tick (worst case).
      await new Promise((r) => setTimeout(r, Math.random() * 600));
      const sent = performance.now();
      const res = await send();
      const received = performance.now();
      expect(res.status, `${kind}: ${JSON.stringify(res.body)}`).toBe(200);
      const version = versionOf(res.body);
      const arrivals = await Promise.all(clients.map((c) => c.reached(version)));
      const lat = arrivals.map((a) => a - received);
      negative += lat.filter((l) => l < 0).length;
      for (const a of arrivals) {
        fromResponse.push(Math.max(0, a - received));
        fromRequest.push(a - sent);
        (perKind[kind] as number[]).push(Math.max(0, a - received));
      }
      commitsMeasured.push({
        kind,
        version,
        p50: round1(
          percentile(
            lat.map((l) => Math.max(0, l)),
            50,
          ),
        ),
        max: round1(Math.max(...lat)),
      });
    };

    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      let entry: { visitId: string } | undefined;
      await measure(
        'call-next',
        async () => {
          const r = await doctor.post(`/sessions/${session.id}/call-next`, {});
          entry = r.body.entry;
          return r;
        },
        (b) => b.decision.queueVersion,
      );
      await measure(
        'start',
        () => doctor.post(`/visits/${entry?.visitId}/start`, {}),
        (b) => b.queueVersion,
      );
      await measure(
        'complete',
        () => doctor.post(`/visits/${entry?.visitId}/complete`, {}),
        (b) => b.queueVersion,
      );
    }

    const finalVersion = await dbVersion(session.id);
    const snapshot = await doctor.get(`/sessions/${session.id}/queue`);
    expect(snapshot.body.queueVersion).toBe(finalVersion);
    for (const c of clients) expect(c.maxVersion, 'every client converged on the final version').toBe(finalVersion);
    const pingsSeen = clients.reduce((n, c) => n + c.pings, 0);
    await Promise.all(clients.map((c) => c.close()));

    const stats = (xs: number[]) => ({
      n: xs.length,
      p50: round1(percentile(xs, 50)),
      p95: round1(percentile(xs, 95)),
      p99: round1(percentile(xs, 99)),
      max: round1(Math.max(...xs)),
    });
    record['freshness'] = {
      clients: CLIENTS,
      cycles: CYCLES,
      commits: CYCLES * 3,
      samples: fromResponse.length,
      ssePollMs: 500,
      note: 'Measured on one machine, clients in the test process, server poll 500 ms. Not the 200-client target and not the hosted environment.',
      commitToClientMsFromResponse: stats(fromResponse),
      sinceRequestSentMs: stats(fromRequest),
      byCommand: Object.fromEntries(Object.entries(perKind).map(([k, v]) => [k, stats(v)])),
      noticesArrivingBeforeTheResponse: negative,
      allClientsConvergedOnFinalVersion: true,
      finalVersion,
      pingEventsSeen: pingsSeen,
      worstCommitMsAcrossClients: Math.max(...commitsMeasured.map((c) => c.max)),
    };
    // The NFR-02 objective is 2 s at p95; this quick run is evidence, so the gate only catches gross regressions.
    expect(percentile(fromResponse, 95)).toBeLessThan(2000);
  }, 180_000);
});
