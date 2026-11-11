import { createHash, randomUUID } from 'node:crypto';
import { readFile, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import type { LocalDiskStorage } from '@hqms/providers';
import { makePatient, type World } from './helpers.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../tests/fixtures/documents');

/** Bytes of a file in tests/fixtures/documents (the fake OCR provider picks its output from the marker line). */
export const fixtureBytes = (name: string): Promise<Buffer> => readFile(join(FIXTURE_DIR, `${name}.txt`));

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export interface DocFixture {
  documentId: string;
  patientId: string;
  storageKey: string;
  bytes: Buffer;
}

/**
 * A document row plus (optionally) its object, as the API leaves them. `createdAt`/`updatedAt` let the
 * reconciler tests age a row; `objectAgeMs` ages the stored file's mtime.
 */
export async function makeDocument(
  pool: Pool,
  storage: LocalDiskStorage,
  w: World,
  opts: {
    fixture?: string;
    bytes?: Buffer;
    status?: string;
    withObject?: boolean;
    createdAt?: Date;
    updatedAt?: Date;
    objectAgeMs?: number;
    sizeBytes?: number;
    patientId?: string;
  } = {},
): Promise<DocFixture> {
  const patientId = opts.patientId ?? (await makePatient(pool, w)).patientId;
  const documentId = randomUUID();
  const storageKey = `documents/${patientId}/${documentId}`;
  const bytes = opts.bytes ?? (await fixtureBytes(opts.fixture ?? 'prescription-printed'));
  if (opts.withObject ?? true) {
    await storage.put(storageKey, bytes, { contentType: 'image/png' });
    if (opts.objectAgeMs) {
      const t = new Date(Date.now() - opts.objectAgeMs);
      await utimes(join(storage.rootDir, ...storageKey.split('/')), t, t);
    }
  }
  const createdAt = opts.createdAt ?? new Date();
  await pool.query(
    `INSERT INTO documents (id, patient_id, uploaded_by, storage_key, original_name, mime_type, size_bytes, page_count, content_hash, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'scan.png', 'image/png', $5, 1, $6, $7, $8::timestamptz, $9::timestamptz)`,
    [
      documentId,
      patientId,
      w.receptionUserId,
      storageKey,
      opts.sizeBytes ?? bytes.length,
      sha256(bytes),
      opts.status ?? 'accepted',
      createdAt.toISOString(),
      (opts.updatedAt ?? createdAt).toISOString(),
    ],
  );
  return { documentId, patientId, storageKey, bytes };
}

export const getDocument = async (pool: Pool, id: string) =>
  (await pool.query(`SELECT * FROM documents WHERE id = $1`, [id])).rows[0];

export const draftsOf = async (pool: Pool, id: string) =>
  (await pool.query(`SELECT * FROM ocr_drafts WHERE document_id = $1 ORDER BY created_at`, [id])).rows;

export const eventsOf = async (pool: Pool, id: string, type?: string) =>
  (
    await pool.query(
      `SELECT * FROM outbox_events WHERE entity_type = 'document' AND entity_id = $1 AND ($2::text IS NULL OR event_type = $2) ORDER BY position`,
      [id, type ?? null],
    )
  ).rows;

export const jobsFor = async (pool: Pool, type: string, documentId?: string) =>
  (
    await pool.query(
      `SELECT * FROM jobs WHERE job_type = $1 AND ($2::text IS NULL OR payload->>'documentId' = $2) ORDER BY created_at`,
      [type, documentId ?? null],
    )
  ).rows;

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
