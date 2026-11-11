import { createHash } from 'node:crypto';
import { FakeLlmProvider, type LlmAnswer, type LlmContextItem, type LlmProvider, type ObjectStorage } from '@hqms/providers';
import type { Pool } from '@hqms/db';

/** In-memory ObjectStorage with failure injection and a hook to look at the database while put() is in flight. */
export class MemoryStorage implements ObjectStorage {
  readonly name = 'memory';
  readonly objects = new Map<string, Buffer>();
  failNextPut = false;
  onCall?: () => Promise<void>;

  async put(key: string, bytes: Uint8Array): Promise<{ key: string; sha256: string; size: number }> {
    await this.onCall?.();
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error('storage unavailable');
    }
    const buf = Buffer.from(bytes);
    this.objects.set(key, buf);
    return { key, sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length };
  }
  get(key: string): Promise<Buffer> {
    const o = this.objects.get(key);
    return o ? Promise.resolve(o) : Promise.reject(new Error('not found'));
  }
  head(key: string): Promise<{ size: number; modifiedAt: Date } | null> {
    const o = this.objects.get(key);
    return Promise.resolve(o ? { size: o.length, modifiedAt: new Date() } : null);
  }
  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
  list(prefix: string): Promise<string[]> {
    return Promise.resolve([...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort());
  }
}

export interface LlmCall {
  question: string;
  context: LlmContextItem[];
}

/** Wraps the real fake provider: records every call, and can be told to misbehave for one call. */
export class SpyLlm implements LlmProvider {
  readonly name = 'fake';
  readonly calls: LlmCall[] = [];
  private readonly inner = new FakeLlmProvider();
  /** One-shot override of the next answer. */
  next: (() => Promise<LlmAnswer>) | null = null;
  /** Called inside answer(): lets a test look at the database while the provider call is in flight. */
  onCall?: () => Promise<void>;

  async answer(input: { question: string; context: LlmContextItem[] }): Promise<LlmAnswer> {
    this.calls.push({ question: input.question, context: input.context.map((c) => ({ ...c })) });
    await this.onCall?.();
    if (this.next) {
      const n = this.next;
      this.next = null;
      return n();
    }
    return this.inner.answer(input);
  }
}

/** Transactions the API pool holds open right now (must be 0 while a provider call is in flight). */
export async function openApiTransactions(pool: Pool): Promise<number> {
  const r = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE application_name = 'hqms-api' AND state = 'idle in transaction' AND pid <> pg_backend_pid()`,
  );
  return r.rows[0]?.n ?? 0;
}

/** Minimal PDF text with `pages` page objects and a page tree. */
export function makePdf(pages: number): Buffer {
  const kids = Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(' ');
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    `2 0 obj\n<< /Type /Pages /Count ${pages} /Kids [${kids}] >>\nendobj\n`,
    ...Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n`),
  ];
  return Buffer.from(`%PDF-1.4\n${objs.join('')}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1');
}

/** A PNG signature plus filler: enough for magic-byte detection. */
export function makePng(extraBytes = 64): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extraBytes, 7)]);
}
