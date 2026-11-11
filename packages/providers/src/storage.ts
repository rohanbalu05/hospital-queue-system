import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { NotConfiguredError, StorageKeyError, StorageNotFoundError } from './errors.js';

export type ProviderEnv = Readonly<Record<string, string | undefined>>;

/** Private object storage for document bytes (report 6.10). Keys look like `documents/<patientId>/<documentId>`. */
export interface ObjectStorage {
  readonly name: string;
  put(
    key: string,
    bytes: Uint8Array,
    opts: { contentType: string },
  ): Promise<{ key: string; sha256: string; size: number }>;
  /** Throws StorageNotFoundError when the object does not exist. */
  get(key: string): Promise<Buffer>;
  /** null when the object does not exist. `modifiedAt` lets the reconciler age abandoned uploads. */
  head(key: string): Promise<{ size: number; modifiedAt: Date } | null>;
  /** Idempotent: deleting a missing object succeeds. */
  delete(key: string): Promise<void>;
  /** All keys that start with `prefix` (sorted). For the reconciler. */
  list(prefix: string): Promise<string[]>;
}

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const MAX_KEY_LENGTH = 512;

/**
 * Keys are relative, `/`-separated, and made of plain segments only: no empty segment, no segment starting
 * with a dot (so no `.` or `..`), no backslash, no NUL, no absolute path. Dot-leading names are reserved for
 * the store's own temporary files.
 */
export function assertSafeKey(key: string): string[] {
  if (typeof key !== 'string' || key.length === 0) throw new StorageKeyError('storage key must be a non-empty string');
  if (key.length > MAX_KEY_LENGTH) throw new StorageKeyError('storage key is too long');
  if (key.startsWith('/')) throw new StorageKeyError('storage key must be relative');
  if (key.includes('\\')) throw new StorageKeyError('storage key must not contain backslashes');
  if (key.includes('\0')) throw new StorageKeyError('storage key must not contain NUL');
  const segments = key.split('/');
  for (const s of segments) {
    if (!SEGMENT.test(s)) throw new StorageKeyError('storage key has an invalid segment');
  }
  return segments;
}

function assertSafePrefix(prefix: string): void {
  if (prefix === '') return;
  if (prefix.startsWith('/') || prefix.includes('\\') || prefix.includes('\0'))
    throw new StorageKeyError('invalid prefix');
  const segments = prefix.split('/');
  segments.forEach((s, i) => {
    // The last segment may be empty (trailing slash) or a partial name.
    if (i === segments.length - 1 && s === '') return;
    if (!SEGMENT.test(s)) throw new StorageKeyError('invalid prefix');
  });
}

function isEnoent(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export class LocalDiskStorage implements ObjectStorage {
  readonly name = 'local-disk';
  readonly rootDir: string;

  constructor(rootDir: string = process.env['STORAGE_DIR'] || './var/storage') {
    this.rootDir = resolve(rootDir);
  }

  private pathFor(key: string): string {
    const segments = assertSafeKey(key);
    const p = join(this.rootDir, ...segments);
    if (!p.startsWith(this.rootDir + sep)) throw new StorageKeyError('storage key escapes the storage root');
    return p;
  }

  async put(
    key: string,
    bytes: Uint8Array,
    _opts: { contentType: string },
  ): Promise<{ key: string; sha256: string; size: number }> {
    const path = this.pathFor(key);
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await chmod(this.rootDir, 0o700);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = join(dirname(path), `.tmp-${randomBytes(8).toString('hex')}`);
    try {
      await writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
      await rename(tmp, path); // atomic: readers never see a half-written object
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    return { key, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength };
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key));
    } catch (err) {
      if (isEnoent(err)) throw new StorageNotFoundError(key);
      throw err;
    }
  }

  async head(key: string): Promise<{ size: number; modifiedAt: Date } | null> {
    try {
      const s = await stat(this.pathFor(key));
      if (!s.isFile()) return null;
      return { size: s.size, modifiedAt: s.mtime };
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key));
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
  }

  async list(prefix: string): Promise<string[]> {
    assertSafePrefix(prefix);
    const slash = prefix.lastIndexOf('/');
    const startRel = slash >= 0 ? prefix.slice(0, slash) : '';
    const out: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (isEnoent(err)) return;
        throw err;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue; // temp files and anything we did not write
        const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) await walk(join(dir, e.name), childRel);
        else if (e.isFile() && childRel.startsWith(prefix)) out.push(childRel);
      }
    };
    const startDir = startRel === '' ? this.rootDir : join(this.rootDir, ...assertSafeKey(startRel));
    await walk(startDir, startRel);
    return out.sort();
  }
}

/** Google Cloud Storage adapter: later (cloud reference deployment). Selecting it without setup fails loudly. */
export class GcsStorage implements ObjectStorage {
  readonly name = 'gcs';
  constructor(readonly opts: { bucket?: string } = {}) {}

  private fail(): Promise<never> {
    return Promise.reject(
      new NotConfiguredError(
        'gcs',
        this.opts.bucket ? 'adapter not implemented in this build' : 'GCS_BUCKET is not set',
      ),
    );
  }
  put(): Promise<{ key: string; sha256: string; size: number }> {
    return this.fail();
  }
  get(): Promise<Buffer> {
    return this.fail();
  }
  head(): Promise<{ size: number; modifiedAt: Date } | null> {
    return this.fail();
  }
  delete(): Promise<void> {
    return this.fail();
  }
  list(): Promise<string[]> {
    return this.fail();
  }
}

export function createObjectStorage(env: ProviderEnv = process.env): ObjectStorage {
  const kind = env['OBJECT_STORAGE'] || 'local-disk';
  switch (kind) {
    case 'local-disk':
      return new LocalDiskStorage(env['STORAGE_DIR'] || './var/storage');
    case 'gcs':
      return new GcsStorage({ bucket: env['GCS_BUCKET'] });
    default:
      throw new Error(`OBJECT_STORAGE must be local-disk or gcs (got "${kind}")`);
  }
}
