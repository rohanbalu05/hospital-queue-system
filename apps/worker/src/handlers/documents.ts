import { createHash } from 'node:crypto';
import { ALLOWED_MIME_TYPES, MAX_UPLOAD_BYTES, MAX_UPLOAD_PAGES } from '@hqms/contracts';
import { enqueueJob, withTransaction, writeAudit, writeOutbox, type Tx } from '@hqms/db';
import {
  StorageNotFoundError,
  TransientProviderError,
  createObjectStorage,
  createOcrProvider,
  isTransient,
  type ObjectStorage,
  type OcrProvider,
  type OcrResult,
} from '@hqms/providers';
import type { Pool } from 'pg';
import { errorSummary, type Logger } from '../log.js';
import { PermanentJobError, type HandlerResult, type JobContext, type JobHandler, type JobRow } from '../types.js';

/*
 * Document jobs (FR-12, FR-13, NFR-07, report 6.10).
 *
 *  ocr_document {documentId}
 *    tx1   short: lock the document row, check state, accepted|ocr_failed -> processing, ocr_attempts + 1, commit.
 *    ----  NO transaction and NO lock from here: read the object, call the OCR provider (it may hang or fail;
 *          nothing in the database is held, and booking/queue work never touches documents).
 *    tx2   short: lock the document row again, still 'processing' -> insert ONE ocr_drafts row, document ->
 *          ocr_ready, audit + DocumentOCRCompleted (no text in the event). Anything else is a no-op, so a
 *          redelivered or duplicate job never creates a second draft.
 *    error provider failure -> tx: document 'ocr_failed' with a text-free last_error + DocumentOCRFailed, then
 *          rethrow (transient: the runner backs off; dead after max attempts, document stays 'ocr_failed' and
 *          visible for manual review or a controlled retry) or PermanentJobError.
 *
 *  The draft is only a draft: nothing here creates or touches an instruction (FR-13).
 *
 *  Attempt fencing: the runner only logs a lost lease, so an attempt that lost its lease (a newer attempt
 *  re-claimed the job) can still reach its writes. Every document write above (tx1, tx2, failure) therefore
 *  first re-verifies, INSIDE the same transaction, that this attempt still owns the job:
 *    SELECT 1 FROM jobs WHERE id = $job AND state = 'running' AND lease_owner = $owner AND attempts = $attempt
 *      FOR NO KEY UPDATE
 *  No match = superseded: write nothing, log `ocr.superseded`, return { superseded: true } (the runner writes no
 *  outcome either). The check keys on the job lease, so it also holds when the same document is re-enqueued under
 *  a different job. Lock order in every OCR tx is job row, then document row; the runner's own statements are
 *  single autocommit UPDATEs on the job row that never touch a document, so there is no cycle. A claim racing the
 *  fenced tx skips the locked job row (SKIP LOCKED), so the attempt either wrote before the new claim or not at all.
 */

export interface DocumentDeps {
  storage(): ObjectStorage;
  ocr(): OcrProvider;
  /** The provider call is abandoned after this long (must be shorter than the runner's handler timeout). */
  ocrTimeoutMs: number;
}

/** Providers are resolved lazily from env on first use, so a worker that never sees a document job needs none. */
export function documentDeps(
  env: NodeJS.ProcessEnv = process.env,
  overrides: { storage?: ObjectStorage; ocr?: OcrProvider; ocrTimeoutMs?: number } = {},
): DocumentDeps {
  let storage = overrides.storage;
  let ocr = overrides.ocr;
  const timeout = Number(env['OCR_TIMEOUT_SEC'] ?? 90) * 1000;
  return {
    storage: () => (storage ??= createObjectStorage(env)),
    ocr: () => (ocr ??= createOcrProvider(env)),
    ocrTimeoutMs: overrides.ocrTimeoutMs ?? (Number.isFinite(timeout) && timeout > 0 ? timeout : 90_000),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireDocumentId(payload: Record<string, unknown>): string {
  const v = payload['documentId'];
  if (typeof v !== 'string' || !UUID.test(v)) throw new PermanentJobError('payload.documentId must be a uuid');
  return v;
}

interface DocRow {
  id: string;
  patient_id: string;
  status: string;
  storage_key: string;
  mime_type: string;
  size_bytes: number;
  page_count: number;
  content_hash: string;
  ocr_attempts: number;
  version: number;
}

const DOC_COLUMNS = `id, patient_id, status, storage_key, mime_type, size_bytes, page_count, content_hash, ocr_attempts, version`;

/** A document row change + audit (+ outbox) in the caller's transaction. Returns the new version. */
async function setStatus(
  tx: Tx,
  doc: DocRow,
  next: { status: string; lastError: string | null; incrementAttempts?: boolean },
  now: Date,
  audit: { operation: string; reason: string | null },
): Promise<number> {
  const res = await tx.query<{ version: number }>(
    `UPDATE documents
        SET status = $2, last_error = $3, ocr_attempts = ocr_attempts + $4, version = version + 1, updated_at = $5::timestamptz
      WHERE id = $1
      RETURNING version`,
    [doc.id, next.status, next.lastError, next.incrementAttempts ? 1 : 0, now.toISOString()],
  );
  const version = res.rows[0]?.version ?? doc.version + 1;
  await writeAudit(tx, {
    actorId: null,
    actorRole: 'system',
    operation: audit.operation,
    entityType: 'document',
    entityId: doc.id,
    previous: { status: doc.status, version: doc.version },
    next: { status: next.status, version },
    reason: audit.reason,
  });
  return version;
}

/**
 * Lock the job row if (and only if) `job`'s attempt still owns it. Must be the FIRST statement of an OCR
 * transaction (lock order: job, then document). Handlers get `leaseOwner`/`attempts` from the claim.
 */
async function ownsJob(tx: Tx, job: JobRow): Promise<boolean> {
  const res = await tx.query(
    `SELECT 1 FROM jobs WHERE id = $1 AND state = 'running' AND lease_owner = $2 AND attempts = $3 FOR NO KEY UPDATE`,
    [job.id, job.leaseOwner, job.attempts],
  );
  return (res.rowCount ?? 0) > 0;
}

const lockDocument = async (tx: Tx, id: string): Promise<DocRow | undefined> =>
  (await tx.query<DocRow>(`SELECT ${DOC_COLUMNS} FROM documents WHERE id = $1 FOR NO KEY UPDATE`, [id])).rows[0];

/** Race a provider call against an abort signal; the provider promise's late result is ignored. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal, what: string): Promise<T> {
  p.catch(() => undefined); // a late rejection after the abort must not be unhandled
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new TransientProviderError(`${what} timed out or was cancelled`));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** What tx1 decided. */
type Claimed = { skip: HandlerResult | 'noop' } | { doc: DocRow };

const SUPERSEDED = { superseded: true } as const;

export function createOcrDocumentHandler(deps: DocumentDeps): JobHandler {
  return async (job: JobRow, ctx: JobContext): Promise<HandlerResult> => {
    const documentId = requireDocumentId(job.payload);
    const log = ctx.log.child({ documentId });

    // tx1 ---------------------------------------------------------------------------------------------------
    const claimed: Claimed = await withTransaction(ctx.pool, async (tx): Promise<Claimed> => {
      const now = ctx.now();
      if (!(await ownsJob(tx, job))) return { skip: SUPERSEDED };
      const doc = await lockDocument(tx, documentId);
      if (!doc) return { skip: { cancelled: true, reason: 'document not found' } };
      switch (doc.status) {
        case 'accepted':
        case 'ocr_failed':
          break;
        case 'processing':
          // Our own failures leave 'ocr_failed', so 'processing' on a retry means the previous attempt's worker
          // died (lease expired). On a first attempt it is another job's work: leave it alone.
          if (job.attempts <= 1) return { skip: 'noop' };
          break;
        case 'uploaded':
          // Not accepted yet (the reconciler decides). Look again later without burning an attempt.
          return { skip: { retryAt: new Date(now.getTime() + 60_000) } };
        default:
          return { skip: 'noop' }; // ocr_ready, verified, rejected: nothing to do (idempotent redelivery)
      }
      // Validate type, size and pages once more (the table checks them too): a bad row is rejected for good.
      const invalid = !(ALLOWED_MIME_TYPES as readonly string[]).includes(doc.mime_type)
        ? 'unsupported file type'
        : doc.size_bytes > MAX_UPLOAD_BYTES
          ? 'file larger than 10 MB'
          : doc.page_count > MAX_UPLOAD_PAGES
            ? 'more than 10 pages'
            : null;
      if (invalid) {
        const version = await setStatus(tx, doc, { status: 'rejected', lastError: invalid }, now, {
          operation: 'document.rejected',
          reason: invalid,
        });
        await writeOutbox(tx, {
          eventType: 'DocumentOCRFailed',
          entityType: 'document',
          entityId: doc.id,
          entityVersion: version,
          patientId: doc.patient_id,
          payload: { final: true, rejected: true },
        });
        return { skip: { cancelled: true, reason: invalid } };
      }
      await setStatus(tx, doc, { status: 'processing', lastError: null, incrementAttempts: true }, now, {
        operation: 'document.ocr_started',
        reason: null,
      });
      return { doc };
    });
    if ('skip' in claimed) {
      if (claimed.skip === SUPERSEDED) log.warn('ocr.superseded', { phase: 'start', attempt: job.attempts });
      return claimed.skip === 'noop' ? undefined : claimed.skip;
    }
    const doc = claimed.doc;

    // No transaction, no lock: storage and the OCR provider -------------------------------------------------
    let result: OcrResult;
    try {
      let bytes: Buffer;
      try {
        bytes = await deps.storage().get(doc.storage_key);
      } catch (err) {
        if (err instanceof StorageNotFoundError) throw new PermanentJobError('object missing');
        throw err;
      }
      if (bytes.length !== doc.size_bytes || createHash('sha256').update(bytes).digest('hex') !== doc.content_hash) {
        throw new PermanentJobError('stored object does not match the recorded size or hash');
      }
      const abort = new AbortController();
      const onParentAbort = () => abort.abort();
      ctx.signal.addEventListener('abort', onParentAbort, { once: true });
      if (ctx.signal.aborted) abort.abort();
      const timer = setTimeout(() => abort.abort(), deps.ocrTimeoutMs);
      try {
        const provider = deps.ocr();
        result = await raceAbort(
          provider.extract({ bytes, mimeType: doc.mime_type, pageCount: doc.page_count }, { signal: abort.signal }),
          abort.signal,
          'OCR',
        );
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onParentAbort);
      }
    } catch (err) {
      if (!(await recordFailure(ctx, doc, job, err, log))) return SUPERSEDED;
      if (err instanceof PermanentJobError) throw err;
      if (isTransient(err)) throw err;
      throw new PermanentJobError(errorSummary(err, 300));
    }

    // tx2 ---------------------------------------------------------------------------------------------------
    const written = await withTransaction(ctx.pool, async (tx): Promise<'done' | 'superseded' | 'unchanged'> => {
      const now = ctx.now();
      if (!(await ownsJob(tx, job))) return 'superseded';
      const cur = await lockDocument(tx, documentId);
      if (!cur || cur.status !== 'processing') return 'unchanged'; // already finished or changed: never a second draft
      await tx.query(
        `INSERT INTO ocr_drafts (document_id, provider, text, blocks, created_at) VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)`,
        [documentId, result.provider, result.text, JSON.stringify(result.blocks), now.toISOString()],
      );
      const version = await setStatus(tx, cur, { status: 'ocr_ready', lastError: null }, now, {
        operation: 'document.ocr_completed',
        reason: null,
      });
      await writeOutbox(tx, {
        eventType: 'DocumentOCRCompleted',
        entityType: 'document',
        entityId: documentId,
        entityVersion: version,
        patientId: cur.patient_id,
        payload: { provider: result.provider, blocks: result.blocks.length },
      });
      return 'done';
    });
    if (written === 'superseded') {
      log.warn('ocr.superseded', { phase: 'complete', attempt: job.attempts });
      return SUPERSEDED;
    }
    if (written === 'unchanged') log.warn('ocr.document_not_processing', { attempt: job.attempts });
    else log.info('ocr.completed', { provider: result.provider, blocks: result.blocks.length });
    return undefined;
  };
}

/**
 * Short tx after a provider failure: 'ocr_failed' + text-free last_error + DocumentOCRFailed. Returns false when
 * this attempt was superseded (nothing written; the caller must not report a failure for the replacement's job).
 */
async function recordFailure(ctx: JobContext, doc: DocRow, job: JobRow, err: unknown, log: Logger): Promise<boolean> {
  const summary = errorSummary(err, 300);
  const final = !isTransient(err) || err instanceof PermanentJobError || job.attempts >= job.maxAttempts;
  const owned = await withTransaction(ctx.pool, async (tx): Promise<boolean> => {
    if (!(await ownsJob(tx, job))) return false;
    const cur = await lockDocument(tx, doc.id);
    if (!cur || cur.status !== 'processing') return true;
    const version = await setStatus(tx, cur, { status: 'ocr_failed', lastError: summary }, ctx.now(), {
      operation: 'document.ocr_failed',
      reason: summary,
    });
    await writeOutbox(tx, {
      eventType: 'DocumentOCRFailed',
      entityType: 'document',
      entityId: doc.id,
      entityVersion: version,
      patientId: cur.patient_id,
      payload: { attempt: job.attempts, final },
    });
    return true;
  });
  if (!owned) {
    log.warn('ocr.superseded', { phase: 'failure', attempt: job.attempts });
    return false;
  }
  log.warn('ocr.failed', { error: summary, attempt: job.attempts, final });
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// reconcile_uploads
// ---------------------------------------------------------------------------------------------------------------

/** Tunables of the reconciler (report 6.10). */
export const RECONCILE = {
  /** An 'uploaded' document older than this is decided: object present -> accepted, absent -> rejected. */
  uploadedGraceMs: 15 * 60_000,
  /** An object with no documents row is abandoned once it is older than this. */
  orphanGraceMs: 60 * 60_000,
  /** An 'accepted' document without an active ocr_document job is re-enqueued after this. */
  missingJobGraceMs: 5 * 60_000,
  /** 'processing' with no job left to finish it is marked ocr_failed after this. */
  stalledProcessingMs: 30 * 60_000,
  batch: 200,
} as const;

const pad = (n: number) => String(n).padStart(2, '0');

/** `yyyy-mm-dd-hh` (UTC): the dedupe bucket of one reconcile_uploads run. */
export function reconcileBucket(at: Date): string {
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}-${pad(at.getUTCHours())}`;
}

export const reconcileDedupeKey = (at: Date) => `reconcile_uploads:${reconcileBucket(at)}`;

const startOfNextHour = (at: Date) => new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000 + 3_600_000);

/**
 * Make sure a reconcile_uploads job exists for the current hour (idempotent: same dedupe key). The worker calls
 * this at start-up and on a slow timer as a safety net for the self-rescheduling chain.
 */
export async function ensureReconcileJob(pool: Pool, now: Date = new Date()): Promise<boolean> {
  return withTransaction(pool, async (tx) => {
    const id = await enqueueJob(tx, {
      jobType: 'reconcile_uploads',
      payload: {},
      runAt: now,
      dedupeKey: reconcileDedupeKey(now),
    });
    return id !== null;
  });
}

export interface ReconcileCounts {
  accepted: number;
  rejected: number;
  orphansDeleted: number;
  jobsEnqueued: number;
  stalledProcessing: number;
}

export async function reconcileUploads(
  pool: Pool,
  deps: DocumentDeps,
  now: Date,
  log: Logger,
): Promise<ReconcileCounts> {
  const counts: ReconcileCounts = {
    accepted: 0,
    rejected: 0,
    orphansDeleted: 0,
    jobsEnqueued: 0,
    stalledProcessing: 0,
  };
  const storage = deps.storage();
  const bucket = reconcileBucket(now);

  // (a) 'uploaded' too long: the object decides. Storage is consulted with no lock held.
  const stale = await pool.query<{ id: string; storage_key: string; size_bytes: number }>(
    `SELECT id, storage_key, size_bytes FROM documents
      WHERE status = 'uploaded' AND created_at < $1::timestamptz
      ORDER BY created_at LIMIT $2`,
    [new Date(now.getTime() - RECONCILE.uploadedGraceMs).toISOString(), RECONCILE.batch],
  );
  for (const row of stale.rows) {
    const head = await storage.head(row.storage_key);
    const verdict: { status: 'accepted' | 'rejected'; error: string | null } = !head
      ? { status: 'rejected', error: 'object missing' }
      : head.size !== row.size_bytes
        ? { status: 'rejected', error: 'object size does not match the upload' }
        : { status: 'accepted', error: null };
    const changed = await withTransaction(pool, async (tx) => {
      const doc = await lockDocument(tx, row.id);
      if (!doc || doc.status !== 'uploaded') return false; // the API finished it meanwhile
      const version = await setStatus(tx, doc, { status: verdict.status, lastError: verdict.error }, now, {
        operation: `document.reconcile_${verdict.status}`,
        reason: verdict.error ?? 'object present, upload accepted by the reconciler',
      });
      if (verdict.status === 'accepted') {
        await enqueueJob(tx, {
          jobType: 'ocr_document',
          payload: { documentId: doc.id },
          dedupeKey: `ocr_document:${doc.id}`,
        });
      } else {
        await writeOutbox(tx, {
          eventType: 'DocumentOCRFailed',
          entityType: 'document',
          entityId: doc.id,
          entityVersion: version,
          patientId: doc.patient_id,
          payload: { final: true, rejected: true },
        });
      }
      return true;
    });
    if (changed) counts[verdict.status === 'accepted' ? 'accepted' : 'rejected']++;
  }

  // (b) objects with no documents row, older than 1 h: abandoned uploads.
  const keys = await storage.list('documents/');
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const known = await pool.query<{ storage_key: string }>(
      `SELECT storage_key FROM documents WHERE storage_key = ANY($1::text[])`,
      [chunk],
    );
    const have = new Set(known.rows.map((r) => r.storage_key));
    for (const key of chunk) {
      if (have.has(key)) continue;
      const head = await storage.head(key);
      if (!head || now.getTime() - head.modifiedAt.getTime() < RECONCILE.orphanGraceMs) continue;
      // Re-check right before deleting: a row may have been committed since the listing.
      const again = await pool.query(`SELECT 1 FROM documents WHERE storage_key = $1`, [key]);
      if (again.rowCount) continue;
      await storage.delete(key);
      counts.orphansDeleted++;
    }
  }

  // (c) 'accepted' with no pending/running/failed ocr_document job: missing job intent.
  const missing = await pool.query<{ id: string }>(
    `SELECT d.id FROM documents d
      WHERE d.status = 'accepted' AND d.updated_at < $1::timestamptz
        AND NOT EXISTS (SELECT 1 FROM jobs j
                         WHERE j.job_type = 'ocr_document' AND j.payload->>'documentId' = d.id::text
                           AND j.state IN ('pending', 'running', 'failed'))
      ORDER BY d.updated_at LIMIT $2`,
    [new Date(now.getTime() - RECONCILE.missingJobGraceMs).toISOString(), RECONCILE.batch],
  );
  for (const row of missing.rows) {
    const enqueued = await withTransaction(pool, async (tx) => {
      const doc = await lockDocument(tx, row.id);
      if (!doc || doc.status !== 'accepted') return false;
      const id = await enqueueJob(tx, {
        jobType: 'ocr_document',
        payload: { documentId: doc.id },
        dedupeKey: `ocr_document:${doc.id}:reconcile:${bucket}`,
      });
      return id !== null;
    });
    if (enqueued) counts.jobsEnqueued++;
  }

  // (d) 'processing' that nothing is working on any more (worker died and the job is dead): visible failure.
  const stalled = await pool.query<{ id: string }>(
    `SELECT d.id FROM documents d
      WHERE d.status = 'processing' AND d.updated_at < $1::timestamptz
        AND NOT EXISTS (SELECT 1 FROM jobs j
                         WHERE j.job_type = 'ocr_document' AND j.payload->>'documentId' = d.id::text
                           AND j.state IN ('pending', 'running', 'failed'))
      ORDER BY d.updated_at LIMIT $2`,
    [new Date(now.getTime() - RECONCILE.stalledProcessingMs).toISOString(), RECONCILE.batch],
  );
  for (const row of stalled.rows) {
    const changed = await withTransaction(pool, async (tx) => {
      const doc = await lockDocument(tx, row.id);
      if (!doc || doc.status !== 'processing') return false;
      const version = await setStatus(
        tx,
        doc,
        { status: 'ocr_failed', lastError: 'processing stalled: no worker finished the job' },
        now,
        {
          operation: 'document.reconcile_stalled',
          reason: 'processing stalled',
        },
      );
      await writeOutbox(tx, {
        eventType: 'DocumentOCRFailed',
        entityType: 'document',
        entityId: doc.id,
        entityVersion: version,
        patientId: doc.patient_id,
        payload: { final: true },
      });
      return true;
    });
    if (changed) counts.stalledProcessing++;
  }

  log.info('reconcile_uploads.done', { ...counts });
  return counts;
}

/** reconcile_uploads {}: runs one reconciliation pass, then schedules the next hour's run (durable chain). */
export function createReconcileUploadsHandler(deps: DocumentDeps): JobHandler {
  return async (_job: JobRow, ctx: JobContext): Promise<HandlerResult> => {
    const now = ctx.now();
    await reconcileUploads(ctx.pool, deps, now, ctx.log);
    const next = startOfNextHour(now);
    await withTransaction(ctx.pool, async (tx) => {
      await enqueueJob(tx, {
        jobType: 'reconcile_uploads',
        payload: {},
        runAt: next,
        dedupeKey: reconcileDedupeKey(next),
      });
    });
    return undefined;
  };
}
