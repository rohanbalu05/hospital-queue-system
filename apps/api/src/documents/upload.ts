import { ALLOWED_MIME_TYPES, MAX_UPLOAD_BYTES, MAX_UPLOAD_PAGES } from '@hqms/contracts';
import { ApiException, validationFailed } from '../common/errors.js';

export type AllowedMime = (typeof ALLOWED_MIME_TYPES)[number];

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const PDF = Buffer.from('%PDF-', 'latin1');

/** The type the bytes actually are (magic numbers), whatever the filename or Content-Type header claims. */
export function sniffMime(bytes: Buffer): AllowedMime | null {
  if (bytes.subarray(0, PDF.length).equals(PDF)) return 'application/pdf';
  if (bytes.subarray(0, PNG.length).equals(PNG)) return 'image/png';
  if (bytes.subarray(0, JPEG.length).equals(JPEG)) return 'image/jpeg';
  return null;
}

/**
 * Pages of a PDF without a parser, in ONE pass over the bytes (no per-match slices):
 *  - the number of page objects (`/Type /Page`, not `/Type /Pages`), and
 *  - the largest `/Count` that sits in a page-tree node (within 300 characters of a `/Type /Pages` token, either
 *    side: it must not be mistaken for an outline's `/Count`).
 * The answer is the larger of the two, because compressed object streams hide page objects but never the tree's
 * `/Count`, and a hostile file can only raise the number (refused above the limit), not lower it. A file with
 * object streams and no determinable `/Count`, or with neither, returns 0 and is refused: a limit that cannot be
 * enforced is not accepted (FR-12).
 */
export function countPdfPages(bytes: Buffer): number {
  const text = bytes.toString('latin1');
  const re = /\/Type\s*\/Page(?![A-Za-z])|\/Type\s*\/Pages(?![A-Za-z])|\/Count\s+(\d{1,9})|\/ObjStm(?![A-Za-z])/g;
  const NEAR = 300;
  let pageObjects = 0;
  let objStm = false;
  let best = 0;
  let lastTreeAt = -Infinity;
  let lastCountAt = -Infinity;
  let lastCount = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const tok = m[0];
    if (m[1] !== undefined) {
      const n = Number(m[1]);
      if (m.index - lastTreeAt <= NEAR) best = Math.max(best, n);
      lastCountAt = m.index;
      lastCount = n;
    } else if (tok.endsWith('Pages')) {
      if (m.index - lastCountAt <= NEAR) best = Math.max(best, lastCount);
      lastTreeAt = m.index;
    } else if (tok.endsWith('ObjStm')) {
      objStm = true;
    } else {
      pageObjects += 1;
    }
  }
  if (objStm && best === 0) return 0;
  return Math.max(pageObjects, best);
}

export interface InspectedUpload {
  mimeType: AllowedMime;
  pageCount: number;
}

/**
 * FR-12 validation, run BEFORE anything is stored: size, real type, page count.
 * 413 UPLOAD_TOO_LARGE / 415 UNSUPPORTED_MEDIA_TYPE / 400 UPLOAD_TOO_MANY_PAGES.
 */
export function inspectUpload(bytes: Buffer, declaredType: string | undefined): InspectedUpload {
  if (bytes.length === 0) throw validationFailed('The file is empty');
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new ApiException(413, 'UPLOAD_TOO_LARGE', 'The file is larger than 10 MB');
  }
  const mimeType = sniffMime(bytes);
  const declared = (declaredType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const declaredAllowed = (ALLOWED_MIME_TYPES as readonly string[]).includes(declared);
  if (!mimeType || (declaredAllowed && declared !== mimeType)) {
    throw new ApiException(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only PDF, PNG and JPEG files are accepted');
  }
  let pageCount = 1;
  if (mimeType === 'application/pdf') {
    pageCount = countPdfPages(bytes);
    if (pageCount === 0) throw validationFailed('The number of pages in this PDF could not be determined');
    if (pageCount > MAX_UPLOAD_PAGES) {
      throw new ApiException(400, 'UPLOAD_TOO_MANY_PAGES', 'The document has more than 10 pages', {
        pageCount,
        maxPages: MAX_UPLOAD_PAGES,
      });
    }
  }
  return { mimeType, pageCount };
}

/** A display-safe file name: no path, no control characters, bounded length. */
export function safeFileName(raw: string | undefined): string {
  const base = (raw ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (cleaned.slice(0, 200) || 'document').trim();
}
