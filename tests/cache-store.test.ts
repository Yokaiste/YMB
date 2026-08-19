import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import packageDefinition from '../package.json' with { type: 'json' };
import {
  getCacheSalt,
  hashSourceTree,
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
      expect(entry?.meta.encoding).toBe('identity');
      expect(entry?.meta.contentBytes).toBe(new TextEncoder().encode(content).byteLength);
      expect(entry?.meta.extra).toEqual({ prioritizedModId: 'alpha' });

      const leftovers = (await readdir(cacheRoot)).filter((name) => name.endsWith('.tmp'));
      expect(leftovers).toEqual([]);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  test('compresses large payloads and verifies their uncompressed content', async () => {
    const cacheRoot = await createTempCacheRoot();
    try {
      const cachePath = path.join(cacheRoot, 'large.json');
      const content = JSON.stringify({ values: Array.from({ length: 80_000 }, () => 'repeat') });
      await writeCacheEntryAtomic(cachePath, 'script-json:large', content);

      const entry = await readCacheEntry(cachePath, 'script-json:large');
      expect(entry?.content).toBe(content);
      expect(entry?.meta.encoding).toBe('gzip');
      expect((await stat(cachePath)).size).toBeLessThan(content.length / 10);
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

  test('rejects compressed entries before expansion when their declared size is unsafe', async () => {
    const cacheRoot = await createTempCacheRoot();
    try {
      const cachePath = path.join(cacheRoot, 'compressed.bin');
      const content = 'repeat'.repeat(100_000);
      await writeCacheEntryAtomic(cachePath, 'patch', content);

      const raw = await Bun.file(cachePath).bytes();
      const headerEnd = raw.indexOf(10);
      expect(headerEnd).toBeGreaterThan(0);
      const header = JSON.parse(new TextDecoder().decode(raw.subarray(0, headerEnd))) as Record<
        string,
        unknown
      >;
      expect(header.encoding).toBe('gzip');
      header.contentBytes = 1;
      await Bun.write(
        cachePath,
        new Blob([`${JSON.stringify(header)}\n`, raw.subarray(headerEnd + 1)]),
      );

      expect(await readCacheEntry(cachePath, 'patch')).toBeUndefined();

      header.contentBytes = Number.MAX_SAFE_INTEGER;
      await Bun.write(
        cachePath,
        new Blob([`${JSON.stringify(header)}\n`, raw.subarray(headerEnd + 1)]),
      );
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
      await writeFile(
        path.join(cacheRoot, 'legacy.ndf'),
        `${JSON.stringify({ schema: 2, kind: 'patch', contentHash: 'old' })}\nold`,
      );

      const removed = await pruneCacheDirectory(cacheRoot, { maxEntries: 3, maxAgeDays: 14 });

      expect(removed).toBe(5);
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

  test('prunes oldest entries to the total byte budget', async () => {
    const cacheRoot = await createTempCacheRoot();
    try {
      const paths: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const cachePath = path.join(cacheRoot, `entry-${index}.bin`);
        paths.push(cachePath);
        await writeCacheEntryAtomic(cachePath, 'patch', String(index).repeat(100));
        const modifiedAt = new Date(Date.now() + index * 1000);
        await utimes(cachePath, modifiedAt, modifiedAt);
      }
      const newestTwoBytes = (await stat(paths[1] ?? '')).size + (await stat(paths[2] ?? '')).size;

      const removed = await pruneCacheDirectory(cacheRoot, {
        maxEntries: 10,
        maxAgeDays: 14,
        maxBytes: newestTwoBytes,
      });

      expect(removed).toBe(1);
      expect((await readdir(cacheRoot)).sort()).toEqual(['entry-1.bin', 'entry-2.bin']);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  /** A fixed 4 KiB peek found no line break in a large header and deleted the entry as unreadable. */
  test('keeps an entry whose header is larger than the peek window', async () => {
    const cacheRoot = await createTempCacheRoot();
    try {
      const cachePath = path.join(cacheRoot, 'wide-header.bin');
      const notices = Array.from({ length: 30 }, (_, index) => ({
        patchId: 'sample.armor',
        operationIndex: index,
        reason: `\`Descriptor_Unit_${index}.FrontArmor\` is already \`5\`, so this changed nothing.`,
        suggestion: 'Delete the operation if it is finished, or set the value you actually want.',
      }));
      await writeCacheEntryAtomic(cachePath, 'patch', 'patched', { notices });

      const headerBytes = (await Bun.file(cachePath).bytes()).indexOf(10);
      expect(headerBytes).toBeGreaterThan(4096);

      const removed = await pruneCacheDirectory(cacheRoot, {
        maxEntries: 10,
        maxAgeDays: 14,
        maxBytes: 1024 * 1024,
      });

      expect(removed).toBe(0);
      expect(await readdir(cacheRoot)).toEqual(['wide-header.bin']);
      expect((await readCacheEntry(cachePath, 'patch'))?.content).toBe('patched');
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });
});

async function createSourceTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ymb-source-tree-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
  }
  return root;
}

describe('cache salt', () => {
  test('follows TypeScript content and ignores every other file', async () => {
    const root = await createSourceTree({
      'core.ts': 'export const value = 1;\n',
      'patch/values.ts': 'export const rendered = "a";\n',
      'notes.md': 'documentation',
      'fixture.ndf': 'export Descriptor_Unit_A is TDescriptor\n(\n)\n',
    });
    try {
      const baseline = hashSourceTree(root);

      await writeFile(path.join(root, 'notes.md'), 'rewritten', 'utf8');
      await writeFile(path.join(root, 'fixture.ndf'), 'export Module_B is TModule\n(\n)\n', 'utf8');
      expect(hashSourceTree(root)).toBe(baseline);

      await writeFile(
        path.join(root, 'patch', 'values.ts'),
        'export const rendered = "b";\n',
        'utf8',
      );
      expect(hashSourceTree(root)).not.toBe(baseline);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('covers where a file sits, not only what it holds', async () => {
    const root = await createSourceTree({ 'core.ts': 'export const value = 1;\n' });
    try {
      const baseline = hashSourceTree(root);
      await rename(path.join(root, 'core.ts'), path.join(root, 'renamed.ts'));
      expect(hashSourceTree(root)).not.toBe(baseline);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('an empty tree still hashes rather than throwing', async () => {
    const root = await createSourceTree({});
    try {
      expect(hashSourceTree(root)).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('salts cache keys with the package version and the builder sources', () => {
    const salt = getCacheSalt();

    expect(salt).toContain(`:${packageDefinition.version}:`);
    expect(salt.endsWith(hashSourceTree(path.resolve(import.meta.dir, '..', 'src')))).toBe(true);
    // Computed once per process, so every worker key in one build agrees.
    expect(getCacheSalt()).toBe(salt);
  });
});
