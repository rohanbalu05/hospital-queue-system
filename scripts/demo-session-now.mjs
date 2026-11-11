#!/usr/bin/env node
/**
 * Demo helper: make sure Dr. Suresh Hegde (doctor@hqms.test) has an OPEN session running right now.
 *
 * The seed creates today's sessions at 09:00-13:00 and 14:00-18:00 IST. When you demo or test outside those
 * hours (late at night, early morning), nothing is bookable or callable. This script waits for the API, logs in
 * as admin and creates + opens an "evening" session that started 5 minutes ago and runs for 3 hours. Inside the
 * seeded hours it does nothing. Uses the real API (same route the admin screen uses); no database shortcuts.
 *
 * Usage: node scripts/demo-session-now.mjs [--force]      (API_URL defaults to http://localhost:3000)
 */
import { createHash } from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:3000';
const FORCE = process.argv.includes('--force');

function stableId(name) {
  // Same derivation as db/seed/seed.ts so we address the seeded doctor without a database query.
  const b = createHash('sha1').update(`hqms-seed:${name}`).digest().subarray(0, 16);
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x50, 6);
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8);
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const ist = (d, opts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', ...opts }).format(d);
const istDate = (d) => ist(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
const istMinutes = (d) => {
  const [h, m] = ist(d, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).split(':').map(Number);
  return h * 60 + m;
};

async function waitForApi() {
  for (let i = 0; i < 180; i++) {
    try {
      const res = await fetch(`${API}/health`);
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`API at ${API} did not come up within 3 minutes`);
}

async function main() {
  const now = new Date();
  const mins = istMinutes(now);
  const insideSeeded = (mins >= 9 * 60 && mins < 12 * 60 + 30) || (mins >= 14 * 60 && mins < 17 * 60 + 30);
  if (insideSeeded && !FORCE) {
    console.log('[demo-session] Inside seeded session hours: using the seeded morning/afternoon sessions.');
    return;
  }

  await waitForApi();
  const login = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@hqms.test', password: 'demo1234' }),
  });
  if (login.status !== 200) throw new Error(`admin login failed: ${login.status} ${await login.text()}`);
  const cookie = login.headers
    .getSetCookie()
    .find((c) => c.startsWith('hqms_session='))
    ?.split(';')[0];
  if (!cookie) throw new Error('admin login returned no session cookie');

  const post = async (path, body) => {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* empty body */
    }
    return { status: res.status, body: json };
  };

  const startMs = Math.floor((now.getTime() - 5 * 60_000) / 60_000) * 60_000;
  const created = await post('/sessions', {
    doctorId: stableId('doctor:1'),
    sessionDate: istDate(new Date(startMs)),
    label: 'evening',
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(startMs + 3 * 3_600_000).toISOString(),
    bookedCapacity: 10,
    walkinCapacity: 5,
  });
  if (created.status !== 201) {
    console.log(`[demo-session] Could not create a session now (${created.status}): ${JSON.stringify(created.body)}`);
    console.log('[demo-session] If it is just before midnight, wait until 00:05 and run: node scripts/demo-session-now.mjs');
    return;
  }
  const opened = await post(`/sessions/${created.body.id}/open`, {});
  if (opened.status !== 200) {
    console.log(`[demo-session] Created but could not open (${opened.status}): ${JSON.stringify(opened.body)}`);
    return;
  }
  const t = (ms) => ist(new Date(ms), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  console.log(
    `[demo-session] OPEN: Dr. Suresh Hegde, "Evening" session ${t(startMs)}-${t(startMs + 3 * 3_600_000)} IST. ` +
      'Pick this session on the reception desk and doctor console.',
  );
}

main().catch((err) => {
  console.error(`[demo-session] ${err.message}`);
  process.exitCode = 1;
});
