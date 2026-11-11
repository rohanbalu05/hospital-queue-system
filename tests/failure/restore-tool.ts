/**
 * Helper for tests/failure/restore-drill.sh (NFR-05). Subcommands print one JSON object on stdout:
 *

 *   tsx failure/restore-tool.ts init   <db>                     drop/create/migrate/seed a scratch database (hqms_restore_*)
 *   tsx failure/restore-tool.ts load   <apiUrl> <db>            loaded dataset: patients, sessions, bookings, queue activity, real files in storage
 *   tsx failure/restore-tool.ts writes <apiUrl> <db> <n>        n more bookings (the writes made AFTER the backup)
 *   tsx failure/restore-tool.ts check  <db> <storageDir>        post-restore reconciliation checks (read-only)
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are JSON of known shapes that each step narrows */
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  bulkPatients,
  checkInvariants,
  createSession,
  doctorEmail,
  login,
  newPool,
  recreateDb,
  round1,
  sleep,
  type Http,
  type MadeSession,
} from '../load/lib/harness.js';

const [cmd, ...args] = process.argv.slice(2);

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

/** Deterministic filler so the stored files have realistic size (about 200 KB each) and distinct hashes. */
function filler(seed: string, bytes: number): Buffer {
  const chunks: Buffer[] = [];
  let h = createHash('sha256').update(seed).digest();
  let size = 0;
  while (size < bytes) {
    chunks.push(h);
    size += h.length;
    h = createHash('sha256').update(h).digest();
  }
  return Buffer.concat(chunks).subarray(0, bytes);
}

async function futureSession(admin: Http, doctor: number, day: number): Promise<MadeSession> {
  const date = new Date(Date.UTC(2043, 0, 1 + day)).toISOString().slice(0, 10);
  const s = await createSession(admin, { doctor, date, startMs: Date.parse(`${date}T09:00:00+05:30`), durationMin: 240, booked: 10, walkin: 5, label: 'morning' });
  if (!s) throw new Error('session clash');
  return s;
}

async function load(apiUrl: string, db: string): Promise<void> {
  const pool = newPool(db, 4);
  const admin = await login(apiUrl, 'admin@hqms.test');
  const reception = await login(apiUrl, 'reception@hqms.test');
  const doctor = await login(apiUrl, doctorEmail(1));
  const patients = await bulkPatients(pool, 1500, 'RD');
  // 30 future sessions x 10 bookings
  const sessions: MadeSession[] = [];
  for (let i = 0; i < 30; i += 1) sessions.push(await futureSession(admin, 1 + (i % 10), Math.floor(i / 10)));
  let booked = 0;
  await pmap(Array.from({ length: 300 }, (_, i) => i), 8, async (i) => {
    const r = await reception.post('/appointments', { sessionId: (sessions[Math.floor(i / 10)] as MadeSession).id, patientId: patients[i] as string });
    if (r.status === 201) booked += 1;
  });
  // a session running now: 8 walk-ins, 3 consultations completed
  const nowMs = Math.floor(Date.now() / 60_000) * 60_000;
  const running = await createSession(admin, { doctor: 1, startMs: nowMs - 25 * 60_000, durationMin: 240, booked: 10, walkin: 15 });
  if (!running) throw new Error('clash');
  for (let i = 0; i < 8; i += 1) await reception.post(`/sessions/${running.id}/walk-ins`, { patientId: patients[300 + i] as string });
  for (let i = 0; i < 3; i += 1) {
    const call = await doctor.post(`/sessions/${running.id}/call-next`, {});
    if (call.status !== 200 || !call.body.entry) throw new Error(`call-next ${call.status}`);
    await doctor.post(`/visits/${call.body.entry.visitId}/start`, {});
    await doctor.post(`/visits/${call.body.entry.visitId}/complete`, {});
  }
  // real files: 6 PDFs (fixture markers) and 2 PNG-like files, about 200 KB each, for patients that have appointments
  const fixtures = ['prescription-printed', 'lab-note', 'garbage', 'prescription-printed', 'lab-note', 'garbage'];
  const docIds: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    const isPdf = i < 6;
    const bytes = isPdf
      ? Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\nHQMS-FIXTURE:${fixtures[i]}\n% `, 'latin1'), filler(`doc-${i}`, 200_000), Buffer.from('\n%%EOF\n', 'latin1')])
      : Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), filler(`img-${i}`, 200_000)]);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: isPdf ? 'application/pdf' : 'image/png' }), isPdf ? `record-${i}.pdf` : `scan-${i}.png`);
    form.append('patientId', patients[i] as string);
    const res = await fetch(`${apiUrl}/documents`, { method: 'POST', headers: { Cookie: reception.cookie as string }, body: form });
    const body: any = await res.json();
    if (res.status !== 201) throw new Error(`upload ${i}: ${res.status} ${JSON.stringify(body)}`);
    docIds.push(body.id);
  }
  for (let i = 0; i < 60; i += 1) {
    const r = await pool.query(`SELECT count(*) FILTER (WHERE status IN ('ocr_ready','ocr_failed'))::int AS done, count(*)::int AS n FROM documents`);
    if (r.rows[0].done === r.rows[0].n) break;
    await sleep(500);
  }
  const counts = (await pool.query(`SELECT (SELECT count(*)::int FROM patients) AS patients, (SELECT count(*)::int FROM sessions) AS sessions, (SELECT count(*)::int FROM appointments) AS appointments,
      (SELECT count(*)::int FROM queue_entries) AS queue_entries, (SELECT count(*)::int FROM documents) AS documents, (SELECT count(*)::int FROM audit_events) AS audit_events,
      (SELECT count(*)::int FROM jobs WHERE state IN ('pending','running')) AS open_jobs, (SELECT max(occurred_at) FROM audit_events) AS last_audit_at`)).rows[0];
  await pool.end();
  console.log(JSON.stringify({ booked, documents: docIds.length, counts }));
}

async function writes(apiUrl: string, db: string, n: number): Promise<void> {
  const pool = newPool(db, 2);
  const admin = await login(apiUrl, 'admin@hqms.test');
  const reception = await login(apiUrl, 'reception@hqms.test');
  const s = await futureSession(admin, 1, 400 + Math.floor(Math.random() * 1000));
  const free = (await pool.query(`SELECT id FROM patients WHERE mrn LIKE 'RD-%' ORDER BY mrn DESC LIMIT $1`, [n])).rows.map((r) => r.id as string);
  let ok = 0;
  for (const p of free.slice(0, Math.min(n, 10))) {
    const r = await reception.post('/appointments', { sessionId: s.id, patientId: p });
    if (r.status === 201) ok += 1;
  }
  const last = (await pool.query(`SELECT max(occurred_at) AS t FROM audit_events`)).rows[0].t;
  await pool.end();
  console.log(JSON.stringify({ bookingsAfterBackup: ok, lastAuditAt: last }));
}

function walk(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(p).isDirectory()) out.push(...walk(p, rel));
    else if (!name.startsWith('.tmp-')) out.push(rel);
  }
  return out;
}

async function check(db: string, storageDir: string): Promise<void> {
  const pool = newPool(db, 2);
  const migrations = (await pool.query(`SELECT count(*)::int AS applied, max(version) AS latest FROM schema_migrations`)).rows[0];
  const capacity = (await pool.query(
    `SELECT sc.session_id FROM session_capacity sc LEFT JOIN capacity_allocations a ON a.session_id = sc.session_id
      GROUP BY sc.session_id, sc.booked_reserved, sc.walkin_used
     HAVING sc.booked_reserved <> count(*) FILTER (WHERE a.kind = 'booked' AND a.state IN ('reserved','consumed'))
         OR sc.walkin_used <> count(*) FILTER (WHERE a.kind = 'walkin' AND a.state IN ('reserved','consumed'))`,
  )).rowCount;
  const doubleAlloc = (await pool.query(`SELECT doctor_id FROM queue_entries WHERE state IN ('called','in_service') GROUP BY 1 HAVING count(*) > 1`)).rowCount;
  const inv = await checkInvariants(pool);
  const docs = (await pool.query(`SELECT id, storage_key, size_bytes, content_hash, status FROM documents`)).rows;
  const files = new Set(storageDir ? walk(storageDir) : []);
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const d of docs) {
    if (!files.has(d.storage_key)) missing.push(d.id);
    else {
      const { readFileSync } = await import('node:fs');
      const bytes = readFileSync(join(storageDir, ...String(d.storage_key).split('/')));
      if (bytes.length !== d.size_bytes || createHash('sha256').update(bytes).digest('hex') !== d.content_hash) mismatched.push(d.id);
    }
  }
  const keys = new Set(docs.map((d) => d.storage_key as string));
  const orphans = [...files].filter((f) => !keys.has(f));
  const byStatus = docs.reduce<Record<string, number>>((m, d) => ((m[d.status] = (m[d.status] ?? 0) + 1), m), {});
  const jobs = (await pool.query(`SELECT job_type, state, count(*)::int AS n FROM jobs GROUP BY 1, 2 ORDER BY 1, 2`)).rows;
  const counts = (await pool.query(`SELECT (SELECT count(*)::int FROM patients) AS patients, (SELECT count(*)::int FROM sessions) AS sessions, (SELECT count(*)::int FROM appointments) AS appointments,
      (SELECT count(*)::int FROM queue_entries) AS queue_entries, (SELECT count(*)::int FROM documents) AS documents, (SELECT count(*)::int FROM audit_events) AS audit_events,
      (SELECT max(occurred_at) FROM audit_events) AS last_audit_at`)).rows[0];
  await pool.end();
  console.log(
    JSON.stringify({
      migrations,
      capacityCounterMismatchRows: capacity,
      doctorsWithTwoActiveAllocations: doubleAlloc,
      globalInvariantViolations: inv.violations.length,
      invariantSample: inv.violations.slice(0, 3),
      documents: { total: docs.length, byStatus, objectsInStorage: files.size, documentsWithMissingObject: missing.length, documentsWithSizeOrHashMismatch: mismatched.length, objectsWithoutDocument: orphans.length },
      jobs,
      counts,
      checkMs: round1(0),
    }),
  );
}

async function main(): Promise<void> {
  if (cmd === 'init') {
    await recreateDb(args[0] as string);
    console.log(JSON.stringify({ created: args[0] }));
    return;
  }
  if (cmd === 'load') return load(args[0] as string, args[1] as string);
  if (cmd === 'writes') return writes(args[0] as string, args[1] as string, Number(args[2] ?? 10));
  if (cmd === 'check') return check(args[0] as string, args[1] as string);
  throw new Error(`unknown command ${cmd}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
