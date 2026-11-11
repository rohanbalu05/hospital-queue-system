import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DocumentMeta, InstructionVersion, OcrDraft, VerifyInstructionRequest } from '@hqms/contracts';
import { enqueueJob, withTransaction, writeAudit, writeOutbox, type Pool } from '@hqms/db';
import { assertTransition, InvalidTransitionError } from '@hqms/domain';
import { AccessPolicy } from '../access/access-policy.service.js';
import { PatientScope } from '../access/patient-scope.service.js';
import type { Clock } from '../common/clock.js';
import { ApiException, conflict, notFound, validationFailed } from '../common/errors.js';
import type { RequestCtx } from '../common/request-context.js';
import { CLOCK, DB_POOL, OBJECT_STORAGE } from '../common/tokens.js';
import { assertVersion } from '../queue/command.js';
import type { ObjectStorage } from '../providers/ports.js';
import {
  listDocumentsOfPatient,
  listDrafts,
  listVersions,
  lockDocument,
  readDocument,
  readVersion,
  reviewInbox,
  toMeta,
  type DocumentRow,
} from './documents.repo.js';
import { inspectUpload, safeFileName } from './upload.js';

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

export type ReviewInboxItem = DocumentMeta & { patientName: string };

@Injectable()
export class DocumentsService {
  private readonly log = new Logger('DocumentsService');

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AccessPolicy) private readonly access: AccessPolicy,
    @Inject(PatientScope) private readonly scope: PatientScope,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /**
   * FR-12 upload (report 6.10): validate -> tx1 row 'uploaded' -> storage.put (NO transaction open) -> tx2
   * 'accepted' + ocr_document job + DocumentUploaded + audit. A crash or a failed put between the two leaves the
   * row 'uploaded' for the worker's reconciler; nothing here calls a provider inside a transaction.
   */
  async upload(
    ctx: RequestCtx,
    file: UploadedFile | undefined,
    fields: { patientId?: string | undefined; visitId?: string | undefined },
  ): Promise<DocumentMeta> {
    const { user } = ctx;
    const patientId = user.role === 'patient' ? (fields.patientId ?? user.patientId ?? undefined) : fields.patientId;
    if (!patientId) throw validationFailed('patientId is required');
    await this.scope.assertAccess(user, patientId);
    const exists = await this.pool.query(`SELECT 1 FROM patients WHERE id = $1`, [patientId]);
    if ((exists.rowCount ?? 0) === 0) throw notFound('Patient');
    if (!file) throw validationFailed('A file is required (multipart field "file")');
    if (fields.visitId) {
      const v = await this.pool.query<{ doctor_id: string }>(`SELECT doctor_id FROM visits WHERE id = $1 AND patient_id = $2`, [
        fields.visitId,
        patientId,
      ]);
      const visit = v.rows[0];
      if (!visit) throw validationFailed('The visit does not belong to this patient');
      if (user.role !== 'patient' && !this.access.canActOnDoctor(user, visit.doctor_id)) throw notFound('Visit');
    }

    const { mimeType, pageCount } = inspectUpload(file.buffer, file.mimetype);
    const id = randomUUID();
    const storageKey = `documents/${patientId}/${id}`;
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');

    // tx1: the record exists before the bytes do.
    await withTransaction(this.pool, async (tx) => {
      await tx.query(
        `INSERT INTO documents (id, patient_id, visit_id, uploaded_by, storage_key, original_name, mime_type, size_bytes,
                                page_count, content_hash, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'uploaded')`,
        [
          id,
          patientId,
          fields.visitId ?? null,
          user.userId,
          storageKey,
          safeFileName(file.originalname),
          mimeType,
          file.buffer.length,
          pageCount,
          sha256,
        ],
      );
    });

    // No transaction here. If this fails the row stays 'uploaded' (reconciler); the caller may upload again.
    try {
      const stored = await this.storage.put(storageKey, file.buffer, { contentType: mimeType });
      if (stored.sha256 !== sha256 || stored.size !== file.buffer.length) throw new Error('stored object differs');
    } catch (err) {
      this.log.error(`${ctx.correlationId} object storage put failed for a document: ${err instanceof Error ? err.name : 'error'}`);
      throw new ApiException(503, 'INTERNAL', 'The file could not be stored; please upload it again');
    }

    // tx2: accepted + job intent + event + audit, together.
    return withTransaction(this.pool, async (tx) => {
      const doc = await lockDocument(tx, id);
      if (doc.status === 'uploaded') {
        assertTransition('document', 'uploaded', 'accepted');
        await tx.query(`UPDATE documents SET status = 'accepted', version = version + 1, updated_at = now() WHERE id = $1`, [id]);
        await enqueueJob(tx, { jobType: 'ocr_document', payload: { documentId: id }, dedupeKey: `ocr_document:${id}` });
        await writeOutbox(tx, {
          eventType: 'DocumentUploaded',
          entityType: 'document',
          entityId: id,
          entityVersion: doc.version + 1,
          patientId,
          payload: { pageCount, mimeType },
        });
        await writeAudit(tx, {
          actorId: user.userId,
          actorRole: user.role,
          operation: 'document.upload',
          entityType: 'document',
          entityId: id,
          next: { status: 'accepted', mimeType, pageCount, sizeBytes: file.buffer.length },
          correlationId: ctx.correlationId,
        });
      }
      const cur = await readDocument(tx, id);
      if (!cur) throw notFound('Document');
      return toMeta(cur, user.role === 'patient');
    });
  }

  /** The caller's view of a document, or 404 (patients: not theirs; staff: patient not in scope). */
  private async load(ctx: RequestCtx, id: string): Promise<DocumentRow> {
    const doc = await readDocument(this.pool, id);
    if (!doc) throw notFound('Document');
    await this.scope.assertAccess(ctx.user, doc.patientId);
    return doc;
  }

  async list(ctx: RequestCtx, patientId: string | undefined): Promise<DocumentMeta[]> {
    const { user } = ctx;
    const pid = user.role === 'patient' ? (patientId ?? user.patientId ?? undefined) : patientId;
    if (!pid) throw validationFailed('patientId is required');
    await this.scope.assertAccess(user, pid);
    const rows = await listDocumentsOfPatient(this.pool, pid);
    return rows.map((d) => toMeta(d, user.role === 'patient'));
  }

  async get(ctx: RequestCtx, id: string): Promise<DocumentMeta> {
    return toMeta(await this.load(ctx, id), ctx.user.role === 'patient');
  }

  /** Bytes for download. Staff reads of clinical files are audited (no content, ids only). */
  async file(ctx: RequestCtx, id: string): Promise<{ doc: DocumentRow; bytes: Buffer }> {
    const doc = await this.load(ctx, id);
    let bytes: Buffer;
    try {
      bytes = await this.storage.get(doc.storageKey);
    } catch {
      throw notFound('File');
    }
    if (ctx.user.role !== 'patient') {
      await withTransaction(this.pool, (tx) =>
        writeAudit(tx, {
          actorId: ctx.user.userId,
          actorRole: ctx.user.role,
          operation: 'document.download',
          entityType: 'document',
          entityId: id,
          correlationId: ctx.correlationId,
        }),
      );
    }
    return { doc, bytes };
  }

  /** OCR drafts: staff in scope only, never the patient (a draft is not an instruction). */
  async drafts(ctx: RequestCtx, id: string): Promise<OcrDraft[]> {
    const doc = await this.load(ctx, id);
    return listDrafts(this.pool, doc.id);
  }

  /** ocr_failed -> controlled retry: re-enqueue the OCR job under a fresh dedupe key; the worker moves the state. */
  async retryOcr(ctx: RequestCtx, id: string, expectedVersion: number | undefined): Promise<DocumentMeta> {
    const { user } = ctx;
    await this.load(ctx, id);
    return withTransaction(this.pool, async (tx) => {
      const doc = await lockDocument(tx, id);
      assertVersion(expectedVersion, doc.version, 'The document');
      if (doc.status !== 'ocr_failed') throw new InvalidTransitionError('document', doc.status, 'processing');
      // Bumping the version makes the dedupe key unique per retry; a second retry before the worker ran is refused.
      const version = doc.version + 1;
      const jobId = await enqueueJob(tx, {
        jobType: 'ocr_document',
        payload: { documentId: id },
        dedupeKey: `ocr_document:${id}:retry:${version}`,
      });
      if (!jobId) throw conflict('CONFLICT', 'A retry is already queued for this document');
      await tx.query(`UPDATE documents SET version = $2, updated_at = now() WHERE id = $1`, [id, version]);
      await writeAudit(tx, {
        actorId: user.userId,
        actorRole: user.role,
        operation: 'document.retry_ocr',
        entityType: 'document',
        entityId: id,
        previous: { status: doc.status, ocrAttempts: doc.ocrAttempts },
        next: { status: doc.status, version },
        correlationId: ctx.correlationId,
      });
      const cur = await readDocument(tx, id);
      if (!cur) throw notFound('Document');
      return toMeta(cur);
    });
  }

  /** Doctor's inbox: documents waiting for review (ocr_ready) or manual transcription (ocr_failed). */
  async inbox(ctx: RequestCtx): Promise<ReviewInboxItem[]> {
    const rows = await reviewInbox(this.pool, this.access.doctorScope(ctx.user));
    return rows.map((r) => ({ ...toMeta(r), patientName: r.patientName }));
  }

  /**
   * FR-13: the clinician turns a draft into an authoritative, immutable instruction version. New lineage (version
   * 1) or, with instructionId, a new version that supersedes the current one (old row current -> superseded, the
   * only update the trigger allows, then the new row), all in one transaction.
   */
  async verify(ctx: RequestCtx, documentId: string, body: VerifyInstructionRequest): Promise<InstructionVersion> {
    const { user } = ctx;
    await this.load(ctx, documentId);
    const id = await withTransaction(this.pool, async (tx) => {
      const doc = await lockDocument(tx, documentId);
      if (body.instructionId === undefined || doc.status !== 'verified') {
        // A verified document may only feed a revision of an existing instruction (the same lineage).
        assertTransition('document', doc.status, 'verified');
      }
      if (body.sourceDraftId) {
        const d = await tx.query(`SELECT 1 FROM ocr_drafts WHERE id = $1 AND document_id = $2`, [body.sourceDraftId, documentId]);
        if ((d.rowCount ?? 0) === 0) throw validationFailed('sourceDraftId is not a draft of this document');
      }
      const now = this.clock.now();
      let instructionId: string;
      let version = 1;
      let supersedesId: string | null = null;
      if (body.instructionId) {
        const lineage = await tx.query<{ patient_id: string }>(
          `SELECT patient_id FROM instructions WHERE id = $1 FOR UPDATE`,
          [body.instructionId],
        );
        const l = lineage.rows[0];
        if (!l || l.patient_id !== doc.patientId) throw validationFailed('instructionId is not an instruction of this patient');
        instructionId = body.instructionId;
        const cur = await tx.query<{ id: string; version: number }>(
          `SELECT id, version FROM instruction_versions WHERE instruction_id = $1 AND status = 'current'`,
          [instructionId],
        );
        const current = cur.rows[0];
        const max = await tx.query<{ v: number }>(
          `SELECT COALESCE(max(version), 0) AS v FROM instruction_versions WHERE instruction_id = $1`,
          [instructionId],
        );
        version = (max.rows[0]?.v ?? 0) + 1;
        if (current) {
          supersedesId = current.id;
          await tx.query(`UPDATE instruction_versions SET status = 'superseded' WHERE id = $1`, [current.id]);
        }
      } else {
        const ins = await tx.query<{ id: string }>(
          `INSERT INTO instructions (patient_id, document_id, visit_id, title) VALUES ($1, $2, $3, $4) RETURNING id`,
          [doc.patientId, doc.id, doc.visitId, body.title.trim()],
        );
        instructionId = ins.rows[0]?.id as string;
      }
      const iv = await tx.query<{ id: string }>(
        `INSERT INTO instruction_versions
           (instruction_id, patient_id, version, title, body, source_draft_id, status, verified_by, verified_at, supersedes_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'current', $7, $8, $9) RETURNING id`,
        [
          instructionId,
          doc.patientId,
          version,
          body.title.trim(),
          body.body.trim(),
          body.sourceDraftId ?? null,
          user.userId,
          now,
          supersedesId,
        ],
      );
      const versionId = iv.rows[0]?.id as string;
      if (doc.status !== 'verified') {
        await tx.query(`UPDATE documents SET status = 'verified', version = version + 1, updated_at = $2 WHERE id = $1`, [
          documentId,
          now,
        ]);
      }
      await writeAudit(tx, {
        actorId: user.userId,
        actorRole: user.role,
        operation: 'instruction.verify',
        entityType: 'instruction_version',
        entityId: versionId,
        previous: { documentStatus: doc.status, supersedes: supersedesId },
        next: { instructionId, version, documentId },
        correlationId: ctx.correlationId,
      });
      // Ids only: the clinical text stays in authorized storage.
      await writeOutbox(tx, {
        eventType: 'InstructionVerified',
        entityType: 'instruction_version',
        entityId: versionId,
        entityVersion: version,
        patientId: doc.patientId,
        payload: { instructionId, version },
      });
      return versionId;
    });
    const out = await readVersion(this.pool, id);
    if (!out) throw notFound('Instruction');
    return out;
  }

  /** Patient: their current versions only. Staff in scope: current plus history. */
  async instructions(ctx: RequestCtx, patientId: string | undefined): Promise<InstructionVersion[]> {
    const { user } = ctx;
    const pid = user.role === 'patient' ? (patientId ?? user.patientId ?? undefined) : patientId;
    if (!pid) throw validationFailed('patientId is required');
    await this.scope.assertAccess(user, pid);
    return listVersions(this.pool, pid, user.role === 'patient');
  }
}
