import { type Dirent, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import packageDefinition from '../../package.json' with { type: 'json' };
import { mapConcurrent } from '../async.ts';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { hashBytes, hashText } from '../hash.ts';
import { isMissingPathError, statIfExists, writeFileAtomic } from '../path-utils.ts';

const CACHE_SCHEMA_VERSION = 4;
const CACHE_COMPRESSION_THRESHOLD_BYTES = 256 * 1024;
const CACHE_IO_CONCURRENCY = 8;
// A cache miss only costs recomputation. Refusing an implausibly large single
// entry is safer than letting corrupted compressed data consume the process.
const CACHE_MAX_ENTRY_CONTENT_BYTES = 256 * 1024 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
let cacheSalt: string | undefined;

/**
 * Cache keys hash inputs, not the code that turns them into output. A release gets
 * away with that because its version changes with the build; a source checkout does
 * not. Folding the builder sources in costs one full rebuild per edit. Workers read
 * the same files, so they reach the same salt without being told it.
 */
export function getCacheSalt(): string {
  cacheSalt ??= `${CACHE_SCHEMA_VERSION}:${packageDefinition.version}:${resolveBuilderSourceDigest()}`;
  return cacheSalt;
}

function resolveBuilderSourceDigest(): string {
  // A release bundles every module into `app/*.js` and ships no TypeScript, so
  // there is nothing to hash and nothing that can change without the version.
  if (!import.meta.url.endsWith('.ts')) {
    return 'packaged';
  }
  try {
    return hashSourceTree(path.resolve(import.meta.dir, '..'));
  } catch {
    // An unreadable checkout must not stop a build. Falling back leaves the
    // version-only salt, which is what this was before.
    return 'unreadable';
  }
}

/**
 * A content digest of every TypeScript file under `rootPath`, independent of
 * the order the directory happens to be read in.
 */
export function hashSourceTree(rootPath: string): string {
  const relativePaths = readdirSync(rootPath, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) =>
      path.relative(rootPath, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
    )
    .sort();
  return hashText(
    relativePaths
      .map(
        (relativePath) =>
          `${relativePath}:${hashText(readFileSync(path.join(rootPath, relativePath), 'utf8'))}`,
      )
      .join(' '),
  );
}

interface CacheEnvelopeMeta {
  schema: number;
  kind: string;
  contentHash: string;
  contentBytes: number;
  encoding: 'identity' | 'gzip';
  extra?: Record<string, unknown> | undefined;
}

export async function readCacheEntry(
  cachePath: string,
  expectedKind: string,
): Promise<{ meta: CacheEnvelopeMeta; content: string } | undefined> {
  try {
    const cacheStats = await statIfExists(cachePath);
    if (
      !cacheStats?.isFile() ||
      cacheStats.size > CACHE_MAX_ENTRY_CONTENT_BYTES + HEADER_PEEK_MAX_BYTES
    ) {
      return undefined;
    }

    const envelopeHeader = await readCacheEnvelopeHeader(cachePath);
    if (envelopeHeader === undefined) {
      return undefined;
    }

    const meta = parseCacheEnvelopeMeta(JSON.parse(envelopeHeader.text));
    if (!meta || meta.schema !== CACHE_SCHEMA_VERSION || meta.kind !== expectedKind) {
      return undefined;
    }

    const payload = new Uint8Array(
      await Bun.file(cachePath).slice(envelopeHeader.payloadOffset).arrayBuffer(),
    );
    const contentBytes =
      meta.encoding === 'gzip'
        ? gunzipSync(payload, { maxOutputLength: meta.contentBytes })
        : payload;
    // `contentHash` is the digest of the UTF-8 the entry was written from, which
    // is exactly these bytes. Checking them settles the entry before decoding,
    // and without encoding a 27 MB string back to the bytes already in hand.
    if (
      contentBytes.byteLength !== meta.contentBytes ||
      hashBytes(contentBytes) !== meta.contentHash
    ) {
      return undefined;
    }
    const content = textDecoder.decode(contentBytes);

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
    candidate.kind.length === 0 ||
    typeof candidate.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(candidate.contentHash) ||
    typeof candidate.contentBytes !== 'number' ||
    !Number.isSafeInteger(candidate.contentBytes) ||
    candidate.contentBytes < 0 ||
    candidate.contentBytes > CACHE_MAX_ENTRY_CONTENT_BYTES ||
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
    contentBytes: candidate.contentBytes,
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
    if (content.length > CACHE_MAX_ENTRY_CONTENT_BYTES) {
      return;
    }
    const contentBytes = textEncoder.encode(content);
    if (contentBytes.byteLength > CACHE_MAX_ENTRY_CONTENT_BYTES) {
      return;
    }
    const shouldCompress = contentBytes.byteLength >= CACHE_COMPRESSION_THRESHOLD_BYTES;
    const meta: CacheEnvelopeMeta = {
      schema: CACHE_SCHEMA_VERSION,
      kind,
      contentHash: hashBytes(contentBytes),
      contentBytes: contentBytes.byteLength,
      encoding: shouldCompress ? 'gzip' : 'identity',
      ...(extra ? { extra } : {}),
    };
    const header = textEncoder.encode(`${JSON.stringify(meta)}\n`);
    const payload = shouldCompress ? Bun.gzipSync(contentBytes) : contentBytes;
    await mkdir(path.dirname(cachePath), { recursive: true });
    // Written as two parts rather than joined into one, which would hold a third
    // full copy of the payload alongside the content and its encoding.
    await writeFileAtomic(cachePath, new Blob([header, payload]));
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

    const invalidPaths = await mapConcurrent(entries, CACHE_IO_CONCURRENCY, async (entry) => {
      const invalid =
        now - entry.modifiedAtMs > maxAgeMs ||
        entry.name.endsWith('.tmp') ||
        !(await hasCurrentCacheEnvelope(entry.absolutePath));
      return invalid ? entry.absolutePath : undefined;
    });
    for (const invalidPath of invalidPaths) {
      if (invalidPath !== undefined) removable.add(invalidPath);
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

    await mapConcurrent([...removable], CACHE_IO_CONCURRENCY, async (absolutePath) => {
      await rm(absolutePath, { force: true });
    });

    return removable.size;
  } catch {
    return 0;
  }
}

/**
 * The header is one JSON line with no length bound -- `extra` can carry every notice
 * a target reported. A fixed peek treated those as unreadable and pruned them, so
 * the noisiest targets never served a warm build. The window grows to find the break.
 */
const HEADER_PEEK_START_BYTES = 4096;
const HEADER_PEEK_MAX_BYTES = 1024 * 1024;

async function readCacheEnvelopeHeader(
  absolutePath: string,
): Promise<{ text: string; payloadOffset: number } | undefined> {
  const cacheFile = Bun.file(absolutePath);
  for (
    let windowBytes = HEADER_PEEK_START_BYTES;
    windowBytes <= HEADER_PEEK_MAX_BYTES;
    windowBytes *= 2
  ) {
    const peeked = new Uint8Array(await cacheFile.slice(0, windowBytes).arrayBuffer());
    const headerEnd = peeked.indexOf(10);
    if (headerEnd !== -1) {
      return {
        text: textDecoder.decode(peeked.subarray(0, headerEnd)),
        payloadOffset: headerEnd + 1,
      };
    }
    // A short read means the window already covered the whole file, so there is
    // no line break anywhere in it.
    if (peeked.byteLength < windowBytes) {
      return undefined;
    }
  }
  return undefined;
}

async function hasCurrentCacheEnvelope(absolutePath: string): Promise<boolean> {
  try {
    const header = await readCacheEnvelopeHeader(absolutePath);
    if (header === undefined) {
      return false;
    }
    const meta = parseCacheEnvelopeMeta(JSON.parse(header.text));
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
    await mapConcurrent(entries, CACHE_IO_CONCURRENCY, async (entry) => {
      const absolutePath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(absolutePath);
        return;
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
    });
  }

  return results;
}
