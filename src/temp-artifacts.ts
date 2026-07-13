import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { CooperativeYieldController } from './async.ts';
import { BUILDER_CONFIG } from './builder-config.ts';
import {
  assertOwnedRelativePath,
  assertRealPathWithinRoot,
  isMissingPathError,
  pathExists,
  removePathDirectly,
} from './path-utils.ts';
import { createTemplateVariables, resolveTemplateValue } from './templates.ts';
import type {
  BuilderContext,
  BuildPlan,
  DiscoveredMod,
  PatchApplication,
  TempArtifactConfig,
} from './types.ts';

export interface CleanupTarget {
  absolutePath: string;
  ownerRoot: string;
  ownerLabel: string;
  unsafeToRemove: boolean;
}

export async function collectCleanupTargets(
  plan: Pick<BuildPlan, 'context' | 'selectedMods' | 'selectedPatches'>,
): Promise<CleanupTarget[]> {
  const targets = new Map<string, CleanupTarget>();
  for (const artifactPath of await findYmbArtifactsInRoot(plan.context.ymbRoot)) {
    targets.set(artifactPath.absolutePath, artifactPath);
  }

  for (const configuredTempPath of collectConfiguredTempPaths(plan.context, plan.selectedMods)) {
    targets.set(configuredTempPath.absolutePath, configuredTempPath);
  }
  for (const configuredTempPath of collectConfiguredPatchTempPaths(
    plan.context,
    plan.selectedPatches,
  )) {
    targets.set(configuredTempPath.absolutePath, configuredTempPath);
  }

  return [...targets.values()].sort((left, right) =>
    left.absolutePath.localeCompare(right.absolutePath),
  );
}

export async function removeCleanupTargets(
  cleanupTargets: CleanupTarget[],
  options?: {
    yieldController?: CooperativeYieldController | undefined;
    onTargetStart?:
      | ((target: CleanupTarget, index: number, total: number) => void | Promise<void>)
      | undefined;
  },
): Promise<Array<{ absolutePath: string; removed: boolean; existed: boolean }>> {
  const results: Array<{ absolutePath: string; removed: boolean; existed: boolean }> = [];
  for (const [targetIndex, target] of cleanupTargets.entries()) {
    await options?.yieldController?.maybeYield();
    await options?.onTargetStart?.(target, targetIndex, cleanupTargets.length);
    const { absolutePath } = target;
    const existed = await pathExists(absolutePath);
    try {
      await assertRealPathWithinRoot(absolutePath, target.ownerRoot, target.ownerLabel);
      await removePathDirectly(absolutePath, { recursive: true });
      results.push({ absolutePath, removed: true, existed });
    } catch {
      results.push({ absolutePath, removed: false, existed });
    }
  }
  return results;
}

function collectConfiguredTempPaths(
  context: BuilderContext,
  selectedMods: DiscoveredMod[],
): CleanupTarget[] {
  return collectConfiguredOwnedTempPaths(selectedMods, (mod) => ({
    ownerRoot: mod.configAbsolutePath,
    ownerLabel: 'source mod config root',
    tempPaths: mod.config.tempPaths,
    templateVariables: createTemplateVariables(context, mod),
  }));
}

function collectConfiguredPatchTempPaths(
  context: BuilderContext,
  selectedPatches: PatchApplication[],
): CleanupTarget[] {
  return collectConfiguredOwnedTempPaths(selectedPatches, (selectedPatch) => ({
    ownerRoot: selectedPatch.patch.absolutePath,
    ownerLabel: 'patch root',
    tempPaths: selectedPatch.patch.config.tempPaths,
    templateVariables: createTemplateVariables(context, selectedPatch.mod, selectedPatch.patch),
  }));
}

async function findYmbArtifactsInRoot(ownerRoot: string): Promise<CleanupTarget[]> {
  const results: CleanupTarget[] = [];
  const pendingDirectories = [ownerRoot];
  let pendingIndex = 0;

  while (pendingIndex < pendingDirectories.length) {
    const currentDirectory = pendingDirectories[pendingIndex] as string;
    pendingIndex += 1;

    let entries: Dirent<string>[];
    try {
      entries = await readdir(currentDirectory, { withFileTypes: true, encoding: 'utf8' });
    } catch (error) {
      if (isMissingPathError(error)) {
        continue;
      }
      throw error;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absoluteEntryPath = path.join(currentDirectory, entry.name);
      if (
        entry.name === BUILDER_CONFIG.operationLockDirectoryName ||
        entry.name === BUILDER_CONFIG.stateTransactionDirectoryName
      ) {
        continue;
      }
      if (entry.name.startsWith(BUILDER_CONFIG.tempPrefix)) {
        results.push({
          absolutePath: absoluteEntryPath,
          ownerRoot,
          ownerLabel: 'builder root',
          unsafeToRemove: entry.name === BUILDER_CONFIG.stateDirectoryName,
        });
        continue;
      }
      if (entry.isDirectory()) {
        pendingDirectories.push(absoluteEntryPath);
      }
    }
  }

  return results;
}

function collectConfiguredOwnedTempPaths<TOwner>(
  owners: TOwner[],
  getResolvedConfig: (owner: TOwner) => {
    ownerRoot: string;
    ownerLabel: string;
    tempPaths: TempArtifactConfig[];
    templateVariables: Record<string, unknown>;
  },
): CleanupTarget[] {
  return owners.flatMap((owner) => {
    const resolvedConfig = getResolvedConfig(owner);
    return resolvedConfig.tempPaths.map((tempPath) => ({
      absolutePath: resolveConfiguredTempPath(
        resolvedConfig.ownerRoot,
        resolvedConfig.ownerLabel,
        String(resolveTemplateValue(tempPath.path, resolvedConfig.templateVariables)),
      ),
      ownerRoot: resolvedConfig.ownerRoot,
      ownerLabel: resolvedConfig.ownerLabel,
      unsafeToRemove: tempPath.unsafeToRemove,
    }));
  });
}

function resolveConfiguredTempPath(
  ownerRoot: string,
  ownerLabel: string,
  configuredPath: string,
): string {
  const normalizedPath = assertOwnedRelativePath(configuredPath, ownerRoot, ownerLabel);
  return path.join(ownerRoot, ...normalizedPath.split('/'));
}
