import type { DocumentMeta, InstructionVersion, OcrDraft } from '@hqms/contracts';
import type { Queryable, Tx } from '@hqms/db';
import { notFound } from '../common/errors.js';

/** SQL for documents, OCR drafts and instruction versions (FR-12, FR-13). */

export interface DocumentRow extends DocumentMeta {
  storageKey: string;
  contentHash: string;
  uploadedBy: string;
}

const DOC_COLS = `d.id, d.patient_id, d.visit_id, d.original_name, d.mime_type, d.size_bytes, d.page_count, d.status,
  d.ocr_attempts, d.last_error, d.version, d.created_at, d.storage_key, d.content_hash, d.uploaded_by`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg row
const mapDoc = (r: any): DocumentRow => ({
  id: r.id,
  patientId: r.patient_id,
  visitId: r.visit_id,
  originalName: r.original_name,
  mimeType: r.mime_type,
  sizeBytes: r.size_bytes,
  pageCount: r.page_count,
  status: r.status,
  ocrAttempts: r.ocr_attempts,
  lastError: r.last_error,
  version: r.version,
  createdAt: r.created_at,
  storageKey: r.storage_key,
  contentHash: r.content_hash,
  uploadedBy: r.uploaded_by,
});

/** Strip the storage internals before a document goes to a client. */
export function toMeta(d: DocumentRow, hideError = false): DocumentMeta {
  const { storageKey: _k, contentHash: _h, uploadedBy: _u, ...meta } = d;
  return hideError ? { ...meta, lastError: null } : meta;
}

export async function readDocument(db: Queryable, id: string): Promise<DocumentRow | null> {
  const res = await db.query(`SELECT ${DOC_COLS} FROM documents d WHERE d.id = $1`, [id]);
  return res.rows[0] ? mapDoc(res.rows[0]) : null;
}

/** Lock the document row (FOR NO KEY UPDATE). Document rows are leaf locks: no guard is needed with them. */
export async function lockDocument(tx: Tx, id: string): Promise<DocumentRow> {
  const res = await tx.query(`SELECT ${DOC_COLS} FROM documents d WHERE d.id = $1 FOR NO KEY UPDATE`, [id]);
  if (!res.rows[0]) throw notFound('Document');
  return mapDoc(res.rows[0]);
}

export async function listDocumentsOfPatient(db: Queryable, patientId: string): Promise<DocumentRow[]> {
  const res = await db.query(`SELECT ${DOC_COLS} FROM documents d WHERE d.patient_id = $1 ORDER BY d.created_at DESC, d.id`, [
    patientId,
  ]);
  return res.rows.map(mapDoc);
}

/** Documents waiting for clinical review (or manual transcription) for patients linked to the given doctors. */
export async function reviewInbox(
  db: Queryable,
  doctorIds: string[] | null,
): Promise<Array<DocumentRow & { patientName: string }>> {
  const res = await db.query(
    `SELECT ${DOC_COLS}, p.full_name AS patient_name
       FROM documents d JOIN patients p ON p.id = d.patient_id
      WHERE d.status IN ('ocr_ready','ocr_failed')
        AND ($1::uuid[] IS NULL
             OR EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = d.patient_id AND a.doctor_id = ANY($1::uuid[]))
             OR EXISTS (SELECT 1 FROM visits v WHERE v.patient_id = d.patient_id AND v.doctor_id = ANY($1::uuid[])))
      ORDER BY d.created_at, d.id
      LIMIT 200`,
    [doctorIds],
  );
  return res.rows.map((r) => ({ ...mapDoc(r), patientName: r.patient_name as string }));
}

export async function listDrafts(db: Queryable, documentId: string): Promise<OcrDraft[]> {
  const res = await db.query(
    `SELECT id, document_id, provider, text, blocks, created_at FROM ocr_drafts WHERE document_id = $1 ORDER BY created_at, id`,
    [documentId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    documentId: r.document_id,
    provider: r.provider,
    text: r.text,
    blocks: r.blocks,
    createdAt: r.created_at,
    isDraft: true as const,
  }));
}

const VERSION_COLS = `iv.id, iv.instruction_id, iv.patient_id, iv.version, COALESCE(iv.title, i.title) AS title, iv.body,
  iv.status, iv.verified_by, u.display_name AS verified_by_name, iv.verified_at, iv.supersedes_id, iv.source_draft_id`;
const VERSION_FROM = `FROM instruction_versions iv JOIN instructions i ON i.id = iv.instruction_id JOIN users u ON u.id = iv.verified_by`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg row
const mapVersion = (r: any): InstructionVersion => ({
  id: r.id,
  instructionId: r.instruction_id,
  patientId: r.patient_id,
  version: r.version,
  title: r.title,
  body: r.body,
  status: r.status,
  verifiedBy: r.verified_by,
  verifiedByName: r.verified_by_name,
  verifiedAt: r.verified_at,
  supersedesId: r.supersedes_id,
  sourceDraftId: r.source_draft_id,
});

export async function readVersion(db: Queryable, id: string): Promise<InstructionVersion | null> {
  const res = await db.query(`SELECT ${VERSION_COLS} ${VERSION_FROM} WHERE iv.id = $1`, [id]);
  return res.rows[0] ? mapVersion(res.rows[0]) : null;
}

/** Versions of one patient: current only, or the full history (newest lineage activity first). */
export async function listVersions(db: Queryable, patientId: string, currentOnly: boolean): Promise<InstructionVersion[]> {
  const res = await db.query(
    `SELECT ${VERSION_COLS} ${VERSION_FROM}
      WHERE iv.patient_id = $1 AND ($2::boolean = false OR iv.status = 'current')
      ORDER BY iv.instruction_id, iv.version DESC`,
    [patientId, currentOnly],
  );
  return res.rows.map(mapVersion);
}

/**
 * The assistant's only knowledge source (FR-13/FR-14): the patient's CURRENT verified versions. Never drafts,
 * never superseded versions, and always filtered by the patient id taken from the session.
 */
export async function currentContextOf(
  db: Queryable,
  patientId: string,
): Promise<Array<{ instructionVersionId: string; title: string; version: number; body: string }>> {
  const res = await db.query(
    `SELECT iv.id, COALESCE(iv.title, i.title) AS title, iv.version, iv.body
       FROM instruction_versions iv JOIN instructions i ON i.id = iv.instruction_id
      WHERE iv.patient_id = $1 AND i.patient_id = $1 AND iv.status = 'current'
      ORDER BY iv.verified_at, iv.id`,
    [patientId],
  );
  return res.rows.map((r) => ({ instructionVersionId: r.id, title: r.title, version: r.version, body: r.body }));
}
