import { describe, expect, it } from 'vitest';
import {
  FakeOcrProvider,
  GoogleVisionOcrProvider,
  NotConfiguredError,
  OCR_FIXTURE_NAMES,
  TransientProviderError,
  createOcrProvider,
  isTransient,
} from '../src/index.js';

const ocr = new FakeOcrProvider();
const bytes = (s: string) => Buffer.from(s, 'latin1');
const input = (s: string, pageCount = 1) => ({ bytes: bytes(s), mimeType: 'image/png', pageCount });

describe('FakeOcrProvider', () => {
  it('returns the printed prescription fixture for its marker', async () => {
    const r = await ocr.extract(input('\x89PNG\r\n\x1a\nbinary\nHQMS-FIXTURE:prescription-printed\nmore'));
    expect(r.provider).toBe('fake');
    expect(r.text).toContain('Paracetamol 500 mg');
    expect(r.blocks.length).toBeGreaterThan(2);
    expect(r.blocks.every((b) => b.page === 1 && b.bbox?.length === 4)).toBe(true);
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it('each named fixture is distinct and the low-quality ones report low confidence', async () => {
    const out = new Map<string, Awaited<ReturnType<typeof ocr.extract>>>();
    for (const name of OCR_FIXTURE_NAMES.filter((n) => n !== 'fail')) {
      out.set(name, await ocr.extract(input(`HQMS-FIXTURE:${name}`)));
    }
    expect(new Set([...out.values()].map((r) => r.text)).size).toBe(out.size);
    expect(out.get('lab-note')?.text).toContain('Haemoglobin');
    expect(out.get('prescription-handwritten-lowquality')?.confidence).toBeLessThan(0.6);
    expect(out.get('garbage')?.confidence).toBeLessThan(0.2);
  });

  it('the fail fixture throws a transient error', async () => {
    const err = await ocr.extract(input('HQMS-FIXTURE:fail')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientProviderError);
    expect(isTransient(err)).toBe(true);
  });

  it('is deterministic: identical bytes give identical output, different bytes differ', async () => {
    const a = await ocr.extract(input('some scan A', 2));
    const b = await ocr.extract(input('some scan A', 2));
    const c = await ocr.extract(input('some scan B', 2));
    expect(a).toEqual(b);
    expect(a.text).not.toBe(c.text);
    expect(a.blocks.map((x) => x.page)).toEqual([1, 2]);
  });

  it('unknown marker name falls back to the synthetic text', async () => {
    const r = await ocr.extract(input('HQMS-FIXTURE:no-such-fixture'));
    expect(r.text).toMatch(/^Synthetic OCR text [0-9a-f]{12} page 1 of 1$/);
  });

  it('only a marker on its own line counts', async () => {
    const r = await ocr.extract(input('prefix HQMS-FIXTURE:fail suffix'));
    expect(r.text).toMatch(/^Synthetic OCR text/);
  });

  it('an already-aborted signal fails transiently', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(ocr.extract(input('x'), { signal: ac.signal })).rejects.toBeInstanceOf(TransientProviderError);
  });
});

describe('createOcrProvider', () => {
  it('defaults to fake', () => {
    expect(createOcrProvider({})).toBeInstanceOf(FakeOcrProvider);
  });
  it('google-vision is a stub that is never transient', async () => {
    const p = createOcrProvider({ OCR_PROVIDER: 'google-vision' });
    expect(p).toBeInstanceOf(GoogleVisionOcrProvider);
    const err = await p.extract(input('x')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotConfiguredError);
    expect(isTransient(err)).toBe(false);
  });
  it('rejects an unknown provider', () => {
    expect(() => createOcrProvider({ OCR_PROVIDER: 'tesseract' })).toThrow(/OCR_PROVIDER/);
  });
});
