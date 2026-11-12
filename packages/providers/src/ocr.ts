import { createHash } from 'node:crypto';
import { NotConfiguredError, TransientProviderError } from './errors.js';
import type { ProviderEnv } from './storage.js';

export interface OcrBlock {
  page: number;
  text: string;
  /** [x, y, width, height] in page pixels, when the provider supplies it. */
  bbox?: [number, number, number, number];
}

export interface OcrInput {
  bytes: Uint8Array;
  mimeType: string;
  pageCount: number;
}

export interface OcrResult {
  text: string;
  blocks: OcrBlock[];
  provider: string;
  /** 0..1 when the provider reports one. The result is a DRAFT either way (FR-13). */
  confidence?: number;
}

/** Text extraction. Output is only ever stored as a draft; it never becomes an approved instruction. */
export interface OcrProvider {
  readonly name: string;
  extract(input: OcrInput, opts?: { signal?: AbortSignal }): Promise<OcrResult>;
}

/** Fixture marker: a line `HQMS-FIXTURE:<name>` inside the bytes selects a canned result. */
export const FIXTURE_MARKER = /^HQMS-FIXTURE:([a-z0-9-]+)[ \t]*$/m;

interface Fixture {
  confidence: number;
  blocks: OcrBlock[];
}

const FIXTURES: Record<string, Fixture> = {
  'prescription-printed': {
    confidence: 0.97,
    blocks: [
      { page: 1, text: 'Dr. A. Sharma, General Medicine', bbox: [40, 30, 520, 28] },
      {
        page: 1,
        text: 'Tab Paracetamol 500 mg: one tablet three times a day after food for 5 days',
        bbox: [40, 90, 640, 26],
      },
      { page: 1, text: 'Tab Pantoprazole 40 mg: one tablet before breakfast for 7 days', bbox: [40, 130, 600, 26] },
      { page: 1, text: 'Drink plenty of fluids. Return if the fever lasts beyond 3 days.', bbox: [40, 190, 620, 26] },
      { page: 1, text: 'Review after 1 week.', bbox: [40, 230, 240, 26] },
    ],
  },
  'prescription-handwritten-lowquality': {
    confidence: 0.46,
    blocks: [
      { page: 1, text: 'Dr A Sharma Gen Med', bbox: [52, 38, 400, 40] },
      { page: 1, text: 'Tab Paracetamo1 500 mg 1-1-1 aft3r food x 5 d?ys', bbox: [48, 110, 620, 44] },
      { page: 1, text: 'Tab Pantopraz0le 4O mg 1-0-0 bef0re bre@kfast', bbox: [50, 170, 590, 44] },
      { page: 1, text: 'review aft3r 1 wk (illegible)', bbox: [50, 240, 300, 40] },
    ],
  },
  'lab-note': {
    confidence: 0.93,
    blocks: [
      { page: 1, text: 'Laboratory note, complete blood count', bbox: [40, 30, 420, 26] },
      { page: 1, text: 'Haemoglobin 13.2 g/dL (reference 12.0 to 15.5)', bbox: [40, 80, 480, 24] },
      { page: 1, text: 'Total leucocyte count 7800 per cubic mm', bbox: [40, 114, 430, 24] },
      { page: 1, text: 'Platelets 2.4 lakh per cubic mm', bbox: [40, 148, 360, 24] },
      { page: 1, text: 'Repeat the test after 4 weeks if symptoms persist.', bbox: [40, 200, 520, 24] },
    ],
  },
  // Low-confidence noise: the review UI must flag it; nothing downstream trusts it.
  garbage: {
    confidence: 0.07,
    blocks: [
      { page: 1, text: '#@! l1|| ~~ ,,, ;;; |I1l O0o', bbox: [10, 10, 300, 30] },
      { page: 1, text: 'rx ?? ...  ~ ~ 1l1 m g', bbox: [10, 60, 280, 30] },
    ],
  },
};

export const OCR_FIXTURE_NAMES: readonly string[] = [...Object.keys(FIXTURES), 'fail'];

/**
 * Deterministic offline OCR. Same bytes in, same text out; no clock, no randomness, no network.
 *  - `HQMS-FIXTURE:<name>` marker -> the named canned result (`fail` throws a transient error).
 *  - otherwise a synthetic text derived from the sha256 of the bytes, one block per page.
 */
export class FakeOcrProvider implements OcrProvider {
  readonly name = 'fake';

  extract(input: OcrInput, opts?: { signal?: AbortSignal }): Promise<OcrResult> {
    if (opts?.signal?.aborted) return Promise.reject(new TransientProviderError('fake OCR aborted'));
    try {
      return Promise.resolve(this.run(input));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  private run(input: OcrInput): OcrResult {
    const sha = createHash('sha256').update(input.bytes).digest('hex');
    // latin1 is a lossless byte view, so binary files with an embedded marker line still match.
    const m = FIXTURE_MARKER.exec(Buffer.from(input.bytes).toString('latin1'));
    const name = m?.[1];
    if (name === 'fail') throw new TransientProviderError('fake OCR provider unavailable (fixture "fail")');
    const fixture = name ? FIXTURES[name] : undefined;
    if (fixture) {
      return {
        text: fixture.blocks.map((b) => b.text).join('\n'),
        blocks: fixture.blocks.map((b) => ({ ...b, bbox: b.bbox ? [...b.bbox] : undefined })),
        provider: this.name,
        confidence: fixture.confidence,
      };
    }
    const pages = Math.max(1, Math.min(10, Math.floor(input.pageCount) || 1));
    const blocks: OcrBlock[] = [];
    for (let p = 1; p <= pages; p++) {
      blocks.push({
        page: p,
        text: `Synthetic OCR text ${sha.slice(0, 12)} page ${p} of ${pages}`,
        bbox: [40, 40, 400, 24],
      });
    }
    return { text: blocks.map((b) => b.text).join('\n'), blocks, provider: this.name, confidence: 0.8 };
  }
}

/** Google Cloud Vision adapter: later. Never called by default. */
export class GoogleVisionOcrProvider implements OcrProvider {
  readonly name = 'google-vision';
  constructor(readonly opts: { credentials?: string } = {}) {}

  extract(): Promise<OcrResult> {
    return Promise.reject(
      new NotConfiguredError(
        'google-vision',
        this.opts.credentials ? 'adapter not implemented in this build' : 'GOOGLE_APPLICATION_CREDENTIALS is not set',
      ),
    );
  }
}

export function createOcrProvider(env: ProviderEnv = process.env): OcrProvider {
  const kind = env['OCR_PROVIDER'] || 'fake';
  switch (kind) {
    case 'fake':
      return new FakeOcrProvider();
    case 'google-vision':
      return new GoogleVisionOcrProvider({ credentials: env['GOOGLE_APPLICATION_CREDENTIALS'] });
    default:
      throw new Error(`OCR_PROVIDER must be fake or google-vision (got "${kind}")`);
  }
}
