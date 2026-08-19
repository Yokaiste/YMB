import path from 'node:path';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { hashText } from '../hash.ts';
import type { BuildPlan } from '../types.ts';
import { getCacheSalt, readCacheEntry, writeCacheEntryAtomic } from './cache-store.ts';
import type { ResolvedPatchContribution } from './types.ts';

const PATCH_CACHE_KIND = 'patch';

export type PatchCacheVariant = 'sequence' | 'merged' | `preview:${string}`;

export function createPatchCacheKey(
  baseText: string,
  contributions: ResolvedPatchContribution[],
  targetRelativePath: string,
  variant: PatchCacheVariant,
): string {
  return hashText(
    JSON.stringify({
      salt: getCacheSalt(),
      variant,
      targetRelativePath,
      baseHash: hashText(baseText),
      contributions: contributions.map((contribution) => ({
        modId: contribution.application.mod.config.id,
        patchId: contribution.application.patch.config.id,
        patchOrder: contribution.patchOrder,
        hasScripts: contribution.hasScripts,
        target: contribution.target,
      })),
    }),
  );
}

export async function loadCachedPatchOutput(
  plan: BuildPlan,
  cacheKey: string,
): Promise<{ text: string; extra?: Record<string, unknown> | undefined } | undefined> {
  const entry = await readCacheEntry(resolvePatchCachePath(plan, cacheKey), PATCH_CACHE_KIND);
  return entry ? { text: entry.content, extra: entry.meta.extra } : undefined;
}

export async function saveCachedPatchOutput(
  plan: BuildPlan,
  cacheKey: string,
  updatedText: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  await writeCacheEntryAtomic(
    resolvePatchCachePath(plan, cacheKey),
    PATCH_CACHE_KIND,
    updatedText,
    extra,
  );
}

function resolvePatchCachePath(plan: BuildPlan, cacheKey: string): string {
  return path.join(
    plan.context.buildCacheRoot,
    BUILDER_CONFIG.patchCacheDirectoryName,
    `${cacheKey}.ndf`,
  );
}
