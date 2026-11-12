import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GcsStorage,
  LocalDiskStorage,
  NotConfiguredError,
  StorageKeyError,
  StorageNotFoundError,
  createObjectStorage,
} from '../src/index.js';

let dir: string;
let store: LocalDiskStorage;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hqms-storage-'));
  store = new LocalDiskStorage(join(dir, 'root'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const KEY = 'documents/3f2b6c1e-0000-4000-8000-000000000001/5a1b6c1e-0000-4000-8000-000000000002';

describe('LocalDiskStorage', () => {
  it('put/get/head round trip returns sha256 and size', async () => {
    const bytes = Buffer.from('hello document');
    const r = await store.put(KEY, bytes, { contentType: 'application/pdf' });
    expect(r).toEqual({ key: KEY, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
    expect((await store.get(KEY)).equals(bytes)).toBe(true);
    const head = await store.head(KEY);
    expect(head?.size).toBe(bytes.length);
    expect(head?.modifiedAt).toBeInstanceOf(Date);
  });

  it('head is null and get throws StorageNotFoundError for a missing object', async () => {
    expect(await store.head(KEY)).toBeNull();
    await expect(store.get(KEY)).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  it('delete is idempotent', async () => {
    await store.put(KEY, Buffer.from('x'), { contentType: 'image/png' });
    await store.delete(KEY);
    await store.delete(KEY);
    expect(await store.head(KEY)).toBeNull();
  });

  it('put overwrites atomically and leaves no temp files behind', async () => {
    await store.put(KEY, Buffer.from('one'), { contentType: 'image/png' });
    await store.put(KEY, Buffer.from('two!'), { contentType: 'image/png' });
    expect((await store.get(KEY)).toString()).toBe('two!');
    const leaf = join(store.rootDir, ...KEY.split('/').slice(0, -1));
    expect(await readdir(leaf)).toHaveLength(1);
  });

  it('writes files 0600 and directories 0700', async () => {
    await store.put(KEY, Buffer.from('secret'), { contentType: 'application/pdf' });
    const file = join(store.rootDir, ...KEY.split('/'));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    for (const rel of ['', 'documents', KEY.split('/').slice(0, 2).join('/')]) {
      expect((await stat(join(store.rootDir, rel))).mode & 0o777).toBe(0o700);
    }
  });

  it('list returns keys under a prefix, sorted, ignoring temp files', async () => {
    await store.put('documents/p1/b', Buffer.from('1'), { contentType: 'image/png' });
    await store.put('documents/p1/a', Buffer.from('2'), { contentType: 'image/png' });
    await store.put('documents/p2/c', Buffer.from('3'), { contentType: 'image/png' });
    await store.put('other/x', Buffer.from('4'), { contentType: 'image/png' });
    await writeFile(join(store.rootDir, 'documents', 'p1', '.tmp-deadbeef'), 'partial');
    expect(await store.list('documents/')).toEqual(['documents/p1/a', 'documents/p1/b', 'documents/p2/c']);
    expect(await store.list('documents/p1/')).toEqual(['documents/p1/a', 'documents/p1/b']);
    expect(await store.list('documents/p1/a')).toEqual(['documents/p1/a']);
    expect(await store.list('')).toHaveLength(4);
    expect(await store.list('nothing/here/')).toEqual([]);
  });

  describe('key safety', () => {
    const bad = [
      '',
      '/etc/passwd',
      '../outside',
      'documents/../../outside',
      'documents/..',
      'documents/./x',
      'documents//x',
      'documents\\x',
      'documents/x/',
      '.hidden',
      'documents/.tmp-1',
      'doc\0uments/x',
      'documents/a b',
      'C:\\windows',
      '..%2f..%2fetc',
      'a'.repeat(600),
    ];
    for (const key of bad) {
      it(`rejects ${JSON.stringify(key.slice(0, 30))}`, async () => {
        await expect(store.put(key, Buffer.from('x'), { contentType: 'image/png' })).rejects.toBeInstanceOf(
          StorageKeyError,
        );
        await expect(store.get(key)).rejects.toBeInstanceOf(StorageKeyError);
        await expect(store.head(key)).rejects.toBeInstanceOf(StorageKeyError);
        await expect(store.delete(key)).rejects.toBeInstanceOf(StorageKeyError);
      });
    }

    it('rejects traversal prefixes in list', async () => {
      await expect(store.list('../')).rejects.toBeInstanceOf(StorageKeyError);
      await expect(store.list('/')).rejects.toBeInstanceOf(StorageKeyError);
      await expect(store.list('documents/../..')).rejects.toBeInstanceOf(StorageKeyError);
    });

    it('never writes outside the root', async () => {
      await store.put('documents/p/ok', Buffer.from('x'), { contentType: 'image/png' });
      await expect(store.put('../escape', Buffer.from('x'), { contentType: 'image/png' })).rejects.toBeInstanceOf(
        StorageKeyError,
      );
      expect(await readdir(dir)).toEqual(['root']);
    });

    it('list does not follow symlinks out of the root', async () => {
      await store.put('documents/p/ok', Buffer.from('x'), { contentType: 'image/png' });
      await symlink(tmpdir(), join(store.rootDir, 'documents', 'link'));
      expect(await store.list('documents/')).toEqual(['documents/p/ok']);
    });
  });
});

describe('factories', () => {
  it('defaults to local-disk and honours STORAGE_DIR', () => {
    const s = createObjectStorage({ STORAGE_DIR: dir });
    expect(s).toBeInstanceOf(LocalDiskStorage);
    expect((s as LocalDiskStorage).rootDir).toBe(dir);
  });

  it('gcs is a stub that throws NotConfigured on every call', async () => {
    const s = createObjectStorage({ OBJECT_STORAGE: 'gcs' });
    expect(s).toBeInstanceOf(GcsStorage);
    await expect(s.put('documents/a/b', Buffer.from('x'), { contentType: 'image/png' })).rejects.toBeInstanceOf(
      NotConfiguredError,
    );
    await expect(s.get('x')).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it('rejects an unknown kind', () => {
    expect(() => createObjectStorage({ OBJECT_STORAGE: 's4' })).toThrow(/OBJECT_STORAGE/);
  });
});
