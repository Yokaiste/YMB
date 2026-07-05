import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { CooperativeYieldController } from '../async.ts';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { validateNdf, validateNdfCooperative } from '../patch/ndf.ts';
import type { BuildPlan } from '../types.ts';
import { hashText } from './shared.ts';
import type { ResolvedPatchContribution } from './types.ts';

const PATCH_CACHE_VERSION = 1;

interface PatchCacheMetadata {
  contentHash: string;
}

export function createPatchCacheKey(
  baseText: string,
  contributions: ResolvedPatchContribution[],
  targetRelativePath: string,
): string {
  return hashText(
    JSON.stringify({
      version: PATCH_CACHE_VERSION,
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
  targetRelativePath: string,
  yieldController?: CooperativeYieldController,
): Promise<string | undefined> {
  try {
    const cachePath = resolvePatchCachePath(plan, cacheKey);
    const cacheFile = Bun.file(cachePath);
    if (!(await cacheFile.exists())) {
      return undefined;
    }

    const cachedText = await cacheFile.text();
    const cachedHash = hashText(cachedText);
    if (await hasTrustedPatchCacheMetadata(plan, cacheKey, cachedHash)) {
      return cachedText;
    }

    if (yieldController) {
      await validateNdfCooperative(cachedText, targetRelativePath, yieldController);
    } else {
      validateNdf(cachedText, targetRelativePath);
    }
    await savePatchCacheMetadata(plan, cacheKey, cachedHash);
    return cachedText;
  } catch {
    return undefined;
  }
}

export async function saveCachedPatchOutput(
  plan: BuildPlan,
  cacheKey: string,
  updatedText: string,
): Promise<void> {
  try {
    const cachePath = resolvePatchCachePath(plan, cacheKey);
    const contentHash = hashText(updatedText);
    await mkdir(path.dirname(cachePath), { recursive: true });
    await Bun.write(cachePath, updatedText);
    await savePatchCacheMetadata(plan, cacheKey, contentHash);
  } catch {
    // Cache failures should never block a build.
  }
}

function resolvePatchCachePath(plan: BuildPlan, cacheKey: string): string {
  return path.join(
    plan.context.buildRoot,
    BUILDER_CONFIG.cacheDirectoryName,
    BUILDER_CONFIG.patchCacheDirectoryName,
    `${cacheKey}.ndf`,
  );
}

function resolvePatchCacheMetadataPath(plan: BuildPlan, cacheKey: string): string {
  return path.join(
    plan.context.buildRoot,
    BUILDER_CONFIG.cacheDirectoryName,
    BUILDER_CONFIG.patchCacheDirectoryName,
    `${cacheKey}.meta.json`,
  );
}

async function hasTrustedPatchCacheMetadata(
  plan: BuildPlan,
  cacheKey: string,
  contentHash: string,
): Promise<boolean> {
  try {
    const metadataFile = Bun.file(resolvePatchCacheMetadataPath(plan, cacheKey));
    if (!(await metadataFile.exists())) {
      return false;
    }

    const metadata = JSON.parse(await metadataFile.text()) as PatchCacheMetadata;
    return metadata.contentHash === contentHash;
  } catch {
    return false;
  }
}

async function savePatchCacheMetadata(
  plan: BuildPlan,
  cacheKey: string,
  contentHash: string,
): Promise<void> {
  const metadataPath = resolvePatchCacheMetadataPath(plan, cacheKey);
  await Bun.write(
    metadataPath,
    JSON.stringify({
      contentHash,
    } satisfies PatchCacheMetadata),
  );
}
