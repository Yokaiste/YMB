import path from 'node:path';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { hashText } from '../hash.ts';
import type { BuildPlan, PatchNotice } from '../types.ts';
import { getCacheSalt, readCacheEntry, writeCacheEntryAtomic } from './cache-store.ts';
import { readCachedPatchNotices } from './patch-notices.ts';
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
): Promise<
  { text: string; notices: PatchNotice[]; prioritizedModId?: string | undefined } | undefined
> {
  const entry = await readCacheEntry(resolvePatchCachePath(plan, cacheKey), PATCH_CACHE_KIND);
  if (!entry) return undefined;
  const notices = readCachedPatchNotices(entry.meta.extra);
  const prioritizedModId = entry.meta.extra?.prioritizedModId;
  if (!notices || (prioritizedModId !== undefined && typeof prioritizedModId !== 'string'))
    return undefined;
  return { text: entry.content, notices, prioritizedModId };
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
