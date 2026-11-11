/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, DocumentMeta, InstructionVersion } from '@hqms/contracts';
import {
  type Client,
  count,
  createTestApp,
  linkPatient,
  loginAs,
  makeSession,
  patientId,
  type TestApp,
} from './helpers.js';
import { MemoryStorage, makePdf, makePng, openApiTransactions } from './fakes.js';

let t: TestApp;
let storage: MemoryStorage;
let admin: Client;
let reception: Client; // doctors 1-10
let reception3: Client; // doctors 3 and 4 only
let doctor1: Client;
let doctor2: Client;
let followup: Client;
let patient1: Client;
let patient2: Client;

beforeAll(async () => {
  storage = new MemoryStorage();
  t = await createTestApp({ storage });
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  reception3 = await loginAs(t.server, 'reception3@hqms.test');
  doctor1 = await loginAs(t.server, 'doctor@hqms.test');
  doctor2 = await loginAs(t.server, 'doctor2@hqms.test');
  followup = await loginAs(t.server, 'followup@hqms.test');
  patient1 = await loginAs(t.server, 'patient@hqms.test');
  patient2 = await loginAs(t.server, 'patient2@hqms.test');
  // patient 1 is cared for by doctor 1 only
  await linkPatient(admin, reception, patientId(1), 1);
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  t.clock.reset();
  storage.failNextPut = false;
  delete storage.onCall;
});

const code = (body: unknown): string => ApiError.parse(body).error.code;
const P1 = patientId(1);

async function upload(by: Client, file: Buffer, patient = P1, name = 'scan.png', type = 'image/png') {
  return by.upload('/documents', file, { patientId: patient }, name, type);
}

/** An uploaded document made reviewable: OCR is the worker's job, so the test plays the worker. */
async function readyDocument(text = 'Amoxicillin 500 mg twice daily'): Promise<{ id: string; draftId: string }> {
  const res = await upload(patient1, makePng());
  expect(res.status).toBe(201);
  const id = res.body.id as string;
  const draft = await t.pool.query<{ id: string }>(
    `INSERT INTO ocr_drafts (document_id, provider, text, blocks) VALUES ($1, 'fake', $2, '[]') RETURNING id`,
    [id, text],
  );
  await t.pool.query(`UPDATE documents SET status = 'ocr_ready', version = version + 1 WHERE id = $1`, [id]);
  return { id, draftId: draft.rows[0]!.id };
}

describe('FR-12 upload flow (report 6.10)', () => {
  it('stores privately, then accepts: row, object, ocr_document job, DocumentUploaded and audit commit as designed', async () => {
    const png = makePng(500);
    const res = await upload(patient1, png, P1, 'My Prescription.png');
    expect(res.status).toBe(201);
    const doc = DocumentMeta.parse(res.body);
    expect(doc).toMatchObject({ patientId: P1, status: 'accepted', mimeType: 'image/png', pageCount: 1, originalName: 'My Prescription.png' });
    expect(JSON.stringify(res.body)).not.toMatch(/storage|content_?hash|documents\//i);

    const key = `documents/${P1}/${doc.id}`;
    expect(storage.objects.get(key)?.equals(png)).toBe(true);
    const row = (await t.pool.query(`SELECT storage_key, content_hash, size_bytes, uploaded_by FROM documents WHERE id = $1`, [doc.id])).rows[0]!;
    expect(row).toMatchObject({ storage_key: key, size_bytes: png.length });
    expect(row.content_hash).toBe(createHash('sha256').update(png).digest('hex'));
    const job = await t.pool.query(`SELECT job_type, payload, state FROM jobs WHERE dedupe_key = $1`, [`ocr_document:${doc.id}`]);
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0]).toMatchObject({ job_type: 'ocr_document', payload: { documentId: doc.id }, state: 'pending' });
    const ev = await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'DocumentUploaded' AND entity_id = $1`, [doc.id]);
    expect(ev.rows).toHaveLength(1);
    expect(await count(t.pool, `SELECT 1 FROM audit_events WHERE operation = 'document.upload' AND entity_id = $1`, [doc.id])).toBe(1);
  });

  it('the object write happens with no database transaction open', async () => {
    let open = -1;
    storage.onCall = async () => {
      open = await openApiTransactions(t.pool);
    };
    expect((await upload(patient1, makePng())).status).toBe(201);
    expect(open).toBe(0);
  });

  it('a failed object write leaves the row uploaded, with no job and no event, and a controlled 503', async () => {
    storage.failNextPut = true;
    const before = await count(t.pool, `SELECT 1 FROM documents WHERE patient_id = $1 AND status = 'uploaded'`, [P1]);
    const res = await upload(patient1, makePng(77));
    expect(res.status).toBe(503);
    expect(code(res.body)).toBe('INTERNAL');
    expect(await count(t.pool, `SELECT 1 FROM documents WHERE patient_id = $1 AND status = 'uploaded'`, [P1])).toBe(before + 1);
    const orphan = (await t.pool.query(`SELECT id FROM documents WHERE patient_id = $1 AND status = 'uploaded' ORDER BY created_at DESC LIMIT 1`, [P1])).rows[0]!;
    expect(await count(t.pool, `SELECT 1 FROM jobs WHERE dedupe_key = $1`, [`ocr_document:${orphan.id}`])).toBe(0);
    expect(await count(t.pool, `SELECT 1 FROM outbox_events WHERE entity_id = $1`, [orphan.id])).toBe(0);
  });

  it('FR-12-a: size, real type and page limits are enforced before anything is stored', async () => {
    const docsBefore = await count(t.pool, `SELECT 1 FROM documents`);
    const objectsBefore = storage.objects.size;

    const big = Buffer.concat([makePng(), Buffer.alloc(11 * 1024 * 1024, 1)]);
    const tooLarge = await upload(patient1, big);
    expect(tooLarge.status).toBe(413);
    expect(code(tooLarge.body)).toBe('UPLOAD_TOO_LARGE');

    const eleven = await upload(patient1, makePdf(11), P1, 'big.pdf', 'application/pdf');
    expect(eleven.status).toBe(400);
    expect(code(eleven.body)).toBe('UPLOAD_TOO_MANY_PAGES');

    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]);
    const renamed = await upload(patient1, exe, P1, 'invoice.pdf', 'application/pdf');
    expect(renamed.status).toBe(415);
    expect(code(renamed.body)).toBe('UNSUPPORTED_MEDIA_TYPE');
    // The header says PDF but the bytes are a PNG: refused too.
    expect((await upload(patient1, makePng(), P1, 'x.pdf', 'application/pdf')).status).toBe(415);
    // A text file, with an honest header
    expect((await upload(patient1, Buffer.from('hello there'), P1, 'a.txt', 'text/plain')).status).toBe(415);
    // Empty file
    expect((await upload(patient1, Buffer.alloc(0), P1, 'e.png', 'image/png')).status).toBe(400);

    expect(await count(t.pool, `SELECT 1 FROM documents`)).toBe(docsBefore);
    expect(storage.objects.size).toBe(objectsBefore);
    expect(await count(t.pool, `SELECT 1 FROM jobs WHERE job_type = 'ocr_document' AND created_at > now() - interval '1 minute' AND payload->>'documentId' IS NULL`)).toBe(0);

    // The boundary values are accepted: 10 pages, and a JPEG.
    const ten = await upload(patient1, makePdf(10), P1, 'ten.pdf', 'application/pdf');
    expect(ten.status).toBe(201);
    expect(ten.body.pageCount).toBe(10);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50, 3)]);
    expect((await upload(patient1, jpeg, P1, 'p.jpg', 'image/jpeg')).status).toBe(201);
    // No file at all, and a visit of another patient
    expect((await patient1.post('/documents', {}, null)).status).toBe(400);
  });

  it('who may upload for whom: patients only for themselves, staff only for patients in scope', async () => {
    expect((await upload(patient2, makePng(), P1)).status).toBe(404); // not their record
    expect((await upload(reception3, makePng(), P1)).status).toBe(404); // reception3 serves doctors 3-4
    expect((await upload(doctor2, makePng(), P1)).status).toBe(404);
    expect((await upload(reception, makePng(), P1)).status).toBe(201);
    expect((await upload(doctor1, makePng(), P1)).status).toBe(201);
    expect((await upload(followup, makePng(), P1)).status).toBe(201);
    const unknownVisit = await patient1.upload('/documents', makePng(), { patientId: P1, visitId: '00000000-0000-4000-8000-000000000001' });
    expect(unknownVisit.status).toBe(400);
    expect((await patient1.get('/documents')).status).toBe(200); // patient defaults to own
  });
});

describe('FR-12-c / FR-01-a document access', () => {
  it('another patient gets 404 for metadata, file, drafts and lists; out-of-scope staff the same', async () => {
    const { id } = await readyDocument();
    for (const path of [`/documents/${id}`, `/documents/${id}/file`]) {
      expect((await patient2.get(path)).status).toBe(404);
    }
    expect((await patient2.get(`/documents/${id}/drafts`)).status).toBe(403); // patients never see drafts at all
    expect((await patient2.get(`/documents?patientId=${P1}`)).status).toBe(404);
    expect((await patient2.get('/documents')).body).toEqual([]);
    for (const [who, label] of [
      [reception3, 'reception out of scope'],
      [doctor2, 'other doctor'],
    ] as const) {
      expect((await who.get(`/documents/${id}`)).status, label).toBe(404);
      expect((await who.get(`/documents?patientId=${P1}`)).status, label).toBe(404);
    }
    expect((await doctor2.get(`/documents/${id}/file`)).status).toBe(404);
    expect((await doctor2.get(`/documents/${id}/drafts`)).status).toBe(404);
    // In scope: owner, doctor, followup, admin; reception sees metadata only
    expect((await patient1.get(`/documents/${id}`)).status).toBe(200);
    expect((await doctor1.get(`/documents/${id}`)).status).toBe(200);
    expect((await reception.get(`/documents/${id}`)).status).toBe(200);
    expect((await reception.get(`/documents/${id}/file`)).status).toBe(403);
    expect((await reception.get(`/documents/${id}/drafts`)).status).toBe(403);
    expect((await patient1.get(`/documents/${id}/drafts`)).status).toBe(403);
    expect((await patient2.get('/documents/not-a-uuid')).status).toBe(400);
  });

  it('the file streams with private no-store headers and the real bytes; staff downloads are audited', async () => {
    const png = makePng(333);
    const up = await upload(patient1, png, P1, 'weird "name".png');
    const id = up.body.id as string;
    const own = await patient1.get(`/documents/${id}/file`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toBe('image/png');
    expect(own.headers['content-disposition']).toMatch(/^attachment;/);
    expect(own.headers['content-disposition']).not.toMatch(/"name"/);
    expect(own.headers['cache-control']).toBe('private, no-store');
    expect((own.body as Buffer).equals(png)).toBe(true);
    expect((await doctor1.get(`/documents/${id}/file`)).status).toBe(200);
    expect(await count(t.pool, `SELECT 1 FROM audit_events WHERE operation = 'document.download' AND entity_id = $1`, [id])).toBe(1);
    // A document whose bytes never arrived has no file
    storage.objects.delete(`documents/${P1}/${id}`);
    expect((await patient1.get(`/documents/${id}/file`)).status).toBe(404);
  });

  it('drafts are staff-only and carry the isDraft marker; the review inbox lists ocr_ready and ocr_failed for the doctor', async () => {
    const { id } = await readyDocument('Draft text: Paracetamol');
    const drafts = await doctor1.get(`/documents/${id}/drafts`);
    expect(drafts.status).toBe(200);
    expect(drafts.body[0]).toMatchObject({ documentId: id, isDraft: true, text: 'Draft text: Paracetamol' });
    expect((await followup.get(`/documents/${id}/drafts`)).status).toBe(200);

    const failed = await upload(patient1, makePng());
    await t.pool.query(`UPDATE documents SET status = 'ocr_failed', last_error = 'provider timed out' WHERE id = $1`, [failed.body.id]);
    const inbox = await doctor1.get('/review-inbox');
    expect(inbox.status).toBe(200);
    const items = inbox.body as Array<{ id: string; status: string; patientName: string }>;
    expect(items.find((i) => i.id === id)).toMatchObject({ status: 'ocr_ready' });
    expect(items.find((i) => i.id === failed.body.id)).toMatchObject({ status: 'ocr_failed' });
    expect(items.every((i) => ['ocr_ready', 'ocr_failed'].includes(i.status))).toBe(true);
    expect(items[0]!.patientName).toBeTruthy();
    expect(((await doctor2.get('/review-inbox')).body as Array<{ id: string }>).some((i) => i.id === id)).toBe(false);
    expect((await reception.get('/review-inbox')).status).toBe(403);
    expect((await patient1.get('/review-inbox')).status).toBe(403);
  });
});

describe('FR-12-b OCR failure does not interrupt booking; controlled retry', () => {
  it('a failed document leaves booking and check-in untouched, and retry re-enqueues under a new key', async () => {
    const up = await upload(patient1, makePng());
    const id = up.body.id as string;
    await t.pool.query(`UPDATE documents SET status = 'ocr_failed', last_error = 'provider timed out', ocr_attempts = 5 WHERE id = $1`, [id]);

    // Core flow still works: book and check in.
    const s = await makeSession(admin, { doctor: 1 });
    const booked = await patient1.post('/appointments', { sessionId: s.id });
    expect(booked.status).toBe(201);
    t.clock.set(new Date(new Date(s.startsAt).getTime() - 5 * 60_000));
    const checkIn = await reception.post(`/appointments/${booked.body.id}/check-in`, {});
    expect(checkIn.status).toBe(201);

    // The patient sees the failure without internals; staff see the reason.
    expect((await patient1.get(`/documents/${id}`)).body).toMatchObject({ status: 'ocr_failed', lastError: null });
    expect((await doctor1.get(`/documents/${id}`)).body.lastError).toBe('provider timed out');

    t.clock.reset();
    expect((await patient1.post(`/documents/${id}/retry-ocr`, {})).status).toBe(403);
    expect((await doctor2.post(`/documents/${id}/retry-ocr`, {})).status).toBe(404);
    const retry = await doctor1.post(`/documents/${id}/retry-ocr`, {});
    expect(retry.status).toBe(202);
    const jobs = await t.pool.query(`SELECT dedupe_key, payload FROM jobs WHERE dedupe_key LIKE $1`, [`ocr_document:${id}:retry:%`]);
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]!.payload).toEqual({ documentId: id });
    expect(jobs.rows[0]!.dedupe_key).toBe(`ocr_document:${id}:retry:${retry.body.version}`);
    expect(await count(t.pool, `SELECT 1 FROM audit_events WHERE operation = 'document.retry_ocr' AND entity_id = $1`, [id])).toBe(1);
    // The worker owns the state change: the document is still ocr_failed until it picks the job up.
    expect(retry.body.status).toBe('ocr_failed');

    const stale = await doctor1.post(`/documents/${id}/retry-ocr`, { expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(code(stale.body)).toBe('CONFLICT');
    // Only from ocr_failed
    const ok = await upload(patient1, makePng());
    const notFailed = await doctor1.post(`/documents/${ok.body.id}/retry-ocr`, {});
    expect(notFailed.status).toBe(409);
    expect(code(notFailed.body)).toBe('INVALID_TRANSITION');
  });
});

describe('FR-13 verification and immutable versions', () => {
  it('FR-01-b: only doctors verify; reception, follow-up, admin and patients get 403; an out-of-scope doctor 404', async () => {
    const { id } = await readyDocument();
    const body = { title: 'Antibiotic course', body: 'Take amoxicillin 500 mg twice daily after food for five days.' };
    for (const who of [reception, followup, admin, patient1]) {
      expect((await who.post(`/documents/${id}/verify`, body)).status).toBe(403);
    }
    expect((await doctor2.post(`/documents/${id}/verify`, body)).status).toBe(404);
    expect(await count(t.pool, `SELECT 1 FROM instruction_versions iv JOIN instructions i ON i.id = iv.instruction_id WHERE i.document_id = $1`, [id])).toBe(0);
    expect((await t.pool.query(`SELECT status FROM documents WHERE id = $1`, [id])).rows[0]!.status).toBe('ocr_ready');
  });

  it('a document must be reviewable: an accepted (un-OCRed) document cannot be verified', async () => {
    const up = await upload(patient1, makePng());
    const res = await doctor1.post(`/documents/${up.body.id}/verify`, { title: 'Too early', body: 'Nothing was read yet' });
    expect(res.status).toBe(409);
    expect(code(res.body)).toBe('INVALID_TRANSITION');
  });

  it('verify creates version 1; revise supersedes it and keeps history; versions are immutable (FR-13-b)', async () => {
    const { id, draftId } = await readyDocument();
    const v1res = await doctor1.post(`/documents/${id}/verify`, {
      title: 'Antibiotic course',
      body: 'Take amoxicillin 500 mg twice daily after food for five days.',
      sourceDraftId: draftId,
    });
    expect(v1res.status).toBe(201);
    const v1 = InstructionVersion.parse(v1res.body);
    expect(v1).toMatchObject({ version: 1, status: 'current', patientId: P1, sourceDraftId: draftId, supersedesId: null });
    expect(v1.verifiedByName).toBeTruthy();
    expect((await t.pool.query(`SELECT status FROM documents WHERE id = $1`, [id])).rows[0]!.status).toBe('verified');
    // Events carry ids only, never the clinical text.
    const ev = await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'InstructionVerified' AND entity_id = $1`, [v1.id]);
    expect(ev.rows).toHaveLength(1);
    expect(JSON.stringify(ev.rows[0]!.payload)).not.toMatch(/amoxicillin/i);
    expect(await count(t.pool, `SELECT 1 FROM audit_events WHERE operation = 'instruction.verify' AND entity_id = $1`, [v1.id])).toBe(1);

    // A second lineage from the same verified document is refused; a revision of the lineage is not.
    const dup = await doctor1.post(`/documents/${id}/verify`, { title: 'Again', body: 'Same document twice' });
    expect(dup.status).toBe(409);
    const v2res = await doctor1.post(`/documents/${id}/verify`, {
      instructionId: v1.instructionId,
      title: 'Antibiotic course (revised)',
      body: 'Take amoxicillin 250 mg three times daily after food for seven days.',
    });
    expect(v2res.status).toBe(201);
    const v2 = InstructionVersion.parse(v2res.body);
    expect(v2).toMatchObject({ version: 2, status: 'current', supersedesId: v1.id, instructionId: v1.instructionId, title: 'Antibiotic course (revised)' });

    // History preserved, exactly one current version.
    const staff = (await doctor1.get(`/instructions?patientId=${P1}`)).body as InstructionVersion[];
    const mine = staff.filter((x) => x.instructionId === v1.instructionId);
    expect(mine.map((x) => [x.version, x.status])).toEqual([[2, 'current'], [1, 'superseded']]);
    expect(mine.find((x) => x.version === 1)).toMatchObject({ title: 'Antibiotic course', body: v1.body });

    // The patient sees current versions only; another patient and out-of-scope staff see nothing / 404.
    const patientView = (await patient1.get('/instructions')).body as InstructionVersion[];
    expect(patientView.every((x) => x.status === 'current')).toBe(true);
    expect(patientView.some((x) => x.id === v1.id)).toBe(false);
    expect(patientView.some((x) => x.id === v2.id)).toBe(true);
    expect((await patient2.get(`/instructions?patientId=${P1}`)).status).toBe(404);
    expect((await doctor2.get(`/instructions?patientId=${P1}`)).status).toBe(404);
    expect((await reception.get(`/instructions?patientId=${P1}`)).status).toBe(403);

    // Immutability in the database itself.
    await expect(t.pool.query(`UPDATE instruction_versions SET body = 'tampered' WHERE id = $1`, [v1.id])).rejects.toThrow(/immutable/);
    await expect(t.pool.query(`UPDATE instruction_versions SET title = 'tampered' WHERE id = $1`, [v2.id])).rejects.toThrow(/immutable/);
    await expect(t.pool.query(`UPDATE instruction_versions SET status = 'current' WHERE id = $1`, [v1.id])).rejects.toThrow(/immutable/);
    await expect(t.pool.query(`DELETE FROM instruction_versions WHERE id = $1`, [v1.id])).rejects.toThrow(/immutable/);
    expect((await t.pool.query(`SELECT body FROM instruction_versions WHERE id = $1`, [v1.id])).rows[0]!.body).toBe(v1.body);
  });

  it('a revision must belong to the same patient and a draft to the same document', async () => {
    const a = await readyDocument();
    const v = await doctor1.post(`/documents/${a.id}/verify`, { title: 'Plan', body: 'Rest and fluids for three days.' });
    expect(v.status).toBe(201);
    // Another patient's document (linked to doctor 1) cannot revise patient 1's lineage
    const p3 = patientId(3);
    await linkPatient(admin, reception, p3, 1);
    const up = await upload(doctor1, makePng(), p3);
    await t.pool.query(`UPDATE documents SET status = 'ocr_ready' WHERE id = $1`, [up.body.id]);
    const cross = await doctor1.post(`/documents/${up.body.id}/verify`, { instructionId: v.body.instructionId, title: 'Hijack', body: 'Not your lineage' });
    expect(cross.status).toBe(400);
    const wrongDraft = await doctor1.post(`/documents/${up.body.id}/verify`, { title: 'Wrong draft', body: 'Body text here', sourceDraftId: a.draftId });
    expect(wrongDraft.status).toBe(400);
    expect((await t.pool.query(`SELECT status FROM documents WHERE id = $1`, [up.body.id])).rows[0]!.status).toBe('ocr_ready');
  });
});
