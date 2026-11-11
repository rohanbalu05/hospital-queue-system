/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, DisplaySnapshot } from '@hqms/contracts';
import { LiveService } from '../src/live/live.service.js';
import { countPdfPages } from '../src/documents/upload.js';
import {
  type TestApp,
  at,
  count,
  createTestApp,
  loginAs,
  makeSession,
  newLoginPatient,
  patientId,
} from './helpers.js';
import { MemoryStorage, makePdf, makePng } from './fakes.js';

/** Each describe runs its own application with its own limits (the config is read when the app is built). */
const apps: TestApp[] = [];
const streams: Sse[] = [];
let sandbox: { t: TestApp; port: number } | null = null;

async function appWith(env: Record<string, string>, opts: Parameters<typeof createTestApp>[0] = {}): Promise<{ t: TestApp; port: number }> {
  const old: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    old[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const t = await createTestApp(opts);
    await t.app.listen(0, '127.0.0.1');
    apps.push(t);
    sandbox = { t, port: (t.app.getHttpServer().address() as AddressInfo).port };
    return sandbox;
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  }
}

afterEach(async () => {
  for (const s of streams.splice(0)) s.close();
  for (const a of apps.splice(0)) await a.close();
});

interface Sse {
  status: number;
  headers: http.IncomingHttpHeaders;
  readonly body: string;
  readonly closed: boolean;
  close(): void;
  whenClosed(ms?: number): Promise<void>;
  events(): Array<{ event: string; data: string }>;
}

function connect(port: number, path: string, cookie?: string): Promise<Sse> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers: cookie ? { Cookie: cookie } : {} }, (res) => {
      let body = '';
      let closed = false;
      const closers: Array<() => void> = [];
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        body += c;
      });
      res.on('close', () => {
        closed = true;
        for (const c of closers) c();
      });
      const sse: Sse = {
        status: res.statusCode ?? 0,
        headers: res.headers,
        get body() {
          return body;
        },
        get closed() {
          return closed;
        },
        close: () => req.destroy(),
        whenClosed: (ms = 3000) =>
          new Promise((ok, fail) => {
            if (closed) return ok();
            const timer = setTimeout(() => fail(new Error(`stream still open after ${ms} ms`)), ms);
            closers.push(() => {
              clearTimeout(timer);
              ok();
            });
          }),
        events: () =>
          body
            .split('\n\n')
            .map((block) => {
              let event = 'message';
              let data = '';
              for (const line of block.split('\n')) {
                if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) data += line.slice(5).trim();
              }
              return { event, data };
            })
            .filter((e) => e.data !== '' || e.event !== 'message'),
      };
      streams.push(sse);
      if (sse.status !== 200) {
        res.on('end', () => resolve(sse));
        res.resume();
        return;
      }
      resolve(sse);
    });
    req.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
    });
  });
}

const until = async (pred: () => boolean | Promise<boolean>, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
};

async function staffStream(t: TestApp, port: number, doctorLogin = 'doctor10@hqms.test'): Promise<{ path: string; cookie: string }> {
  const admin = await loginAs(t.server, 'admin@hqms.test');
  const s = await makeSession(admin, { doctor: 10 });
  const doctor = await loginAs(t.server, doctorLogin);
  void port;
  return { path: `/sessions/${s.id}/events`, cookie: doctor.cookie };
}

describe('SSE connection limits are checked BEFORE the stream starts', () => {
  it('separate caps for the public display and authenticated streams; a refusal is a 503 ApiError, not a stream; slots are released', async () => {
    const { t, port } = await appWith({ SSE_MAX_DISPLAY: '1', SSE_MAX_AUTHENTICATED: '1', SSE_MAX_PER_IP: '50', SSE_POLL_MS: '100', SSE_PING_MS: '200' });
    const staff = await staffStream(t, port);

    const d1 = await connect(port, '/display/events');
    expect(d1.status).toBe(200);
    const a1 = await connect(port, staff.path, staff.cookie); // the display slot does not use up the authenticated one
    expect(a1.status).toBe(200);

    const d2 = await connect(port, '/display/events');
    expect(d2.status).toBe(503);
    expect(d2.headers['content-type']).toMatch(/application\/json/);
    expect(d2.headers['content-type']).not.toMatch(/event-stream/);
    expect(ApiError.parse(JSON.parse(d2.body)).error.code).toBe('INTERNAL');
    const a2 = await connect(port, staff.path, staff.cookie);
    expect(a2.status).toBe(503);
    expect(a2.headers['content-type']).toMatch(/application\/json/);

    // Closing a client frees its slot.
    d1.close();
    await until(async () => (await connect(port, '/display/events')).status === 200);
    a1.close();
    await until(async () => (await connect(port, staff.path, staff.cookie)).status === 200);
  });

  it('a per-address cap applies across both kinds of stream', async () => {
    const { t, port } = await appWith({ SSE_MAX_PER_IP: '2', SSE_POLL_MS: '100' });
    const staff = await staffStream(t, port);
    expect((await connect(port, '/display/events')).status).toBe(200);
    expect((await connect(port, staff.path, staff.cookie)).status).toBe(200);
    const third = await connect(port, '/display/events');
    expect(third.status).toBe(503);
    expect(third.headers['content-type']).toMatch(/application\/json/);
    // a refused request for a missing session still releases nothing it did not take
    const live = t.app.get(LiveService);
    expect(live.subscriberCount()).toBe(2);
  });

  it('a stream ends after the maximum lifetime (the client reconnects and is authenticated again)', async () => {
    const { port } = await appWith({ SSE_MAX_LIFETIME_SEC: '1', SSE_PING_MS: '200', SSE_POLL_MS: '100' });
    const d = await connect(port, '/display/events');
    expect(d.status).toBe(200);
    await d.whenClosed(4000);
    expect(d.events().some((e) => e.event === 'end' && /max_lifetime/.test(e.data))).toBe(true);
  });

  it('a client whose socket buffer exceeds the limit is dropped', async () => {
    const { t, port } = await appWith({ SSE_MAX_BUFFERED_BYTES: '1', SSE_PING_MS: '200', SSE_POLL_MS: '100' });
    const d = await connect(port, '/display/events');
    await d.whenClosed(3000);
    const live = t.app.get(LiveService);
    await until(() => live.subscriberCount() === 0);
  });

  it('the shared poller skips a tick while one is still in flight', async () => {
    const { t, port } = await appWith({ SSE_POLL_MS: '50', SSE_PING_MS: '5000' });
    const d = await connect(port, '/display/events');
    expect(d.status).toBe(200);
    const live = t.app.get(LiveService) as unknown as { tick: () => Promise<void> };
    let running = 0;
    let maxRunning = 0;
    let calls = 0;
    live.tick = async () => {
      calls += 1;
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 150));
      running -= 1;
    };
    await new Promise((r) => setTimeout(r, 700));
    expect(maxRunning).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(6); // 700 ms / 150 ms per tick, not 700 / 50
  });
});

describe('patient and display streams carry only a generic queue.changed notice; staff streams keep the event name', () => {
  it('a pause is SessionPaused for the doctor, queue.changed for the patient and the public display', async () => {
    const { t, port } = await appWith({ SSE_POLL_MS: '100', SSE_PING_MS: '5000' });
    const admin = await loginAs(t.server, 'admin@hqms.test');
    const reception = await loginAs(t.server, 'reception@hqms.test');
    const doctor = await loginAs(t.server, 'doctor10@hqms.test');
    const patient1 = await loginAs(t.server, 'patient@hqms.test');
    const s = await makeSession(admin, { doctor: 10 });
    t.clock.set(at(s, 0));
    expect((await reception.post(`/sessions/${s.id}/walk-ins`, { patientId: patientId(1) })).status).toBe(201);
    t.clock.set(at(s, 1));
    expect((await doctor.post(`/sessions/${s.id}/open`, {})).status).toBe(200);

    const staff = await connect(port, `/sessions/${s.id}/events`, doctor.cookie);
    const mine = await connect(port, `/sessions/${s.id}/events`, patient1.cookie);
    const display = await connect(port, '/display/events');
    expect([staff.status, mine.status, display.status]).toEqual([200, 200, 200]);
    await until(() => [staff, mine].every((c) => c.events().some((e) => e.event === 'queue')));
    await until(() => display.events().some((e) => e.event === 'queue' && JSON.parse(e.data).sessionId === s.id));

    expect((await doctor.post(`/sessions/${s.id}/pause`, {})).status).toBe(200);
    await until(() => staff.events().some((e) => /SessionPaused/.test(e.data)));
    const types = (c: Sse) => c.events().filter((e) => e.event === 'queue').map((e) => JSON.parse(e.data).eventType as string);
    await until(() => types(mine).length >= 2 && types(display).length >= 2);
    expect(types(mine).slice(1)).toEqual(['queue.changed']);
    expect(types(display).filter((x) => x !== 'connected')).toEqual(['queue.changed']);
    expect(mine.body + display.body).not.toMatch(/Paused|Priority|Called|Skipped/);
  });
});

describe('public GET /display/sessions: time window, today only, cache and rate limit', () => {
  async function displaySessions(t: TestApp, qs = ''): Promise<DisplaySnapshot> {
    const res = await (await import('supertest')).default(t.server).get(`/display/sessions${qs}`);
    expect(res.status).toBe(200);
    return DisplaySnapshot.parse(res.body);
  }

  it('only sessions whose window covers now (start - 30 min .. end + 60 min), or that still have waiting patients, are listed; ?date is ignored', async () => {
    const { t } = await appWith({});
    const admin = await loginAs(t.server, 'admin@hqms.test');
    const reception = await loginAs(t.server, 'reception@hqms.test');
    const doctor = await loginAs(t.server, 'doctor10@hqms.test');
    await t.pool.query(`UPDATE queue_entries SET state = 'skipped', skipped_at = now() WHERE doctor_id IN (SELECT id FROM doctors) AND state IN ('called','in_service')`);
    const s = await makeSession(admin, { doctor: 10 });
    t.clock.set(at(s, 1));
    expect((await doctor.post(`/sessions/${s.id}/open`, {})).status).toBe(200);
    const listed = async (minute: number): Promise<boolean> => {
      t.clock.set(at(s, minute));
      return (await displaySessions(t)).columns.some((c) => c.sessionId === s.id);
    };
    expect(await listed(-31)).toBe(false); // before the window opens (08:29)
    expect(await listed(-29)).toBe(true);
    expect(await listed(120)).toBe(true);
    expect(await listed(299)).toBe(true); // 13:59, an hour after the end
    expect(await listed(301)).toBe(false); // 14:01
    // somebody still waiting keeps the session on the screen
    t.clock.set(at(s, 2));
    expect((await reception.post(`/sessions/${s.id}/walk-ins`, { patientId: patientId(2) })).status).toBe(201);
    expect(await listed(330)).toBe(true);
    // the date parameter cannot be used to browse other days
    t.clock.set(at(s, 120));
    expect(await displaySessions(t, '?date=2020-01-01')).toMatchObject({ columns: (await displaySessions(t)).columns });

    // at the real time, whatever is shown (seeded open sessions included) is in its window or has people waiting
    t.clock.reset();
    const shown = (await displaySessions(t)).columns.map((c) => c.sessionId);
    if (shown.length > 0) {
      const bad = await t.pool.query(
        `SELECT s.id FROM sessions s
          WHERE s.id = ANY($1::uuid[])
            AND NOT ((s.starts_at - interval '30 minutes' <= now() AND now() <= s.ends_at + interval '60 minutes')
                     OR EXISTS (SELECT 1 FROM queue_entries qe WHERE qe.session_id = s.id AND qe.state IN ('waiting','called')))`,
        [shown],
      );
      expect(bad.rows).toEqual([]);
    }
    expect(shown).not.toContain(s.id); // a 2040s session is nowhere near "now"
  });

  it('answers from a shared 1-second cache, then recomputes', async () => {
    const { t } = await appWith({ DISPLAY_CACHE_MS: '1000' });
    t.clock.set('2041-05-01T05:00:00Z');
    const first = await displaySessions(t);
    t.clock.set('2041-05-01T05:00:30Z');
    const second = await displaySessions(t);
    expect(second.capturedAt).toBe(first.capturedAt); // served from the cache
    await new Promise((r) => setTimeout(r, 1150));
    const third = await displaySessions(t);
    expect(third.capturedAt).not.toBe(first.capturedAt);
  });

  it('a per-address rate limit answers 429 RATE_LIMITED', async () => {
    const { t } = await appWith({ DISPLAY_RATE_LIMIT_PER_MIN: '3' });
    const request = (await import('supertest')).default;
    const codes: number[] = [];
    let body: unknown = null;
    for (let i = 0; i < 5; i += 1) {
      const r = await request(t.server).get('/display/sessions');
      codes.push(r.status);
      if (r.status === 429) body = r.body;
    }
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    expect(ApiError.parse(body).error.code).toBe('RATE_LIMITED');
  });
});

describe('uploads: page counting, per-patient quota, concurrency cap', () => {
  it('countPdfPages: page objects, the page-tree /Count, object streams, and an outline /Count that must not inflate the number', () => {
    expect(countPdfPages(makePdf(3))).toBe(3);
    // object streams hide the page objects; the page tree /Count is used
    const objStm = Buffer.from('%PDF-1.5\n1 0 obj << /Type /ObjStm /N 3 >> stream\nx\nendstream endobj\n2 0 obj << /Type /Pages /Count 12 /Kids [] >> endobj\n%%EOF');
    expect(countPdfPages(objStm)).toBe(12);
    // /Count may come before /Type
    expect(countPdfPages(Buffer.from('%PDF-1.5\n2 0 obj << /Count 7 /Kids [] /Type /Pages >> endobj\n/ObjStm\n'))).toBe(7);
    // object streams and nothing countable: refused (0)
    expect(countPdfPages(Buffer.from('%PDF-1.5\n1 0 obj << /Type /ObjStm /N 3 >> stream\nx\nendstream endobj\n%%EOF'))).toBe(0);
    expect(countPdfPages(Buffer.from('%PDF-1.4\nnothing useful\n%%EOF'))).toBe(0);
    // an outline's /Count is not a page count
    const outlined = Buffer.from(
      `%PDF-1.4\n1 0 obj << /Type /Pages /Count 2 >> endobj\n2 0 obj << /Type /Page >> endobj\n3 0 obj << /Type /Page >> endobj\n${' '.repeat(1000)}9 0 obj << /Type /Outlines /Count 50 >> endobj\n`,
    );
    expect(countPdfPages(outlined)).toBe(2);
    // the maximum of the two: more page objects than the tree admits
    expect(countPdfPages(Buffer.from('1 0 obj << /Type /Pages /Count 1 >>\n/Type /Page\n/Type /Page\n/Type /Page\n'))).toBe(3);
  });

  it('countPdfPages is one linear pass: a large hostile file is counted quickly', () => {
    const chunk = '/Type /Page /Count 3 /Type /Pages /Kids [] ';
    const big = Buffer.from(`%PDF-1.4\n${chunk.repeat(Math.floor((8 * 1024 * 1024) / chunk.length))}`, 'latin1');
    const t0 = Date.now();
    const n = countPdfPages(big);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(n).toBeGreaterThan(10);
  });

  it('an object-stream PDF with no determinable /Count is refused with a 400 over HTTP', async () => {
    const { t } = await appWith({}, { storage: new MemoryStorage() });
    const reception = await loginAs(t.server, 'reception@hqms.test');
    const { client, id } = await newLoginPatient(t, reception, 'Pdf Patient');
    const bad = Buffer.from('%PDF-1.5\n1 0 obj << /Type /ObjStm /N 3 >> stream\nx\nendstream endobj\n%%EOF');
    const res = await client.upload('/documents', bad, { patientId: id }, 'scan.pdf', 'application/pdf');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect((await client.upload('/documents', makePdf(2), { patientId: id }, 'ok.pdf', 'application/pdf')).status).toBe(201);
  });

  it('per-patient quota: 50 documents, then a 409 with a message; and a byte quota (200 MB)', async () => {
    const { t } = await appWith({}, { storage: new MemoryStorage() });
    const reception = await loginAs(t.server, 'reception@hqms.test');
    const many = await newLoginPatient(t, reception, 'Quota Count');
    for (let i = 0; i < 50; i += 1) {
      const r = await many.client.upload('/documents', makePng(32 + i), { patientId: many.id });
      expect(r.status, `upload ${i + 1}`).toBe(201);
    }
    const over = await many.client.upload('/documents', makePng(99), { patientId: many.id });
    expect(over.status).toBe(409);
    expect(ApiError.parse(over.body).error.code).toBe('CONFLICT');
    expect(over.body.error.message).toMatch(/maximum of 50 documents/);
    expect(await count(t.pool, `SELECT 1 FROM documents WHERE patient_id = $1`, [many.id])).toBe(50);

    const big = await newLoginPatient(t, reception, 'Quota Bytes');
    const userId = (await t.pool.query(`SELECT id FROM users WHERE patient_id = $1`, [big.id])).rows[0]!.id as string;
    // a single document is capped at 10 MB by a table constraint, so 20 stored ones of 9.8 MB make 196 MB
    await t.pool.query(
      `INSERT INTO documents (patient_id, uploaded_by, storage_key, original_name, mime_type, size_bytes, page_count, content_hash, status)
       SELECT $1, $2, 'documents/seed/bulk-' || g, 'bulk.png', 'image/png', $3, 1, 'x', 'rejected' FROM generate_series(1, 20) g`,
      [big.id, userId, Math.floor(9.8 * 1024 * 1024)],
    );
    const tooBig = await big.client.upload('/documents', makePng(6 * 1024 * 1024), { patientId: big.id });
    expect(tooBig.status).toBe(409);
    expect(tooBig.body.error.message).toMatch(/200 MB/);
    expect((await big.client.upload('/documents', makePng(1024), { patientId: big.id })).status).toBe(201);
  });

  it('beyond UPLOAD_MAX_CONCURRENT uploads in flight the answer is 503 with Retry-After; the slot frees when the upload ends', async () => {
    const storage = new MemoryStorage();
    const { t } = await appWith({ UPLOAD_MAX_CONCURRENT: '1' }, { storage });
    const reception = await loginAs(t.server, 'reception@hqms.test');
    const a = await newLoginPatient(t, reception, 'Upload A');
    const b = await newLoginPatient(t, reception, 'Upload B');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((ok) => {
      release = ok;
    });
    let holding = false;
    storage.onCall = async () => {
      holding = true;
      await gate;
    };
    const first = a.client.upload('/documents', makePng(), { patientId: a.id }).then((r) => r);
    await until(() => holding);
    const refused = await b.client.upload('/documents', makePng(), { patientId: b.id });
    expect(refused.status).toBe(503);
    expect(refused.headers['retry-after']).toBe('2');
    expect(ApiError.parse(refused.body).error.code).toBe('INTERNAL');
    delete storage.onCall;
    release();
    expect((await first).status).toBe(201);
    expect((await b.client.upload('/documents', makePng(), { patientId: b.id })).status).toBe(201);
  });
});

