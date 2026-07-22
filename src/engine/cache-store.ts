import type { Dirent } from 'node:fs';
import { mkdir, readdir, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import packageDefinition from '../../package.json' with { type: 'json' };
import { BUILDER_CONFIG } from '../builder-config.ts';
import { hashText } from '../hash.ts';
import { isMissingPathError, statIfExists, writeFileAtomic } from '../path-utils.ts';

const CACHE_SCHEMA_VERSION = 3;
const CACHE_COMPRESSION_THRESHOLD_BYTES = 256 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
export const CACHE_SALT = `${CACHE_SCHEMA_VERSION}:${packageDefinition.version}`;

interface CacheEnvelopeMeta {
  schema: number;
  kind: string;
  contentHash: string;
  encoding: 'identity' | 'gzip';
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

    const raw = new Uint8Array(await cacheFile.arrayBuffer());
    const headerEnd = raw.indexOf(10);
    if (headerEnd === -1) {
      return undefined;
    }

    const meta = parseCacheEnvelopeMeta(JSON.parse(textDecoder.decode(raw.subarray(0, headerEnd))));
    if (!meta || meta.schema !== CACHE_SCHEMA_VERSION || meta.kind !== expectedKind) {
      return undefined;
    }

    const payload = raw.subarray(headerEnd + 1);
    const contentBytes = meta.encoding === 'gzip' ? Bun.gunzipSync(payload) : payload;
    const content = textDecoder.decode(contentBytes);
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

function parseCacheEnvelopeMeta(value: unknown): CacheEnvelopeMeta | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.schema !== 'number' ||
    typeof candidate.kind !== 'string' ||
    typeof candidate.contentHash !== 'string' ||
    (candidate.encoding !== 'identity' && candidate.encoding !== 'gzip')
  ) {
    return undefined;
  }
  const extra = candidate.extra;
  if (extra !== undefined && (!extra || typeof extra !== 'object' || Array.isArray(extra))) {
    return undefined;
  }
  return {
    schema: candidate.schema,
    kind: candidate.kind,
    contentHash: candidate.contentHash,
    encoding: candidate.encoding,
    ...(extra ? { extra: extra as Record<string, unknown> } : {}),
  };
}

export async function writeCacheEntryAtomic(
  cachePath: string,
  kind: string,
  content: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    const contentBytes = textEncoder.encode(content);
    const shouldCompress = contentBytes.byteLength >= CACHE_COMPRESSION_THRESHOLD_BYTES;
    const meta: CacheEnvelopeMeta = {
      schema: CACHE_SCHEMA_VERSION,
      kind,
      contentHash: hashText(content),
      encoding: shouldCompress ? 'gzip' : 'identity',
      ...(extra ? { extra } : {}),
    };
    const header = textEncoder.encode(`${JSON.stringify(meta)}\n`);
    const payload = shouldCompress ? Bun.gzipSync(contentBytes) : contentBytes;
    const envelope = new Uint8Array(header.byteLength + payload.byteLength);
    envelope.set(header);
    envelope.set(payload, header.byteLength);
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFileAtomic(cachePath, envelope);
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
      if (
        now - entry.modifiedAtMs > maxAgeMs ||
        entry.name.endsWith('.tmp') ||
        !(await hasCurrentCacheEnvelope(entry.absolutePath))
      ) {
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

async function hasCurrentCacheEnvelope(absolutePath: string): Promise<boolean> {
  try {
    const headerPrefix = await Bun.file(absolutePath).slice(0, 4096).text();
    const headerEnd = headerPrefix.indexOf('\n');
    if (headerEnd === -1) {
      return false;
    }
    const meta = parseCacheEnvelopeMeta(JSON.parse(headerPrefix.slice(0, headerEnd)));
    return meta?.schema === CACHE_SCHEMA_VERSION;
  } catch {
    return false;
  }
}

async function collectCacheFiles(
  cacheRoot: string,
): Promise<{ absolutePath: string; name: string; modifiedAtMs: number; size: number }[]> {
  const results: { absolutePath: string; name: string; modifiedAtMs: number; size: number }[] = [];
  const pendingDirectories = [cacheRoot];

  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop();
    if (currentDirectory === undefined) break;
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
