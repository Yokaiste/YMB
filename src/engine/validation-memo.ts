import path from 'node:path';
import type { CooperativeYieldController } from '../async.ts';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { hashText } from '../hash.ts';
import { validateNdf, validateNdfCooperative } from '../patch/ndf.ts';
import { CACHE_SALT, readCacheEntry, writeCacheEntryAtomic } from './cache-store.ts';

const MEMO_CAPACITY = 256;

const validatedContentHashes = new Set<string>();
const NDF_VALIDATION_CACHE_KIND = 'ndf-validation';

export function validateNdfMemoized(text: string, absolutePath: string): void {
  const contentHash = hashText(text);
  if (validatedContentHashes.has(contentHash)) {
    return;
  }
  validateNdf(text, absolutePath);
  rememberValidated(contentHash);
}

export async function validateNdfMemoizedCooperative(
  text: string,
  absolutePath: string,
  yieldController: CooperativeYieldController,
): Promise<void> {
  const contentHash = hashText(text);
  if (validatedContentHashes.has(contentHash)) {
    return;
  }
  await validateNdfCooperative(text, absolutePath, yieldController);
  rememberValidated(contentHash);
}

export async function validateNdfPersistentlyMemoized(
  text: string,
  absolutePath: string,
  cacheRoot: string,
  yieldController?: CooperativeYieldController,
): Promise<boolean> {
  const contentHash = hashText(text);
  if (validatedContentHashes.has(contentHash)) {
    return true;
  }

  const cachePath = resolveNdfValidationCachePath(cacheRoot, contentHash);
  const cached = await readCacheEntry(cachePath, NDF_VALIDATION_CACHE_KIND);
  if (cached?.content === contentHash) {
    rememberValidated(contentHash);
    return true;
  }

  if (yieldController) {
    await validateNdfCooperative(text, absolutePath, yieldController);
  } else {
    validateNdf(text, absolutePath);
  }
  rememberValidated(contentHash);
  await writeCacheEntryAtomic(cachePath, NDF_VALIDATION_CACHE_KIND, contentHash);
  return false;
}

export function resolveNdfValidationCachePath(cacheRoot: string, contentHash: string): string {
  const cacheKey = hashText(`${CACHE_SALT}:${contentHash}`);
  return path.join(cacheRoot, BUILDER_CONFIG.ndfValidationCacheDirectoryName, `${cacheKey}.ok`);
}

export function resetValidationMemoForTests(): void {
  validatedContentHashes.clear();
}

function rememberValidated(contentHash: string): void {
  if (validatedContentHashes.size >= MEMO_CAPACITY) {
    const oldest = validatedContentHashes.values().next().value;
    if (oldest !== undefined) {
      validatedContentHashes.delete(oldest);
    }
  }
  validatedContentHashes.add(contentHash);
}
