import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  LocalDiskStorage,
  TransientProviderError,
  type OcrInput,
  type OcrProvider,
  type OcrResult,
} from '@hqms/providers';
import { defaultHandlers, documentDeps } from '../src/handlers/index.js';
import { JobRunner } from '../src/runner.js';
import type { JobRow } from '../src/types.js';
import { getJob, insertJob, makePool, makeWorld, testLog, type World } from './helpers.js';
import { deferred, draftsOf, eventsOf, getDocument, makeDocument } from './doc-helpers.js';

/*
 * Attempt fencing (Codex P1 #3): an OCR attempt that lost its job lease (a newer attempt re-claimed the job)
 * must not write the document in ANY of its three transactions (start, success, failure). Real Postgres, the real
 * handler and runner, and a provider whose calls the test releases one at a time.
 */

let pool: Pool;
let dir: string;
let storage: LocalDiskStorage;
let w: World;

beforeAll(async () => {
  pool = makePool(10);
  w = await makeWorld(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hqms-fence-'));
  storage = new LocalDiskStorage(dir);
  await pool.query(`DELETE FROM jobs`);
  await pool.query(`DELETE FROM ocr_drafts`);
  await pool.query(`DELETE FROM documents`);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** One provider call, parked until the test settles it. */
function gated(name: string) {
  const entered = deferred();
  const outcome = deferred<'ok' | 'fail'>();
  const provider: OcrProvider = {
    name,
    async extract(_i: OcrInput): Promise<OcrResult> {
      entered.resolve();
      if ((await outcome.promise) === 'fail') throw new TransientProviderError(`${name} exploded`);
      return { text: `text from ${name}`, blocks: [{ page: 1, text: `text from ${name}` }], provider: name };
    },
  };
  return {
    provider,
    entered: entered.promise,
    succeed: () => outcome.resolve('ok'),
    fail: () => outcome.resolve('fail'),
  };
}

function runnerFor(workerId: string, ocr: OcrProvider) {
  const deps = documentDeps({}, { storage, ocr, ocrTimeoutMs: 10_000 });
  return new JobRunner({
    pool,
    workerId,
    handlers: defaultHandlers(deps),
    log: testLog,
    pollMs: 20,
    renewEveryMs: 0,
    handlerTimeoutMs: 20_000,
  });
}

async function expireLease(jobId: string) {
  await pool.query(`UPDATE jobs SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [jobId]);
}

const claimOne = async (r: JobRunner): Promise<JobRow> => {
  const [job] = await r.claim(1);
  if (!job) throw new Error('nothing to claim');
  return job;
};

/** Attempt A claims and parks in its provider call; A's lease then expires. */
async function startAttemptA(workerA: string, a: ReturnType<typeof gated>) {
  const d = await makeDocument(pool, storage, w);
  const jobId = await insertJob(pool, {
    type: 'ocr_document',
    payload: { documentId: d.documentId },
    dedupeKey: `ocr_document:${d.documentId}`,
    runAt: new Date(Date.now() - 1000),
  });
  const runnerA = runnerFor(workerA, a.provider);
  const jobA = await claimOne(runnerA);
  expect(jobA.attempts).toBe(1);
  const runA = runnerA.execute(jobA);
  await a.entered;
  await expireLease(jobId);
  return { d, jobId, jobA, runA };
}

for (const [label, workerA, workerB] of [
  ['different workers', 'worker-a', 'worker-b'],
  ['the same worker id (only attempts differ)', 'worker-x', 'worker-x'],
] as const) {
  describe(`superseded OCR attempt: ${label}`, () => {
    it('A fails late AFTER B succeeded: the document stays ocr_ready, one draft, no failure event', async () => {
      const a = gated('prov-a');
      const { d, jobId, runA } = await startAttemptA(workerA, a);

      const b = gated('prov-b');
      const runnerB = runnerFor(workerB, b.provider);
      const jobB = await claimOne(runnerB);
      expect(jobB.attempts).toBe(2);
      const runB = runnerB.execute(jobB);
      await b.entered;
      b.succeed();
      await runB;
      expect((await getDocument(pool, d.documentId)).status).toBe('ocr_ready');

      a.fail();
      await runA;

      const doc = await getDocument(pool, d.documentId);
      expect(doc.status).toBe('ocr_ready');
      expect(doc.last_error).toBeNull();
      const drafts = await draftsOf(pool, d.documentId);
      expect(drafts).toHaveLength(1);
      expect(drafts[0].provider).toBe('prov-b');
      expect(await eventsOf(pool, d.documentId, 'DocumentOCRFailed')).toHaveLength(0);
      expect(await eventsOf(pool, d.documentId, 'DocumentOCRCompleted')).toHaveLength(1);
      const ops = await pool.query(
        `SELECT operation FROM audit_events WHERE entity_type = 'document' AND entity_id = $1 ORDER BY id`,
        [d.documentId],
      );
      expect(ops.rows.map((r) => r.operation)).not.toContain('document.ocr_failed');
      // The runner's own guard: A's failure must not overwrite B's outcome.
      const j = await getJob(pool, jobId);
      expect(j.state).toBe('succeeded');
      expect(j.attempts).toBe(2);
      expect(j.last_error).toBeNull();
    });

    it('A fails late BEFORE B finishes: A writes nothing and B still creates the draft (no zero-draft stall)', async () => {
      const a = gated('prov-a');
      const { d, jobId, runA } = await startAttemptA(workerA, a);

      const b = gated('prov-b');
      const runnerB = runnerFor(workerB, b.provider);
      const jobB = await claimOne(runnerB);
      const runB = runnerB.execute(jobB);
      await b.entered;
      expect((await getDocument(pool, d.documentId)).status).toBe('processing');

      a.fail();
      await runA;
      // A's late failure left B's document alone and did not touch B's job.
      const mid = await getDocument(pool, d.documentId);
      expect(mid.status).toBe('processing');
      expect(mid.last_error).toBeNull();
      expect(await eventsOf(pool, d.documentId, 'DocumentOCRFailed')).toHaveLength(0);
      const jMid = await getJob(pool, jobId);
      expect(jMid.state).toBe('running');
      expect(jMid.attempts).toBe(2);

      b.succeed();
      await runB;
      const doc = await getDocument(pool, d.documentId);
      expect(doc.status).toBe('ocr_ready');
      const drafts = await draftsOf(pool, d.documentId);
      expect(drafts).toHaveLength(1);
      expect(drafts[0].provider).toBe('prov-b');
      expect(await eventsOf(pool, d.documentId, 'DocumentOCRCompleted')).toHaveLength(1);
      expect((await getJob(pool, jobId)).state).toBe('succeeded');
    });

    it('A succeeds late AFTER B succeeded: still exactly one draft and one completion event', async () => {
      const a = gated('prov-a');
      const { d, jobId, runA } = await startAttemptA(workerA, a);

      const b = gated('prov-b');
      const runnerB = runnerFor(workerB, b.provider);
      const runB = runnerB.execute(await claimOne(runnerB));
      await b.entered;
      b.succeed();
      await runB;

      a.succeed();
      await runA;

      expect(await draftsOf(pool, d.documentId)).toHaveLength(1);
      expect((await draftsOf(pool, d.documentId))[0].provider).toBe('prov-b');
      expect(await eventsOf(pool, d.documentId, 'DocumentOCRCompleted')).toHaveLength(1);
      expect((await getDocument(pool, d.documentId)).status).toBe('ocr_ready');
      expect((await getJob(pool, jobId)).state).toBe('succeeded');
    });

    it("A succeeds late WHILE B is still in its provider call: A writes nothing, the draft is B's", async () => {
      const a = gated('prov-a');
      const { d, jobId, runA } = await startAttemptA(workerA, a);

      const b = gated('prov-b');
      const runnerB = runnerFor(workerB, b.provider);
      const runB = runnerB.execute(await claimOne(runnerB));
      await b.entered;

      a.succeed();
      await runA;
      expect((await getDocument(pool, d.documentId)).status).toBe('processing');
      expect(await draftsOf(pool, d.documentId)).toHaveLength(0);
      expect((await getJob(pool, jobId)).state).toBe('running');

      b.succeed();
      await runB;
      const drafts = await draftsOf(pool, d.documentId);
      expect(drafts).toHaveLength(1);
      expect(drafts[0].provider).toBe('prov-b');
      expect((await getDocument(pool, d.documentId)).status).toBe('ocr_ready');
      expect(await eventsOf(pool, d.documentId, 'DocumentOCRCompleted')).toHaveLength(1);
      expect((await getJob(pool, jobId)).state).toBe('succeeded');
    });
  });
}

describe('superseded OCR attempt: the start transaction is fenced too', () => {
  it('a stale attempt that only now reaches tx1 changes nothing (document stays accepted, no attempt counted)', async () => {
    const d = await makeDocument(pool, storage, w);
    const jobId = await insertJob(pool, {
      type: 'ocr_document',
      payload: { documentId: d.documentId },
      runAt: new Date(Date.now() - 1000),
    });
    const stale = await claimOne(runnerFor('worker-a', gated('unused').provider));
    await expireLease(jobId);
    const b = gated('prov-b');
    const runnerB = runnerFor('worker-b', b.provider);
    const jobB = await claimOne(runnerB);
    expect(jobB.attempts).toBe(2);

    // A (stale snapshot: attempt 1, owner worker-a) now runs its handler while B holds the lease.
    const neverCalled: OcrProvider = {
      name: 'never-called',
      extract: () => Promise.reject(new TransientProviderError('a superseded attempt must not reach the provider')),
    };
    const handler = defaultHandlers(documentDeps({}, { storage, ocr: neverCalled }))['ocr_document'];
    if (!handler) throw new Error('ocr_document handler missing');
    const abort = new AbortController();
    await handler(stale, { pool, now: () => new Date(), log: testLog, signal: abort.signal });

    const doc = await getDocument(pool, d.documentId);
    expect(doc.status).toBe('accepted');
    expect(doc.ocr_attempts).toBe(0);
    expect(doc.version).toBe(1);
    expect(await draftsOf(pool, d.documentId)).toHaveLength(0);
    // B then runs normally.
    const runB = runnerB.execute(jobB);
    await b.entered;
    b.succeed();
    await runB;
    expect((await getDocument(pool, d.documentId)).status).toBe('ocr_ready');
    expect(await draftsOf(pool, d.documentId)).toHaveLength(1);
  });
});
