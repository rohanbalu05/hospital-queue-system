/**
 * T4 / NFR-07 (report Table 5, FR-12): OCR provider and worker failures never interrupt core booking or the queue.
 *
 * The REAL worker process (apps/worker/dist, document jobs only, backoff capped at 1 s) runs against the same
 * database and storage directory as the API child. The fake OCR provider fails for the `fail` fixture and succeeds
 * for the others.
 *
 *  1. a document whose OCR fails: bounded retries (5 attempts), then `ocr_failed` + a dead job, visible to staff;
 *     meanwhile bookings, check-ins, walk-ins and the full call-next -> start -> complete cycle for OTHER patients
 *     keep succeeding with no 5xx;
 *  2. controlled retry: retry-ocr re-enqueues (version-guarded, role-guarded), the state stays visible;
 *  3. worker down: an upload is accepted and its job stays durable and pending while core operations continue;
 *     starting the worker later completes the OCR (jobs survive restarts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { percentile, type ApiClient } from '../support/client.js';
import { fixtureDocument, startWorker, uploadDocument, waitFor, type RunningWorker } from '../support/followup.js';
import { recordResult, T4_RESULTS_FILE } from '../support/results.js';
import {
  book,
  checkGlobalInvariants,
  closePool,
  databaseUrl,
  loginAs,
  makeFutureSession,
  makeRunningSession,
  registerPatients,
  seededPatientId,
  sqlRows,
  type MadeSession,
} from '../support/world.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

let admin: ApiClient;
let reception: ApiClient;
let doctor3: ApiClient;
let doctor2: ApiClient;
let followup: ApiClient;
let patient5: ApiClient;
let patient6: ApiClient;
let worker: RunningWorker;
let session: MadeSession;
let futureSession: MadeSession;
const P5 = seededPatientId(5);
const record: Record<string, unknown> = {};
const coreLatencies: number[] = [];
const coreStatuses: Record<string, number> = {};
let coreCycles = 0;
let futureUses = 0;
let coreServerErrors = 0;

function note(res: { status: number; ms: number }): void {
  coreLatencies.push(res.ms);
  coreStatuses[res.status] = (coreStatuses[res.status] ?? 0) + 1;
  if (res.status >= 500) coreServerErrors += 1;
}

/** One complete core cycle for a fresh patient: reception books a future place, a walk-in is admitted and served. */
async function coreCycle(): Promise<void> {
  const [pid] = await registerPatients(reception, 1, 'T4 isolation');
  // A session has a fixed slot grid (about a dozen places): move to a fresh future session every 8 bookings.
  if (futureUses >= 8) {
    futureSession = await makeFutureSession(admin, { doctor: 3 });
    futureUses = 0;
  }
  futureUses += 1;
  const booked = await book(reception, futureSession.id, pid);
  note(booked);
  expect(booked.status, JSON.stringify(booked.body)).toBe(201);
  const w = await reception.post(`/sessions/${session.id}/walk-ins`, { patientId: pid });
  note(w);
  expect(w.status, JSON.stringify(w.body)).toBe(201);
  const call = await doctor3.post(`/sessions/${session.id}/call-next`, {});
  note(call);
  expect(call.status, JSON.stringify(call.body)).toBe(200);
  const visitId = call.body.entry.visitId as string;
  const started = await doctor3.post(`/visits/${visitId}/start`, {});
  note(started);
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const done = await doctor3.post(`/visits/${visitId}/complete`, {});
  note(done);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  coreCycles += 1;
}

const docState = async (id: string): Promise<any> =>
  (await sqlRows(`SELECT status, ocr_attempts, last_error, version FROM documents WHERE id = $1`, [id]))[0];
const jobsOf = (id: string): Promise<any[]> =>
  sqlRows(
    `SELECT state, attempts, max_attempts, dedupe_key, last_error FROM jobs WHERE job_type = 'ocr_document' AND payload->>'documentId' = $1 ORDER BY created_at, id`,
    [id],
  );

beforeAll(async () => {
  [admin, reception, doctor3, doctor2, followup, patient5, patient6] = await Promise.all([
    loginAs('admin@hqms.test'),
    loginAs('reception@hqms.test'),
    loginAs('doctor3@hqms.test'),
    loginAs('doctor2@hqms.test'),
    loginAs('followup@hqms.test'),
    loginAs('patient5@hqms.test'),
    loginAs('patient6@hqms.test'),
  ]);
  session = await makeRunningSession(admin, { doctor: 3, startOffsetMin: -12, walkin: 60 });
  futureSession = await makeFutureSession(admin, { doctor: 3 });
  worker = await startWorker(databaseUrl());
}, 180_000);

let secondWorker: RunningWorker | undefined;
afterAll(async () => {
  await worker?.stop();
  await secondWorker?.stop();
  const invariants = await checkGlobalInvariants();
  const logs = [...(worker?.logs ?? []), ...(secondWorker?.logs ?? [])];
  const errorMsgs: Record<string, number> = {};
  for (const l of logs) {
    if (!/"level":"error"/.test(l)) continue;
    const msg = /"msg":"([^"]+)"/.exec(l)?.[1] ?? 'unknown';
    errorMsgs[msg] = (errorMsgs[msg] ?? 0) + 1;
  }
  // The only error-level worker lines are the three exhausted (dead) OCR jobs; no log line carries OCR text.
  const clinicalLeak = logs.some((l) => /Paracetamol|Pantoprazole|Haemoglobin/i.test(l));
  recordResult(
    't4OcrFailureIsolation',
    {
      ...record,
      coreOperations: {
        cycles: coreCycles,
        requests: coreLatencies.length,
        statuses: coreStatuses,
        serverErrors: coreServerErrors,
        latencyMs: {
          p50: Math.round(percentile(coreLatencies, 50)),
          p95: Math.round(percentile(coreLatencies, 95)),
          max: Math.round(Math.max(...coreLatencies)),
        },
      },
      workerErrorLogs: errorMsgs,
      workerLogsContainClinicalText: clinicalLeak,
      globalInvariantViolations: invariants.violations,
    },
    T4_RESULTS_FILE,
  );
  await closePool();
  expect(Object.keys(errorMsgs).filter((m) => m !== 'job.dead')).toEqual([]);
  expect(errorMsgs['job.dead']).toBe(3);
  expect(clinicalLeak).toBe(false);
});

describe('T4.9 OCR failure is bounded, visible, and does not interrupt core operations (NFR-07)', () => {
  let failedDoc: any;

  it('the failing document ends ocr_failed after bounded retries while bookings and the queue keep working', async () => {
    const up = await uploadDocument(patient5, undefined, fixtureDocument('fail'));
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    failedDoc = up.body;
    const t0 = Date.now();

    // Run core cycles for as long as the OCR job is still being retried (at least 3, at most 40).
    const attemptsSeen = new Set<number>();
    for (let i = 0; i < 40; i += 1) {
      await coreCycle();
      const jobs = await jobsOf(failedDoc.id);
      for (const j of jobs) attemptsSeen.add(j.attempts);
      if (i >= 2 && jobs.length === 1 && jobs[0]?.state === 'dead') break;
    }
    // let the retries finish if the cycles were faster than the backoff
    const dead = await waitFor(
      'ocr job to be dead',
      async () => {
        const jobs = await jobsOf(failedDoc.id);
        return jobs.length === 1 && jobs[0]?.state === 'dead' ? jobs[0] : null;
      },
      30_000,
    );
    record['ocrFailureWallMs'] = Date.now() - t0;
    expect(dead.attempts).toBe(dead.max_attempts);
    expect(dead.max_attempts).toBe(5);
    expect(attemptsSeen.size).toBeGreaterThan(0);

    const doc = await docState(failedDoc.id);
    expect(doc.status).toBe('ocr_failed');
    expect(doc.ocr_attempts).toBe(5);
    expect(doc.last_error).toBeTruthy();
    expect(await sqlRows(`SELECT 1 FROM ocr_drafts WHERE document_id = $1`, [failedDoc.id])).toHaveLength(0);
    expect(coreCycles).toBeGreaterThanOrEqual(3);
    expect(coreServerErrors).toBe(0);
    expect(Object.keys(coreStatuses).every((s) => Number(s) < 300)).toBe(true);
    record['failedDocument'] = { finalStatus: doc.status, attempts: doc.ocr_attempts, jobState: dead.state };
  });

  it('staff see the failure (inbox, document, audit); the patient sees a status without internal error text', async () => {
    // patient 5 is linked to doctor 2 (seed): doctor2, follow-up and reception (all doctors) are in scope
    const inbox = await doctor2.get('/review-inbox');
    const item = (inbox.body as any[]).find((d) => d.id === failedDoc.id);
    expect(item, 'failed document in the doctor review inbox').toBeDefined();
    expect(item.status).toBe('ocr_failed');
    expect(item.lastError).toBeTruthy();
    for (const c of [followup, reception]) {
      const g = await c.get(`/documents/${failedDoc.id}`);
      expect(g.status).toBe(200);
      expect(g.body.status).toBe('ocr_failed');
      expect(g.body.lastError).toBeTruthy();
    }
    const own = await patient5.get(`/documents/${failedDoc.id}`);
    expect(own.body.status).toBe('ocr_failed');
    expect(own.body.lastError).toBeNull();
    const audit = await sqlRows(
      `SELECT operation FROM audit_events WHERE entity_type = 'document' AND entity_id = $1 ORDER BY id`,
      [failedDoc.id],
    );
    const ops = audit.map((a) => a['operation'] as string);
    expect(ops.filter((o) => o === 'document.ocr_failed')).toHaveLength(5);
    expect(ops.filter((o) => o === 'document.ocr_started')).toHaveLength(5);
    expect(ops[0]).toBe('document.upload');
    // the failure never produced an instruction
    expect(
      (
        await sqlRows(`SELECT count(*)::int AS n FROM instructions WHERE patient_id = $1 AND document_id = $2`, [
          P5,
          failedDoc.id,
        ])
      )[0]?.['n'],
    ).toBe(0);
  });

  it('a doctor can still review it manually: the failed document may be verified from a typed transcription', async () => {
    const r = await doctor2.post(`/documents/${failedDoc.id}/verify`, {
      title: 'Manual transcription',
      body: 'Take one tablet of the prescribed medicine after food for three days.',
    });
    // Observation, not a precondition: FR-12 says OCR failure "permits review or controlled retry".
    record['manualReviewOfFailedDocument'] = { status: r.status, code: r.body?.error?.code ?? null };
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await docState(failedDoc.id)).status).toBe('verified');
  });
});

describe('T4.10 controlled retry (FR-12)', () => {
  let doc2: any;

  it('retry-ocr is staff-only, version-guarded, re-enqueues once and leaves the state visible', async () => {
    const up = await uploadDocument(patient6, undefined, fixtureDocument('fail'));
    expect(up.status).toBe(201);
    doc2 = up.body;
    await waitFor(
      'second failing job dead',
      async () => {
        const jobs = await jobsOf(doc2.id);
        return jobs.length === 1 && jobs[0]?.state === 'dead' ? true : null;
      },
      30_000,
    );
    const failed = await docState(doc2.id);
    expect(failed.status).toBe('ocr_failed');

    // patients cannot retry; a retry with a stale version is refused
    expect((await patient6.post(`/documents/${doc2.id}/retry-ocr`, { expectedVersion: failed.version })).status).toBe(
      403,
    );
    expect(
      (await reception.post(`/documents/${doc2.id}/retry-ocr`, { expectedVersion: failed.version + 3 })).status,
    ).toBe(409);

    const retry = await reception.post(`/documents/${doc2.id}/retry-ocr`, { expectedVersion: failed.version });
    expect(retry.status, JSON.stringify(retry.body)).toBe(202);
    expect(retry.body.version).toBe(failed.version + 1);
    // the same expected version again (a double click) is a conflict
    expect((await reception.post(`/documents/${doc2.id}/retry-ocr`, { expectedVersion: failed.version })).status).toBe(
      409,
    );

    const jobs = await waitFor(
      'retry job picked up and exhausted',
      async () => {
        const j = await jobsOf(doc2.id);
        return j.length === 2 && j.every((x) => x.state === 'dead') ? j : null;
      },
      30_000,
    );
    expect(jobs[1]?.dedupe_key).toContain(':retry:');
    expect(jobs[1]?.attempts).toBe(5);
    // still visible and still failed (the fixture fails deterministically): no draft, no silent success
    const after = await docState(doc2.id);
    expect(after.status).toBe('ocr_failed');
    expect(after.ocr_attempts).toBe(10);
    expect(await sqlRows(`SELECT 1 FROM ocr_drafts WHERE document_id = $1`, [doc2.id])).toHaveLength(0);
    const audit = await sqlRows(
      `SELECT count(*)::int AS n FROM audit_events WHERE entity_id = $1 AND operation = 'document.retry_ocr'`,
      [doc2.id],
    );
    expect(audit[0]?.['n']).toBe(1);
    record['retry'] = {
      retryStatus: retry.status,
      jobsAfterRetry: jobs.length,
      finalStatus: after.status,
      attempts: after.ocr_attempts,
    };
  });

  it('a document that is not failed cannot be retried', async () => {
    const ok = await uploadDocument(patient6, undefined, fixtureDocument('lab-note'));
    expect(ok.status).toBe(201);
    await waitFor('lab note ocr_ready', async () =>
      (await docState(ok.body.id)).status === 'ocr_ready' ? true : null,
    );
    const r = await reception.post(`/documents/${ok.body.id}/retry-ocr`, {
      expectedVersion: (await docState(ok.body.id)).version,
    });
    expect(r.status).toBe(409);
    // garbage fixture: low-confidence noise is still only a draft and ends ocr_ready (review decides)
    const g = await uploadDocument(patient6, undefined, fixtureDocument('garbage'));
    await waitFor('garbage ocr_ready', async () => ((await docState(g.body.id)).status === 'ocr_ready' ? true : null));
    expect(
      (await sqlRows(`SELECT count(*)::int AS n FROM instructions WHERE document_id = $1`, [g.body.id]))[0]?.['n'],
    ).toBe(0);
  });
});

describe('T4.11 worker down: jobs are durable and core operations continue (NFR-07)', () => {
  it('an upload made while the worker is stopped stays accepted with a pending job; the worker later finishes it', async () => {
    await worker.stop();
    const before = coreCycles;
    const up = await uploadDocument(patient6, undefined, fixtureDocument('prescription-printed'));
    expect(up.status).toBe(201);
    expect(up.body.status).toBe('accepted');
    for (let i = 0; i < 3; i += 1) await coreCycle();
    expect(coreCycles).toBe(before + 3);
    // nothing processed it while no worker was running
    const waiting = await docState(up.body.id);
    expect(waiting.status).toBe('accepted');
    expect(waiting.ocr_attempts).toBe(0);
    const jobs = await jobsOf(up.body.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.state).toBe('pending');

    secondWorker = await startWorker(databaseUrl());
    const ready = await waitFor('ocr_ready after the worker restarted', async () => {
      const d = await docState(up.body.id);
      return d.status === 'ocr_ready' ? d : null;
    });
    expect(ready.ocr_attempts).toBe(1);
    expect((await jobsOf(up.body.id))[0]?.state).toBe('succeeded');
    expect(await sqlRows(`SELECT 1 FROM ocr_drafts WHERE document_id = $1`, [up.body.id])).toHaveLength(1);
    expect(coreServerErrors).toBe(0);
    record['workerDown'] = {
      documentStatusWhileDown: 'accepted',
      jobStateWhileDown: 'pending',
      afterRestart: 'ocr_ready',
    };
  });
});
