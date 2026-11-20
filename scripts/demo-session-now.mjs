#!/usr/bin/env node
/**
 * Demo helper: at ANY time of day make sure Dr. Suresh Hegde (doctor@hqms.test) has a RUNNING (open) session.
 *
 * The seed creates today's sessions at 09:00-13:00 and 14:00-18:00 IST. This script (via the real API, logged in as
 * admin; no database shortcuts) decides what to do with `decide(now, sessions)`:
 *   a. a session covers now with >= 45 min left: open it if `scheduled`; if it is open, do nothing; if it is
 *      paused / unavailable / closed, leave it alone and just report it;
 *   b. else a session starts within the next 30 min: open it early;
 *   c. else create one from now - 5 min (floored to 5 min) for up to 3 h, never running into the doctor's next session
 *      (at least 60 min; if that does not fit, open the next session instead), labelled by time of day, then open it.
 * Running it twice creates nothing new.
 *
 * Usage: node scripts/demo-session-now.mjs      (API_URL defaults to http://localhost:3000)
 */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MIN = 60_000;
const IST_OFFSET_MS = 330 * MIN; // Asia/Kolkata has no DST

/** Same rule as `sessionLabelFor` in packages/contracts/src/scheduling.ts (duplicated: this file runs with plain node). */
export function sessionLabelFor(startsAt) {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).format(new Date(startsAt)),
  );
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

/** IST calendar date (YYYY-MM-DD) of an instant. */
export function istDate(d) {
  return new Date(new Date(d).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

const hhmm = (d) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(d));

/**
 * Pure decision. `sessions` = this doctor's sessions around now ({id, status, label, startsAt, endsAt}).
 * Returns one of:
 *   { type: 'use', session, open: boolean }  covering session (open it when open=true, else report only)
 *   { type: 'open-early', session }          starts within 30 min
 *   { type: 'open-next', session }           no room to create one before the next session starts
 *   { type: 'create', startsAt, endsAt, label, sessionDate }
 */
export function decide(now, sessions) {
  const t = new Date(now).getTime();
  const list = sessions
    .map((s) => ({ ...s, s0: new Date(s.startsAt).getTime(), s1: new Date(s.endsAt).getTime() }))
    .sort((a, b) => a.s0 - b.s0);

  const covering = list.find((s) => s.s0 <= t && t < s.s1 && s.s1 - t >= 45 * MIN);
  if (covering) return { type: 'use', session: covering, open: covering.status === 'scheduled' };

  const soon = list.find((s) => s.s0 > t && s.s0 - t <= 30 * MIN && s.status === 'scheduled');
  if (soon) return { type: 'open-early', session: soon };

  const start = Math.floor((t - 5 * MIN) / (5 * MIN)) * 5 * MIN;
  const next = list.find((s) => s.s0 > start && s.status !== 'closed');
  let end = start + 3 * 3_600_000;
  if (next) end = Math.min(end, next.s0);
  if (end - start < 60 * MIN) {
    if (next && next.status === 'scheduled') return { type: 'open-next', session: next };
    end = start + 60 * MIN; // nothing to open instead: accept the overlap
  }
  return {
    type: 'create',
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    label: sessionLabelFor(new Date(start)),
    sessionDate: istDate(new Date(start)), // a session crossing midnight belongs to the IST date it starts on
  };
}

// The seed creates 09:00-13:00 and 14:00-18:00 IST sessions; anything else was created by this script earlier.
const isSeeded = (s) => ['09:00', '14:00'].includes(hhmm(s.startsAt));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const describe = (s) => `${cap(s.label)} session ${hhmm(s.startsAt)}-${hhmm(s.endsAt)} IST`;

function stableId(name) {
  // Same derivation as db/seed/seed.ts so we address the seeded doctor without a database query.
  const b = createHash('sha1').update(`hqms-seed:${name}`).digest().subarray(0, 16);
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x50, 6);
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8);
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function main() {
  const API = process.env.API_URL ?? 'http://localhost:3000';
  const DOCTOR = stableId('doctor:1');
  const who = 'Dr. Suresh Hegde';

  for (let i = 0; ; i++) {
    try {
      const res = await fetch(`${API}/health`);
      if (res.status < 500) break;
    } catch {
      /* not up yet */
    }
    if (i >= 180) throw new Error(`API at ${API} did not come up within 3 minutes`);
    await new Promise((r) => setTimeout(r, 1000));
  }

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

  const call = async (method, path, body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'Idempotency-Key': crypto.randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* empty body */
    }
    return { status: res.status, body: json };
  };
  const open = async (s) => call('POST', `/sessions/${s.id}/open`, {});

  const now = new Date();
  // Yesterday's date too: a night session that started before midnight is still running after it.
  const from = istDate(new Date(now.getTime() - 24 * 3_600_000));
  const to = istDate(new Date(now.getTime() + 24 * 3_600_000));
  const listed = await call('GET', `/sessions?from=${from}&to=${to}&doctorId=${DOCTOR}`);
  if (listed.status !== 200) throw new Error(`could not list sessions: ${listed.status} ${JSON.stringify(listed.body)}`);

  const action = decide(now, listed.body);
  const run = async (s, tag) => {
    if (s.status === 'scheduled') {
      const r = await open(s);
      if (r.status !== 200) {
        console.log(`[demo-session] Could not open ${describe(s)} (${r.status}): ${JSON.stringify(r.body)}`);
        return;
      }
    }
    console.log(`[demo-session] OPEN: ${who}, ${describe(s)} (${tag})`);
  };

  if (action.type === 'use') {
    if (action.open || action.session.status === 'open') return run(action.session, isSeeded(action.session) ? 'seeded' : 'existing');
    console.log(
      `[demo-session] ${who}, ${describe(action.session)} is ${action.session.status}; left as is (resume or reopen it from the doctor console / admin).`,
    );
    return;
  }
  if (action.type === 'open-early' || action.type === 'open-next') {
    if (action.type === 'open-next') console.log('[demo-session] The next session starts soon; opening it instead of creating one.');
    return run(action.session, 'seeded, opened early');
  }

  const created = await call('POST', '/sessions', {
    doctorId: DOCTOR,
    sessionDate: action.sessionDate,
    label: action.label,
    startsAt: action.startsAt,
    endsAt: action.endsAt,
    bookedCapacity: 10,
    walkinCapacity: 5,
  });
  if (created.status !== 201) {
    console.log(`[demo-session] Could not create a session now (${created.status}): ${JSON.stringify(created.body)}`);
    return;
  }
  const opened = await open(created.body);
  if (opened.status !== 200) {
    console.log(`[demo-session] Created but could not open (${opened.status}): ${JSON.stringify(opened.body)}`);
    return;
  }
  console.log(`[demo-session] OPEN: ${who}, ${describe(action)} (created now)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[demo-session] ${err.message}`);
    process.exitCode = 1;
  });
}
