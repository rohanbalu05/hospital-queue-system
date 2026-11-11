#!/usr/bin/env node
// Post-deploy smoke check (runbook "Smoke test", rollout plan, CI).
// Usage: API_URL=http://localhost:3000 pnpm smoke
// Needs the demo seed (accounts in db/seed/README.md). Read-only apart from creating login sessions.
// Exits non-zero if any check failed. Never prints passwords or cookies.

const API = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const PASSWORD = process.env.SEED_PASSWORD ?? 'demo1234';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 10_000);
const ACCOUNTS = [
  ['patient', 'patient@hqms.test'],
  ['reception', 'reception@hqms.test'],
  ['doctor', 'doctor@hqms.test'],
  ['followup', 'followup@hqms.test'],
  ['admin', 'admin@hqms.test'],
];

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function call(path, { method = 'GET', body, cookie } = {}) {
  const headers = { accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { res, json };
}

async function check(name, fn) {
  try {
    record(name, true, await fn());
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err));
  }
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

function todayLocal() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.HOSPITAL_TZ ?? 'Asia/Kolkata' }).format(new Date());
}

console.log(`HQMS smoke against ${API}`);

await check('GET /health', async () => {
  const { res, json } = await call('/health');
  expect(res.status === 200, `status ${res.status}`);
  expect(json?.status === 'ok' && json?.db === 'up', 'body is not {status:ok, db:up}');
});

let doctorCookie;
for (const [role, email] of ACCOUNTS) {
  await check(`login + GET /me as ${role}`, async () => {
    const login = await call('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
    expect(login.res.status === 200, `login status ${login.res.status}`);
    const setCookie = login.res.headers.getSetCookie?.() ?? [];
    expect(setCookie.length > 0, 'no session cookie issued');
    const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    const me = await call('/me', { cookie });
    expect(me.res.status === 200, `/me status ${me.res.status}`);
    expect(me.json?.role === role, `expected role ${role}, got ${me.json?.role}`);
    if (role === 'doctor') doctorCookie = cookie;
    return `correlation ${login.res.headers.get('x-correlation-id') ?? 'n/a'}`;
  });
}

await check('GET /sessions?date=today (doctor)', async () => {
  expect(doctorCookie, 'doctor login failed earlier');
  const { res, json } = await call(`/sessions?date=${todayLocal()}`, { cookie: doctorCookie });
  expect(res.status === 200, `status ${res.status}`);
  expect(Array.isArray(json), 'response is not a JSON array');
  expect(json.length > 0, 'no sessions today (is the demo seed loaded?)');
  return `${json.length} sessions`;
});

await check('GET /display/sessions (public, no cookie)', async () => {
  const { res, json } = await call('/display/sessions');
  expect(res.status === 200, `status ${res.status}`);
  expect(json && typeof json === 'object', 'empty body');
});

await check('unauthenticated GET /me is refused', async () => {
  const { res } = await call('/me');
  expect(res.status === 401, `expected 401, got ${res.status}`);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
