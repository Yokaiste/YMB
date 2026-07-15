import type { Dirent } from 'node:fs';
import { mkdir, readdir, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import packageDefinition from '../../package.json' with { type: 'json' };
import { BUILDER_CONFIG } from '../builder-config.ts';
import { hashText } from '../hash.ts';
import { isMissingPathError, statIfExists, writeFileAtomic } from '../path-utils.ts';

const CACHE_SCHEMA_VERSION = 2;
export const CACHE_SALT = `${CACHE_SCHEMA_VERSION}:${packageDefinition.version}`;

interface CacheEnvelopeMeta {
  schema: number;
  kind: string;
  contentHash: string;
  extra?: Record<string, unknown> | undefined;
}

export async function readCacheEntry(
  cachePath: string,
  expectedKind: string,
): Promise<{ meta: CacheEnvelopeMeta; content: string } | undefined> {
  try {
    const cacheFile = Bun.file(cachePath);
    if (!(await cacheFile.exists())) {
      return undefined;
    }

    const raw = await cacheFile.text();
    const headerEnd = raw.indexOf('\n');
    if (headerEnd === -1) {
      return undefined;
    }

    const meta = JSON.parse(raw.slice(0, headerEnd)) as CacheEnvelopeMeta;
    if (meta.schema !== CACHE_SCHEMA_VERSION || meta.kind !== expectedKind) {
      return undefined;
    }

    const content = raw.slice(headerEnd + 1);
    if (hashText(content) !== meta.contentHash) {
      return undefined;
    }

    const now = new Date();
    await utimes(cachePath, now, now).catch(() => undefined);
    return { meta, content };
  } catch {
    return undefined;
  }
}

export async function writeCacheEntryAtomic(
  cachePath: string,
  kind: string,
  content: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    const meta: CacheEnvelopeMeta = {
      schema: CACHE_SCHEMA_VERSION,
      kind,
      contentHash: hashText(content),
      ...(extra ? { extra } : {}),
    };
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFileAtomic(cachePath, `${JSON.stringify(meta)}\n${content}`);
  } catch {
    // Cache failures should never block a build.
  }
}

export async function pruneCacheDirectory(
  cacheRoot: string,
  options: { maxEntries?: number; maxAgeDays?: number; maxBytes?: number } = {},
): Promise<number> {
  const maxEntries = options.maxEntries ?? BUILDER_CONFIG.cacheMaxEntries;
  const maxBytes = options.maxBytes ?? BUILDER_CONFIG.cacheMaxBytes;
  const maxAgeMs = (options.maxAgeDays ?? BUILDER_CONFIG.cacheMaxAgeDays) * 24 * 60 * 60 * 1000;

  try {
    const entries = await collectCacheFiles(cacheRoot);
    const now = Date.now();
    const removable = new Set<string>();

    for (const entry of entries) {
      if (now - entry.modifiedAtMs > maxAgeMs || entry.name.endsWith('.tmp')) {
        removable.add(entry.absolutePath);
      }
    }

    const survivors = entries
      .filter((entry) => !removable.has(entry.absolutePath))
      .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
    let retainedBytes = 0;
    for (const [index, entry] of survivors.entries()) {
      if (index >= maxEntries || retainedBytes + entry.size > maxBytes) {
        removable.add(entry.absolutePath);
        continue;
      }
      retainedBytes += entry.size;
    }

    for (const absolutePath of removable) {
      await rm(absolutePath, { force: true });
    }

    return removable.size;
  } catch {
    return 0;
  }
}

async function collectCacheFiles(
  cacheRoot: string,
): Promise<{ absolutePath: string; name: string; modifiedAtMs: number; size: number }[]> {
  const results: { absolutePath: string; name: string; modifiedAtMs: number; size: number }[] = [];
  const pendingDirectories = [cacheRoot];

  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop() as string;
    let entries: Dirent[];
    try {
      entries = await readdir(currentDirectory, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      const absolutePath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(absolutePath);
        continue;
      }
      const stats = await statIfExists(absolutePath);
      if (stats?.isFile()) {
        results.push({
          absolutePath,
          name: entry.name,
          modifiedAtMs: stats.mtimeMs,
          size: stats.size,
        });
      }
    }
  }

  return results;
}
