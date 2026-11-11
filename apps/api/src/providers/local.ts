import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { LlmAnswer, LlmContextItem, LlmProvider, ObjectStorage } from './ports.js';

/*
 * Minimal local adapters so the API runs with no keys (CLAUDE.md). To be replaced by @hqms/providers once it
 * is on the integration branch; the port shapes are identical.
 */

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

function safeSegments(key: string): string[] {
  if (!key || key.length > 512 || key.startsWith('/') || key.includes('\\') || key.includes('\0')) {
    throw new Error('invalid storage key');
  }
  const segments = key.split('/');
  if (!segments.every((s) => SEGMENT.test(s))) throw new Error('invalid storage key');
  return segments;
}

const isMissing = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

export class LocalDiskStorage implements ObjectStorage {
  readonly name = 'local-disk';
  private readonly root: string;
  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  private pathFor(key: string): string {
    const p = join(this.root, ...safeSegments(key));
    if (!p.startsWith(this.root + sep)) throw new Error('storage key escapes the storage root');
    return p;
  }

  async put(key: string, bytes: Uint8Array): Promise<{ key: string; sha256: string; size: number }> {
    const path = this.pathFor(key);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = join(dirname(path), `.tmp-${randomBytes(8).toString('hex')}`);
    try {
      await writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
      await rename(tmp, path);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    await chmod(path, 0o600);
    return { key, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength };
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async head(key: string): Promise<{ size: number; modifiedAt: Date } | null> {
    try {
      const s = await stat(this.pathFor(key));
      return s.isFile() ? { size: s.size, modifiedAt: s.mtime } : null;
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key));
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (isMissing(err)) return;
        throw err;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) await walk(join(dir, e.name), childRel);
        else if (e.isFile() && childRel.startsWith(prefix)) out.push(childRel);
      }
    };
    await walk(this.root, '');
    return out.sort();
  }
}

/** In-memory storage for tests (and a stand-in where no disk is wanted). */
export class MemoryStorage implements ObjectStorage {
  readonly name = 'memory';
  readonly objects = new Map<string, { bytes: Buffer; at: Date }>();
  /** Test hook: make the next put() fail once. */
  failNextPut = false;

  put(key: string, bytes: Uint8Array): Promise<{ key: string; sha256: string; size: number }> {
    if (this.failNextPut) {
      this.failNextPut = false;
      return Promise.reject(new Error('storage unavailable'));
    }
    const buf = Buffer.from(bytes);
    this.objects.set(key, { bytes: buf, at: new Date() });
    return Promise.resolve({ key, sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length });
  }
  get(key: string): Promise<Buffer> {
    const o = this.objects.get(key);
    return o ? Promise.resolve(o.bytes) : Promise.reject(new Error('not found'));
  }
  head(key: string): Promise<{ size: number; modifiedAt: Date } | null> {
    const o = this.objects.get(key);
    return Promise.resolve(o ? { size: o.bytes.length, modifiedAt: o.at } : null);
  }
  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
  list(prefix: string): Promise<string[]> {
    return Promise.resolve([...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort());
  }
}

/** Deterministic templated assistant: quotes the sentence of a verified version that shares words with the question. */
export class LocalFakeLlm implements LlmProvider {
  readonly name = 'fake';

  answer({ question, context }: { question: string; context: LlmContextItem[] }): Promise<LlmAnswer> {
    const words = (s: string) =>
      new Set(
        s
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((w) => w.length > 3),
      );
    const q = words(question);
    for (const item of context) {
      for (const sentence of item.body.split(/(?<=[.!?])\s+|\n+/)) {
        if ([...words(sentence)].some((w) => q.has(w))) {
          return Promise.resolve({
            kind: 'answer',
            text: `Your verified instruction "${item.title}" (version ${item.version}) says: "${sentence.trim()}"`,
            citedVersionIds: [item.instructionVersionId],
          });
        }
      }
    }
    return Promise.resolve({ kind: 'unsupported', reason: 'Your verified instructions do not cover this question.' });
  }
}

export function createObjectStorage(env: NodeJS.ProcessEnv = process.env): ObjectStorage {
  const kind = env['OBJECT_STORAGE'] || 'local-disk';
  if (kind !== 'local-disk') throw new Error(`OBJECT_STORAGE=${kind} is not available in this build`);
  return new LocalDiskStorage(env['STORAGE_DIR'] || './var/storage');
}

export function createLlmProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const kind = env['LLM_PROVIDER'] || 'fake';
  if (kind !== 'fake') throw new Error(`LLM_PROVIDER=${kind} is not available in this build`);
  return new LocalFakeLlm();
}
