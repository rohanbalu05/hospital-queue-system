import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueueJob, withTransaction } from '@hqms/db';
import {
  FakeOcrProvider,
  GcsStorage,
  LocalDiskStorage,
  NotConfiguredError,
  TransientProviderError,
  type OcrInput,
  type OcrProvider,
  type OcrResult,
} from '@hqms/providers';
import {
  defaultHandlers,
  documentDeps,
  ensureReconcileJob,
  reconcileBucket,
  reconcileDedupeKey,
} from '../src/handlers/index.js';
import { JobRunner } from '../src/runner.js';
import { bookAppointment, fixedClock, getJob, insertJob, makePool, makeWorld, testLog, type World } from './helpers.js';
import {
  deferred,
  draftsOf,
  eventsOf,
  fixtureBytes,
  getDocument,
  jobsFor,
  makeDocument,
  sha256,
} from './doc-helpers.js';

let pool: Pool;
let pool2: Pool;
let dir: string;
let storage: LocalDiskStorage;
let w: World;

beforeAll(async () => {
  pool = makePool(10);
  pool2 = makePool(4);
  w = await makeWorld(pool);
});
afterAll(async () => {
  await Promise.all([pool.end(), pool2.end()]);
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hqms-docs-'));
  storage = new LocalDiskStorage(dir);
  await pool.query(`DELETE FROM jobs`);
  await pool.query(`DELETE FROM ocr_drafts`);
  await pool.query(`DELETE FROM documents`);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Real time by default; tests that move time build their own fixedClock. */
const clock = () => new Date();

function runnerWith(
  ocr: OcrProvider = new FakeOcrProvider(),
  extra: { ocrTimeoutMs?: number; clock?: () => Date; jobTypes?: string[] } = {},
) {
  const c = extra.clock ?? clock;
  const deps = documentDeps({}, { storage, ocr, ocrTimeoutMs: extra.ocrTimeoutMs ?? 5_000 });
  return new JobRunner({
    pool,
    workerId: 'doc-worker',
    handlers: defaultHandlers(deps),
    log: testLog,
    pollMs: 20,
    renewEveryMs: 0,
    clock: c,
    jobTypes: extra.jobTypes,
    handlerTimeoutMs: 10_000,
  });
}

const enqueueOcr = (documentId: string, key = `ocr_document:${documentId}`, maxAttempts?: number) =>
  insertJob(pool, {
    type: 'ocr_document',
    payload: { documentId },
    dedupeKey: key,
    runAt: new Date(clock().getTime() - 1000),
    maxAttempts,
  });

describe('ocr_document success', () => {
  it('creates exactly one DRAFT, document ocr_ready, event without text, audit row', async () => {
    const d = await makeDocument(pool, storage, w, { fixture: 'prescription-printed' });
    const jobId = await enqueueOcr(d.documentId);
    await runnerWith().drain();

    const doc = await getDocument(pool, d.documentId);
    expect(doc.status).toBe('ocr_ready');
    expect(doc.ocr_attempts).toBe(1);
    expect(doc.last_error).toBeNull();
    expect(doc.version).toBe(3); // started (2) + completed (3)

    const drafts = await draftsOf(pool, d.documentId);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].provider).toBe('fake');
    expect(drafts[0].text).toContain('Paracetamol 500 mg');
    expect(drafts[0].blocks.length).toBeGreaterThan(2);
    expect(drafts[0].blocks[0]).toMatchObject({ page: 1 });

    // Draft only: no instruction was created for this patient (FR-13).
    const instr = await pool.query(`SELECT count(*)::int AS n FROM instructions WHERE patient_id = $1`, [d.patientId]);
    expect(instr.rows[0].n).toBe(0);

    const events = await eventsOf(pool, d.documentId, 'DocumentOCRCompleted');
    expect(events).toHaveLength(1);
    expect(events[0].patient_id).toBe(d.patientId);
    expect(JSON.stringify(events[0].payload)).not.toMatch(/Paracetamol|text/);
    expect(events[0].entity_version).toBe(3);

    const audit = await pool.query(
      `SELECT operation, actor_role, actor_id FROM audit_events WHERE entity_type = 'document' AND entity_id = $1 ORDER BY id`,
      [d.documentId],
    );
    expect(audit.rows.map((r) => r.operation)).toEqual(['document.ocr_started', 'document.ocr_completed']);
    expect(audit.rows.every((r) => r.actor_role === 'system' && r.actor_id === null)).toBe(true);
    expect((await getJob(pool, jobId)).state).toBe('succeeded');
  });

  it('low-quality and garbage fixtures still land as drafts (review decides), never approved', async () => {
    for (const fixture of ['prescription-handwritten-lowquality', 'garbage', 'lab-note']) {
      const d = await makeDocument(pool, storage, w, { fixture });
      await enqueueOcr(d.documentId);
      await runnerWith().drain();
      expect((await getDocument(pool, d.documentId)).status).toBe('ocr_ready');
      expect(await draftsOf(pool, d.documentId)).toHaveLength(1);
    }
  });

  it('running the job twice (a second job for the same document) creates one draft', async () => {
    const d = await makeDocument(pool, storage, w);
    await enqueueOcr(d.documentId);
    await enqueueOcr(d.documentId, `ocr_document:${d.documentId}:dup`);
    await runnerWith().drain();
    expect(await draftsOf(pool, d.documentId)).toHaveLength(1);
    expect((await getDocument(pool, d.documentId)).ocr_attempts).toBe(1);
    expect(await eventsOf(pool, d.documentId, 'DocumentOCRCompleted')).toHaveLength(1);
    const jobs = await jobsFor(pool, 'ocr_document', d.documentId);
    expect(jobs.map((j) => j.state)).toEqual(['succeeded', 'succeeded']);
  });

  it('two workers racing on duplicate jobs still create one draft', async () => {
    const d = await makeDocument(pool, storage, w);
    await enqueueOcr(d.documentId);
    await enqueueOcr(d.documentId, `ocr_document:${d.documentId}:dup`);
    const a = runnerWith();
    const b = new JobRunner({
      pool: pool2,
      workerId: 'doc-worker-b',
      handlers: defaultHandlers(documentDeps({}, { storage, ocr: new FakeOcrProvider() })),
      log: testLog,
      renewEveryMs: 0,
      clock,
    });
    await Promise.all([a.tick(1), b.tick(1)]);
    await a.drain();
    expect(await draftsOf(pool, d.documentId)).toHaveLength(1);
  });

  it('re-delivery after completion is a no-op (ocr_ready, then verified)', async () => {
    const d = await makeDocument(pool, storage, w);
    await enqueueOcr(d.documentId);
    await runnerWith().drain();
    await pool.query(`UPDATE documents SET status = 'verified' WHERE id = $1`, [d.documentId]);
    await enqueueOcr(d.documentId, `ocr_document:${d.documentId}:again`);
    await runnerWith().drain();
    expect((await getDocument(pool, d.documentId)).status).toBe('verified');
    expect(await draftsOf(pool, d.documentId)).toHaveLength(1);
  });

  it('a missing document cancels the job; a bad payload is dead at once', async () => {
    const missing = await enqueueOcr('00000000-0000-4000-8000-0000000000aa');
    const bad = await insertJob(pool, {
      type: 'ocr_document',
      payload: { documentId: 'nope' },
      dedupeKey: 'bad-payload',
      runAt: new Date(clock().getTime() - 1000),
    });
    await runnerWith().drain();
    expect((await getJob(pool, missing)).state).toBe('cancelled');
    const j = await getJob(pool, bad);
    expect(j.state).toBe('dead');
    expect(j.last_error).toMatch(/documentId must be a uuid/);
  });

  it('a document still in "uploaded" is deferred without using an attempt', async () => {
    const d = await makeDocument(pool, storage, w, { status: 'uploaded' });
    const id = await enqueueOcr(d.documentId);
    await runnerWith().drain();
    const j = await getJob(pool, id);
    expect(j.state).toBe('pending');
    expect(j.attempts).toBe(0);
    expect((await getDocument(pool, d.documentId)).status).toBe('uploaded');
  });

  it('crash recovery: "processing" is picked up on a re-claimed attempt but left alone on a first attempt', async () => {
    const d = await makeDocument(pool, storage, w, { status: 'processing' });
    const first = await enqueueOcr(d.documentId);
    await runnerWith().drain();
    expect((await getDocument(pool, d.documentId)).status).toBe('processing'); // first attempt: someone else's work
    expect((await getJob(pool, first)).state).toBe('succeeded');

    // A re-claimed job (previous worker died mid-OCR): attempt 2 of the same job finishes the work.
    await insertJob(pool, {
      type: 'ocr_document',
      payload: { documentId: d.documentId },
      dedupeKey: 'crashed',
      state: 'running',
      attempts: 1,
      leaseOwner: 'dead-worker',
      leaseExpiresAt: new Date(clock().getTime() - 60_000),
    });
    await runnerWith().drain();
    expect((await getDocument(pool, d.documentId)).status).toBe('ocr_ready');
    expect(await draftsOf(pool, d.documentId)).toHaveLength(1);
  });
});

describe('ocr_document validation', () => {
  it('object missing: ocr_failed "object missing", job dead without retries', async () => {
    const d = await makeDocument(pool, storage, w, { withObject: false });
    const id = await enqueueOcr(d.documentId);
    await runnerWith().drain();
    const doc = await getDocument(pool, d.documentId);
    expect(doc.status).toBe('ocr_failed');
    expect(doc.last_error).toMatch(/object missing/);
    const j = await getJob(pool, id);
    expect(j.state).toBe('dead');
    expect(j.attempts).toBe(1);
  });

  it('stored bytes that do not match the recorded hash are not OCRed', async () => {
    const d = await makeDocument(pool, storage, w);
    await storage.put(d.storageKey, Buffer.from('HQMS-FIXTURE:lab-note\ntampered'), { contentType: 'image/png' });
    await enqueueOcr(d.documentId);
    await runnerWith().drain();
    const doc = await getDocument(pool, d.documentId);
    expect(doc.status).toBe('ocr_failed');
    expect(doc.last_error).toMatch(/does not match/);
    expect(await draftsOf(pool, d.documentId)).toHaveLength(0);
  });

  it('only allowed types are processed (a row the table checks let through is still rejected)', async () => {
    const d = await makeDocument(pool, storage, w);
    await pool.query(`ALTER TABLE documents DROP CONSTRAINT documents_mime_type_check`);
    try {
      await pool.query(`UPDATE documents SET mime_type = 'application/zip' WHERE id = $1`, [d.documentId]);
      await enqueueOcr(d.documentId);
      await runnerWith().drain();
      const doc = await getDocument(pool, d.documentId);
      expect(doc.status).toBe('rejected');
      expect(doc.last_error).toBe('unsupported file type');
      expect(await draftsOf(pool, d.documentId)).toHaveLength(0);
    } finally {
      await pool.query(`DELETE FROM documents WHERE id = $1`, [d.documentId]);
      await pool.query(
        `ALTER TABLE documents ADD CONSTRAINT documents_mime_type_check CHECK (mime_type IN ('application/pdf','image/png','image/jpeg'))`,
      );
    }
  });
});

describe('ocr failure handling (FR-12-b)', () => {
  it('fixture "fail": ocr_failed + backoff retries, then dead; document stays visible with last_error', async () => {
    const c = fixedClock(new Date());
    const d = await makeDocument(pool, storage, w, { fixture: 'fail' });
    const id = await insertJob(pool, {
      type: 'ocr_document',
      payload: { documentId: d.documentId },
      dedupeKey: `ocr_document:${d.documentId}`,
      runAt: new Date(c().getTime() - 1000),
      maxAttempts: 3,
    });
    const runner = runnerWith(new FakeOcrProvider(), { clock: c });

    // attempt 1
    await runner.drain();
    let j = await getJob(pool, id);
    expect(j.state).toBe('failed');
    expect(j.attempts).toBe(1);
    expect(new Date(j.run_at).getTime()).toBe(c().getTime() + 2_000); // backoff 2^1 s
    let doc = await getDocument(pool, d.documentId);
    expect(doc.status).toBe('ocr_failed');
    expect(doc.last_error).toMatch(/TransientProviderError/);
    expect(doc.last_error).not.toMatch(/Paracetamol|HQMS-FIXTURE/); // summary only, never content

    // not due yet: nothing happens
    expect(await runner.drain()).toBe(0);

    // attempt 2 after the backoff
    c.advance(2_001);
    await runner.drain();
    j = await getJob(pool, id);
    expect(j.state).toBe('failed');
    expect(j.attempts).toBe(2);
    expect(new Date(j.run_at).getTime()).toBe(c().getTime() + 4_000);
    expect((await getDocument(pool, d.documentId)).ocr_attempts).toBe(2);

    // attempt 3 = max: dead, still visible
    c.advance(4_001);
    await runner.drain();
    j = await getJob(pool, id);
    expect(j.state).toBe('dead');
    expect(j.attempts).toBe(3);
    expect(j.last_error).toMatch(/fake OCR provider unavailable/);
    doc = await getDocument(pool, d.documentId);
    expect(doc.status).toBe('ocr_failed');
    expect(doc.ocr_attempts).toBe(3);
    expect(doc.last_error).toMatch(/unavailable/);
    expect(await draftsOf(pool, d.documentId)).toHaveLength(0);

    const failed = await eventsOf(pool, d.documentId, 'DocumentOCRFailed');
    expect(failed).toHaveLength(3);
    expect(failed.map((e) => e.payload.final)).toEqual([false, false, true]);

    // nothing more happens on its own
    c.advance(3_600_000);
    expect(await runner.drain()).toBe(0);
  });

  it('manual re-enqueue after ocr_failed succeeds once the stored file is replaced', async () => {
    const c = fixedClock(new Date());
    const d = await makeDocument(pool, storage, w, { fixture: 'fail' });
    await insertJob(pool, {
      type: 'ocr_document',
      payload: { documentId: d.documentId },
      dedupeKey: `ocr_document:${d.documentId}`,
      runAt: new Date(c().getTime() - 1000),
      maxAttempts: 1,
    });
    const runner = runnerWith(new FakeOcrProvider(), { clock: c });
    await runner.drain();
    expect((await getDocument(pool, d.documentId)).status).toBe('ocr_failed');

    // Staff re-upload a readable file: bytes, size and hash change on the row (the API does this), then retry.
    const good = await fixtureBytes('prescription-printed');
    await storage.put(d.storageKey, good, { contentType: 'image/png' });
    await pool.query(`UPDATE documents SET size_bytes = $2, content_hash = $3 WHERE id = $1`, [
      d.documentId,
      good.length,
      sha256(good),
    ]);
    await withTransaction(pool, async (tx) => {
      await enqueueJob(tx, {
        jobType: 'ocr_document',
        payload: { documentId: d.documentId },
        runAt: new Date(c().getTime() - 1000),
        dedupeKey: `ocr_document:${d.documentId}:retry:1`,
      });
    });
    await runner.drain();
    const doc = await getDocument(pool, d.documentId);
    expect(doc.status).toBe('ocr_ready');
    expect(doc.last_error).toBeNull();
    expect(doc.ocr_attempts).toBe(2);
    const drafts = await draftsOf(pool, d.documentId);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].text).toContain('Paracetamol');
  });

  it('a permanent provider error goes dead at once with the document ocr_failed', async () => {
    const d = await makeDocument(pool, storage, w);
    await enqueueOcr(d.documentId);
    // A plain Error is "unknown" -> treated as transient; a ProviderError with transient=false is permanent.
    const permanent: OcrProvider = {
      name: 'x',
      extract: () => Promise.reject(new NotConfiguredError('google-vision')),
    };
    await runnerWith(permanent).drain();
    const j = (await jobsFor(pool, 'ocr_document', d.documentId))[0];
    expect(j.state).toBe('dead');
    expect(j.attempts).toBe(1);
    expect((await getDocument(pool, d.documentId)).status).toBe('ocr_failed');
  });
});

describe('failure isolation (NFR-07): a hung or failing OCR provider holds no database locks', () => {
  /** A provider that parks inside extract() until released, signalling when it has been entered. */
  function gatedProvider(outcome: 'resolve' | 'fail') {
    const entered = deferred();
    const release = deferred();
    const provider: OcrProvider = {
      name: 'gated',
      async extract(_i: OcrInput): Promise<OcrResult> {
        entered.resolve();
        await release.promise;
        if (outcome === 'fail') throw new TransientProviderError('provider exploded');
        return { text: 'late text', blocks: [{ page: 1, text: 'late text' }], provider: 'gated' };
      },
    };
    return { provider, entered, release };
  }

  async function assertNoLocksHeld(documentId: string, sessionId: string) {
    // The document row is free: NOWAIT would raise 55P03 if the worker's transaction still held it.
    const c = await pool2.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query(`SELECT id FROM documents WHERE id = $1 FOR UPDATE NOWAIT`, [documentId]);
      expect(r.rowCount).toBe(1);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    // No worker connection is idle in a transaction.
    const idle = await pool2.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'worker-test' AND state LIKE 'idle in transaction%'`,
    );
    expect(idle.rows[0].n).toBe(0);
    // And no row lock of the doctor/session guards is taken either.
    const g = await pool2.connect();
    try {
      await g.query('BEGIN');
      await g.query(`SELECT id FROM sessions WHERE id = $1 FOR UPDATE NOWAIT`, [sessionId]);
      await g.query('ROLLBACK');
    } finally {
      g.release();
    }
  }

  for (const outcome of ['resolve', 'fail'] as const) {
    it(`while the provider call is in flight (${outcome}): document row unlocked, booking still works`, async () => {
      const d = await makeDocument(pool, storage, w);
      await enqueueOcr(d.documentId);
      const g = gatedProvider(outcome);
      const run = runnerWith(g.provider).tick(1);
      await g.entered.promise;

      await assertNoLocksHeld(d.documentId, w.sessionId);
      // Booking and queue operations proceed while OCR is parked.
      const t0 = Date.now();
      const booked = await bookAppointment(pool2, w);
      expect(booked.appointmentId).toBeTruthy();
      expect(Date.now() - t0).toBeLessThan(2_000);
      expect((await getDocument(pool, d.documentId)).status).toBe('processing'); // visible, not locked

      g.release.resolve();
      await run;
      expect((await getDocument(pool, d.documentId)).status).toBe(outcome === 'resolve' ? 'ocr_ready' : 'ocr_failed');
    });
  }

  it('a provider that never returns is abandoned after the OCR timeout: ocr_failed, no locks, job retried', async () => {
    const d = await makeDocument(pool, storage, w);
    const id = await enqueueOcr(d.documentId);
    const hung: OcrProvider = { name: 'hung', extract: () => new Promise<OcrResult>(() => undefined) };
    const t0 = Date.now();
    await runnerWith(hung, { ocrTimeoutMs: 150 }).tick(1);
    expect(Date.now() - t0).toBeLessThan(3_000);
    const doc = await getDocument(pool, d.documentId);
    expect(doc.status).toBe('ocr_failed');
    expect(doc.last_error).toMatch(/timed out/);
    expect((await getJob(pool, id)).state).toBe('failed'); // will back off and retry
    await assertNoLocksHeld(d.documentId, w.sessionId);
  });

  it('OCR failures never touch bookings, sessions or queue state', async () => {
    const before = await pool.query(`SELECT queue_version FROM sessions WHERE id = $1`, [w.sessionId]);
    const docs = await Promise.all(
      Array.from({ length: 5 }, () => makeDocument(pool, storage, w, { fixture: 'fail' })),
    );
    for (const d of docs) await enqueueOcr(d.documentId, `ocr_document:${d.documentId}`, 1);
    await runnerWith().drain();
    const after = await pool.query(`SELECT queue_version FROM sessions WHERE id = $1`, [w.sessionId]);
    expect(after.rows[0].queue_version).toBe(before.rows[0].queue_version);
    const booked = await bookAppointment(pool, w);
    expect(booked.appointmentId).toBeTruthy();
  });
});

describe('reconcile_uploads', () => {
  const now = new Date();
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const MIN = 60_000;

  const reconcile = async (at: Date = now, ocr?: OcrProvider) => {
    const c = fixedClock(at);
    const id = await insertJob(pool, {
      type: 'reconcile_uploads',
      payload: {},
      dedupeKey: `test-reconcile:${Math.random()}`,
      runAt: new Date(at.getTime() - 1000),
    });
    await runnerWith(ocr, { clock: c, jobTypes: ['reconcile_uploads'] }).tick(1);
    return getJob(pool, id);
  };

  it('(a) uploaded > 15 min with its object -> accepted and an ocr_document job exists', async () => {
    const d = await makeDocument(pool, storage, w, { status: 'uploaded', createdAt: ago(20 * MIN) });
    const j = await reconcile();
    expect(j.state).toBe('succeeded');
    const doc = await getDocument(pool, d.documentId);
    expect(doc.status).toBe('accepted');
    const jobs = await jobsFor(pool, 'ocr_document', d.documentId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].dedupe_key).toBe(`ocr_document:${d.documentId}`);
    expect(jobs[0].state).toBe('pending');
  });

  it('(a) the accepted document then flows through OCR to ocr_ready', async () => {
    const d = await makeDocument(pool, storage, w, { status: 'uploaded', createdAt: ago(20 * MIN) });
    await reconcile();
    await pool.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE job_type = 'ocr_document'`);
    await runnerWith().drain();
    expect((await getDocument(pool, d.documentId)).status).toBe('ocr_ready');
  });

  it('(a) an existing ocr_document job is not duplicated (dedupe key)', async () => {
    const d = await makeDocument(pool, storage, w, { status: 'uploaded', createdAt: ago(20 * MIN) });
    await insertJob(pool, {
      type: 'ocr_document',
      payload: { documentId: d.documentId },
      dedupeKey: `ocr_document:${d.documentId}`,
      runAt: ago(-3_600_000),
    });
    await reconcile();
    expect(await jobsFor(pool, 'ocr_document', d.documentId)).toHaveLength(1);
    expect((await getDocument(pool, d.documentId)).status).toBe('accepted');
  });

  it('(a) uploaded > 15 min and the object is missing -> rejected "object missing" + event', async () => {
    const d = await makeDocument(pool, storage, w, { status: 'uploaded', createdAt: ago(20 * MIN), withObject: false });
    await reconcile();
    const doc = await getDocument(pool, d.documentId);
    expect(doc.status).toBe('rejected');
    expect(doc.last_error).toBe('object missing');
    expect(await jobsFor(pool, 'ocr_document', d.documentId)).toHaveLength(0);
    expect(await eventsOf(pool, d.documentId, 'DocumentOCRFailed')).toHaveLength(1);
  });

  it('(a) a size mismatch (partial upload) is rejected; a young upload is left alone', async () => {
    const partial = await makeDocument(pool, storage, w, {
      status: 'uploaded',
      createdAt: ago(20 * MIN),
      sizeBytes: 999_999,
    });
    const young = await makeDocument(pool, storage, w, { status: 'uploaded', createdAt: ago(5 * MIN) });
    await reconcile();
    expect((await getDocument(pool, partial.documentId)).status).toBe('rejected');
    expect((await getDocument(pool, young.documentId)).status).toBe('uploaded');
  });

  it('(b) objects with no documents row: deleted after 1 h, kept before; referenced objects are kept', async () => {
    const referenced = await makeDocument(pool, storage, w, { status: 'ocr_ready', objectAgeMs: 3 * 60 * MIN });
    await storage.put('documents/orphan-patient/old-orphan', Buffer.from('x'), { contentType: 'image/png' });
    await storage.put('documents/orphan-patient/new-orphan', Buffer.from('y'), { contentType: 'image/png' });
    const old = new Date(now.getTime() - 61 * MIN);
    await utimes(join(dir, 'documents/orphan-patient/old-orphan'), old, old);
    const recent = new Date(now.getTime() - 10 * MIN);
    await utimes(join(dir, 'documents/orphan-patient/new-orphan'), recent, recent);

    await reconcile();
    expect(await storage.head('documents/orphan-patient/old-orphan')).toBeNull();
    expect(await storage.head('documents/orphan-patient/new-orphan')).not.toBeNull();
    expect(await storage.head(referenced.storageKey)).not.toBeNull();
  });

  it('(c) accepted with no active ocr_document job -> enqueued; with a pending/failed job -> left alone', async () => {
    const orphaned = await makeDocument(pool, storage, w, { status: 'accepted', createdAt: ago(30 * MIN) });
    const covered = await makeDocument(pool, storage, w, { status: 'accepted', createdAt: ago(30 * MIN) });
    const retrying = await makeDocument(pool, storage, w, { status: 'accepted', createdAt: ago(30 * MIN) });
    const fresh = await makeDocument(pool, storage, w, { status: 'accepted', createdAt: ago(1 * MIN) });
    await insertJob(pool, {
      type: 'ocr_document',
      payload: { documentId: covered.documentId },
      dedupeKey: `ocr_document:${covered.documentId}`,
      runAt: ago(-3_600_000),
    });
    await insertJob(pool, {
      type: 'ocr_document',
      payload: { documentId: retrying.documentId },
      dedupeKey: `ocr_document:${retrying.documentId}`,
      state: 'failed',
      attempts: 1,
      runAt: ago(-60_000),
    });

    await reconcile();
    expect(await jobsFor(pool, 'ocr_document', orphaned.documentId)).toHaveLength(1);
    expect(await jobsFor(pool, 'ocr_document', covered.documentId)).toHaveLength(1);
    expect(await jobsFor(pool, 'ocr_document', retrying.documentId)).toHaveLength(1);
    expect(await jobsFor(pool, 'ocr_document', fresh.documentId)).toHaveLength(0);
  });

  it('(c) a document whose earlier job is dead gets a new job, once per hour bucket', async () => {
    const d = await makeDocument(pool, storage, w, { status: 'accepted', createdAt: ago(30 * MIN) });
    await insertJob(pool, {
      type: 'ocr_document',
      payload: { documentId: d.documentId },
      dedupeKey: `ocr_document:${d.documentId}`,
      state: 'dead',
      attempts: 5,
      runAt: ago(60 * MIN),
    });
    await reconcile();
    await reconcile(new Date(now.getTime() + 1000));
    const jobs = await jobsFor(pool, 'ocr_document', d.documentId);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.state).sort()).toEqual(['dead', 'pending']);
  });

  it('(d) processing for 30+ min with no job left -> ocr_failed (visible)', async () => {
    const stuck = await makeDocument(pool, storage, w, { status: 'processing', createdAt: ago(60 * MIN) });
    const busy = await makeDocument(pool, storage, w, { status: 'processing', createdAt: ago(60 * MIN) });
    await insertJob(pool, {
      type: 'ocr_document',
      payload: { documentId: busy.documentId },
      dedupeKey: `ocr_document:${busy.documentId}`,
      state: 'failed',
      attempts: 2,
      runAt: ago(-60_000),
    });
    await reconcile();
    const doc = await getDocument(pool, stuck.documentId);
    expect(doc.status).toBe('ocr_failed');
    expect(doc.last_error).toMatch(/stalled/);
    expect((await getDocument(pool, busy.documentId)).status).toBe('processing');
  });

  it('is idempotent and reschedules itself for the next hour with a stable dedupe key', async () => {
    const at = new Date('2030-05-05T10:20:00.000Z');
    await makeDocument(pool, storage, w, { status: 'uploaded', createdAt: new Date(at.getTime() - 20 * MIN) });
    await reconcile(at);
    const before = await pool.query(`SELECT count(*)::int AS n FROM documents WHERE status = 'accepted'`);
    await reconcile(new Date(at.getTime() + 1000));
    const after = await pool.query(`SELECT count(*)::int AS n FROM documents WHERE status = 'accepted'`);
    expect(after.rows[0].n).toBe(before.rows[0].n);

    const next = await pool.query(
      `SELECT run_at, dedupe_key FROM jobs WHERE dedupe_key = 'reconcile_uploads:2030-05-05-11'`,
    );
    expect(next.rowCount).toBe(1);
    expect(new Date(next.rows[0].run_at).toISOString()).toBe('2030-05-05T11:00:00.000Z');
    expect(reconcileBucket(at)).toBe('2030-05-05-10');
    expect(reconcileDedupeKey(at)).toBe('reconcile_uploads:2030-05-05-10');
  });

  it('ensureReconcileJob seeds the current hour once, however many workers call it', async () => {
    const at = new Date('2031-01-01T03:05:00.000Z');
    const results = await Promise.all([
      ensureReconcileJob(pool, at),
      ensureReconcileJob(pool2, at),
      ensureReconcileJob(pool, at),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await pool.query(`SELECT 1 FROM jobs WHERE dedupe_key = 'reconcile_uploads:2031-01-01-03'`)).rowCount).toBe(
      1,
    );
  });

  it('a storage outage fails the reconcile job (retried) without touching documents', async () => {
    const d = await makeDocument(pool, storage, w, { status: 'uploaded', createdAt: ago(20 * MIN) });
    const broken = documentDeps({}, { storage: new GcsStorage(), ocr: new FakeOcrProvider() });
    const id = await insertJob(pool, { type: 'reconcile_uploads', payload: {}, dedupeKey: 'outage', runAt: ago(1000) });
    const runner = new JobRunner({
      pool,
      workerId: 'x',
      handlers: defaultHandlers(broken),
      log: testLog,
      renewEveryMs: 0,
      clock: fixedClock(now),
    });
    await runner.tick(1);
    expect((await getJob(pool, id)).state).toBe('failed');
    expect((await getDocument(pool, d.documentId)).status).toBe('uploaded');
  });
});
