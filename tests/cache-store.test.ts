import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  pruneCacheDirectory,
  readCacheEntry,
  writeCacheEntryAtomic,
} from '../src/engine/cache-store.ts';

async function createTempCacheRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'ymb-cache-store-'));
}

describe('cache store', () => {
  test('round-trips content and extra metadata', async () => {
    const cacheRoot = await createTempCacheRoot();
    try {
      const cachePath = path.join(cacheRoot, 'entry.ndf');
      const content = 'export Block is TDescriptor\n(\n    Value = 1\n)\n';
      await writeCacheEntryAtomic(cachePath, 'patch', content, { prioritizedModId: 'alpha' });

      const entry = await readCacheEntry(cachePath, 'patch');
      expect(entry?.content).toBe(content);
      expect(entry?.meta.extra).toEqual({ prioritizedModId: 'alpha' });

      const leftovers = (await readdir(cacheRoot)).filter((name) => name.endsWith('.tmp'));
      expect(leftovers).toEqual([]);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  test('rejects corrupted headers, wrong kinds, and tampered content', async () => {
    const cacheRoot = await createTempCacheRoot();
    try {
      const cachePath = path.join(cacheRoot, 'entry.ndf');
      await writeCacheEntryAtomic(cachePath, 'patch', 'payload');

      expect(await readCacheEntry(cachePath, 'other-kind')).toBeUndefined();

      const raw = await Bun.file(cachePath).text();
      await writeFile(cachePath, raw.replace('payload', 'tampered'));
      expect(await readCacheEntry(cachePath, 'patch')).toBeUndefined();

      await writeFile(cachePath, 'not-json\npayload');
      expect(await readCacheEntry(cachePath, 'patch')).toBeUndefined();

      await writeFile(cachePath, 'no newline at all');
      expect(await readCacheEntry(cachePath, 'patch')).toBeUndefined();
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  test('prunes stale entries by age and trims to the entry budget', async () => {
    const cacheRoot = await createTempCacheRoot();
    try {
      const staleDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await writeCacheEntryAtomic(path.join(cacheRoot, 'stale.ndf'), 'patch', 'old');
      await utimes(path.join(cacheRoot, 'stale.ndf'), staleDate, staleDate);
      for (let index = 0; index < 5; index += 1) {
        await writeCacheEntryAtomic(path.join(cacheRoot, `fresh-${index}.ndf`), 'patch', 'new');
      }
      await writeFile(path.join(cacheRoot, '.ymb-orphan.tmp'), 'torn write leftover');

      const removed = await pruneCacheDirectory(cacheRoot, { maxEntries: 3, maxAgeDays: 14 });

      expect(removed).toBe(4);
      const remaining = await readdir(cacheRoot);
      expect(remaining).toHaveLength(3);
      expect(remaining.every((name) => name.startsWith('fresh-'))).toBe(true);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  test('prune tolerates a missing cache directory', async () => {
    expect(await pruneCacheDirectory(path.join(tmpdir(), 'ymb-cache-missing-dir'))).toBe(0);
  });
});
