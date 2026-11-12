/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ArrivalResult, QueueVersionNotice } from '@hqms/contracts';
import { LiveService } from '../src/live/live.service.js';
import {
  type Client,
  type MadeSession,
  type TestApp,
  at,
  createTestApp,
  doctorId,
  loginAs,
  makeSession,
  patientId,
} from './helpers.js';

let t: TestApp;
let port: number;
let admin: Client;
let reception: Client;
let doctor: Client; // doctor 10
let doctor1: Client;
let patient1: Client;
let patient3: Client;
const open: SseClient[] = [];

interface SseEvent {
  event: string;
  data: string;
}

interface SseClient {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  events: SseEvent[];
  waitFor(pred: (e: SseEvent) => boolean, ms?: number): Promise<SseEvent>;
  close(): void;
}

/** A minimal SSE reader over a real socket. Resolves once the response headers arrive. */
function connect(path: string, cookie?: string): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers: cookie ? { Cookie: cookie } : {} }, (res) => {
      const events: SseEvent[] = [];
      const waiters: Array<{ pred: (e: SseEvent) => boolean; ok: (e: SseEvent) => void }> = [];
      let body = '';
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (block.startsWith('retry:') || (!block.includes('event:') && !block.includes('data:'))) continue;
          const e = { event, data };
          events.push(e);
          for (const w of [...waiters]) {
            if (w.pred(e)) {
              waiters.splice(waiters.indexOf(w), 1);
              w.ok(e);
            }
          }
        }
      });
      const client: SseClient = {
        status: res.statusCode ?? 0,
        headers: res.headers,
        get body() {
          return body;
        },
        events,
        waitFor(pred, ms = 2000) {
          const seen = events.find(pred);
          if (seen) return Promise.resolve(seen);
          return new Promise((ok, fail) => {
            const timer = setTimeout(() => fail(new Error(`no matching SSE event within ${ms} ms; got ${JSON.stringify(events)}`)), ms);
            waiters.push({
              pred,
              ok: (e) => {
                clearTimeout(timer);
                ok(e);
              },
            });
          });
        },
        close: () => req.destroy(),
      } as SseClient;
      open.push(client);
      if (client.status !== 200) {
        res.on('end', () => resolve(client));
        res.resume();
        return;
      }
      resolve(client);
    });
    req.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
    });
  });
}

const notice = (e: SseEvent): QueueVersionNotice => QueueVersionNotice.parse(JSON.parse(e.data));

beforeAll(async () => {
  process.env['SSE_PING_MS'] = '200';
  process.env['SSE_POLL_MS'] = '200';
  t = await createTestApp();
  await t.app.listen(0, '127.0.0.1');
  port = (t.app.getHttpServer().address() as AddressInfo).port;
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  doctor = await loginAs(t.server, 'doctor10@hqms.test');
  doctor1 = await loginAs(t.server, 'doctor@hqms.test');
  patient1 = await loginAs(t.server, 'patient@hqms.test');
  patient3 = await loginAs(t.server, 'patient3@hqms.test');
});
afterAll(async () => {
  for (const c of open) c.close();
  await t.close();
  delete process.env['SSE_PING_MS'];
  delete process.env['SSE_POLL_MS'];
});
beforeEach(async () => {
  t.clock.reset();
  await t.pool.query(
    `UPDATE queue_entries SET state = 'skipped', skipped_at = now() WHERE doctor_id = $1 AND state IN ('called','in_service')`,
    [doctorId(10)],
  );
});

async function session(): Promise<MadeSession> {
  return makeSession(admin, { doctor: 10 });
}

async function walkIn(s: MadeSession, p: number, minute: number): Promise<ArrivalResult> {
  t.clock.set(at(s, minute));
  const res = await reception.post(`/sessions/${s.id}/walk-ins`, { patientId: patientId(p) });
  expect(res.status).toBe(201);
  return ArrivalResult.parse(res.body);
}

describe('FR-09 SSE: version notices, snapshot recovery', () => {
  it('connect gets the current version at once; a call-next produces a queue event with the new version within 2 s', async () => {
    const s = await session();
    await walkIn(s, 1, 0);
    const current = (await t.pool.query(`SELECT queue_version FROM sessions WHERE id = $1`, [s.id])).rows[0]!.queue_version as number;

    const sse = await connect(`/sessions/${s.id}/events`, doctor.cookie);
    expect(sse.status).toBe(200);
    expect(sse.headers['content-type']).toMatch(/text\/event-stream/);
    expect(sse.headers['x-accel-buffering']).toBe('no');
    expect(sse.headers['cache-control']).toMatch(/no-cache/);
    expect(sse.headers['content-encoding']).toBeUndefined();

    const first = notice(await sse.waitFor((e) => e.event === 'queue'));
    expect(first).toMatchObject({ sessionId: s.id, queueVersion: current, eventType: 'connected' });

    t.clock.set(at(s, 5));
    const started = Date.now();
    const call = await doctor.post(`/sessions/${s.id}/call-next`, {});
    expect(call.status).toBe(200);
    const next = notice(await sse.waitFor((e) => e.event === 'queue' && notice(e).queueVersion > current, 2000));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(next.queueVersion).toBe(call.body.decision.queueVersion);
    expect(next.sessionId).toBe(s.id);
    expect(next.eventType).toBe('QueuePatientCalled');
    // Minimal routing data only: no names, tokens, ids of patients.
    expect(Object.keys(JSON.parse(sse.events.filter((e) => e.event === 'queue').at(-1)!.data) as object).sort()).toEqual([
      'committedAt',
      'eventType',
      'queueVersion',
      'sessionId',
    ]);
    sse.close();
  });

  it('a reconnecting client is told the current version immediately (then refetches the snapshot)', async () => {
    const s = await session();
    await walkIn(s, 2, 0);
    t.clock.set(at(s, 3));
    const call = await doctor.post(`/sessions/${s.id}/call-next`, {});
    const version = call.body.decision.queueVersion as number;
    const sse = await connect(`/sessions/${s.id}/events`, doctor.cookie);
    const e = notice(await sse.waitFor((x) => x.event === 'queue', 1000));
    expect(e.queueVersion).toBe(version);
    sse.close();
  });

  it('sends event: ping heartbeats', async () => {
    const s = await session();
    const sse = await connect(`/sessions/${s.id}/events`, doctor.cookie);
    await sse.waitFor((e) => e.event === 'ping', 1500);
    sse.close();
  });

  it('every command that changes the queue moves the version stream (pause, resume)', async () => {
    const s = await session();
    t.clock.set(at(s, 1));
    expect((await doctor.post(`/sessions/${s.id}/open`, {})).status).toBe(200);
    const sse = await connect(`/sessions/${s.id}/events`, doctor.cookie);
    const base = notice(await sse.waitFor((e) => e.event === 'queue')).queueVersion;
    expect((await doctor.post(`/sessions/${s.id}/pause`, {})).status).toBe(200);
    const paused = notice(await sse.waitFor((e) => e.event === 'queue' && notice(e).queueVersion > base));
    expect(paused.eventType).toBe('SessionPaused');
    sse.close();
  });

  it('scope: unauthenticated 401, a patient without an entry 404, a doctor of someone else 403, a patient with an entry is allowed', async () => {
    const s = await session();
    await walkIn(s, 1, 0); // patient1 (login patient@)
    const anon = await connect(`/sessions/${s.id}/events`);
    expect(anon.status).toBe(401);
    expect((await connect(`/sessions/${s.id}/events`, patient3.cookie)).status).toBe(404);
    expect((await connect(`/sessions/${s.id}/events`, doctor1.cookie)).status).toBe(403);
    const mine = await connect(`/sessions/${s.id}/events`, patient1.cookie);
    expect(mine.status).toBe(200);
    expect(notice(await mine.waitFor((e) => e.event === 'queue')).sessionId).toBe(s.id);
    mine.close();
  });

  it('the public display stream needs no cookie and announces today\'s open sessions; closing clients are cleaned up', async () => {
    const s = await session();
    await walkIn(s, 3, 0);
    t.clock.set(at(s, 4));
    expect((await doctor.post(`/sessions/${s.id}/open`, {})).status).toBe(200);
    const live = t.app.get(LiveService);
    const before = live.subscriberCount();

    const sse = await connect('/display/events');
    expect(sse.status).toBe(200);
    const hello = notice(await sse.waitFor((e) => e.event === 'queue' && notice(e).sessionId === s.id));
    expect(hello.eventType).toBe('connected');
    expect(live.subscriberCount()).toBe(before + 1);

    const call = await doctor.post(`/sessions/${s.id}/call-next`, {});
    expect(call.status).toBe(200);
    const changed = notice(await sse.waitFor((e) => e.event === 'queue' && notice(e).queueVersion === call.body.decision.queueVersion));
    expect(changed.sessionId).toBe(s.id);
    // No personal data on the public stream.
    expect(sse.body).not.toMatch(/Ramesh|Sunita|Manjunath|patientId/);

    sse.close();
    const deadline = Date.now() + 2000;
    while (live.subscriberCount() > before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(live.subscriberCount()).toBe(before);
  });
});
