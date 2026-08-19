import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { CooperativeYieldController } from './async.ts';
import { BUILDER_CONFIG } from './builder-config.ts';
import {
  assertOwnedRelativePath,
  assertRealPathWithinRoot,
  isMissingPathError,
  isPathInsideOrEqual,
  pathExists,
  removePathDirectly,
  toPathKey,
} from './path-utils.ts';
import { createTemplateVariables, resolveTemplateValue } from './templates.ts';
import type {
  BuilderContext,
  BuildPlan,
  DiscoveredMod,
  PatchApplication,
  TempArtifactConfig,
} from './types.ts';

interface CleanupTarget {
  absolutePath: string;
  ownerRoot: string;
  ownerLabel: string;
  unsafeToRemove: boolean;
}

type CleanupTargetStartHandler = (
  target: CleanupTarget,
  index: number,
  total: number,
) => void | Promise<void>;

const CLEANUP_SCAN_SKIP_DIRECTORIES = new Set(['.git', 'node_modules']);

interface RemoveCleanupTargetOptions {
  yieldController?: CooperativeYieldController | undefined;
  onTargetStart?: CleanupTargetStartHandler | undefined;
}

export async function collectCleanupTargets(
  plan: Pick<BuildPlan, 'context' | 'selectedMods' | 'selectedPatches'>,
): Promise<CleanupTarget[]> {
  const targets = new Map<string, CleanupTarget>();
  const addTarget = (target: CleanupTarget) => {
    // Keyed case-insensitively, like every other path map in YMB: WARNO is a
    // Windows game, so `.ymb-store.json` and `.YMB-Store.json` are one file. Two
    // entries for it would defeat the merge below and delete a path another
    // source marked as holding undo data.
    const targetKey = toPathKey(target.absolutePath);
    const existing = targets.get(targetKey);
    // One path can be reached by more than one source, and only one of them may
    // know it holds the data an undo depends on. Never let a later source
    // downgrade that: the cost of keeping a temp file is a temp file, and the
    // cost of the mistake is an unrecoverable sync.
    targets.set(targetKey, {
      ...target,
      unsafeToRemove: target.unsafeToRemove || (existing?.unsafeToRemove ?? false),
    });
  };

  for (const cleanupRoot of collectBuilderCleanupRoots(plan.context)) {
    addTarget(cleanupRoot);
  }
  for (const artifactPath of await findYmbArtifactsInRoot(
    plan.context.ymbRoot,
    plan.context.stateRoot,
  )) {
    addTarget(artifactPath);
  }

  for (const configuredTempPath of collectConfiguredTempPaths(plan.context, plan.selectedMods)) {
    addTarget(configuredTempPath);
  }
  for (const configuredTempPath of collectConfiguredPatchTempPaths(
    plan.context,
    plan.selectedPatches,
  )) {
    addTarget(configuredTempPath);
  }

  return [...targets.values()].sort((left, right) =>
    left.absolutePath.localeCompare(right.absolutePath),
  );
}

function collectBuilderCleanupRoots(context: BuilderContext): CleanupTarget[] {
  return [
    {
      absolutePath: context.buildRoot,
      ownerRoot: context.buildRoot,
      ownerLabel: 'configured work root',
      unsafeToRemove: false,
    },
    {
      absolutePath: context.stateRoot,
      ownerRoot: context.stateRoot,
      ownerLabel: 'configured recovery root',
      unsafeToRemove: true,
    },
  ];
}

export async function removeCleanupTargets(
  cleanupTargets: CleanupTarget[],
  options?: RemoveCleanupTargetOptions,
): Promise<Array<{ absolutePath: string; removed: boolean; existed: boolean }>> {
  const results: Array<{ absolutePath: string; removed: boolean; existed: boolean }> = [];
  for (const [targetIndex, target] of cleanupTargets.entries()) {
    await options?.yieldController?.maybeYield();
    await options?.onTargetStart?.(target, targetIndex, cleanupTargets.length);
    const { absolutePath } = target;
    const existed = await pathExists(absolutePath);
    if (!existed) {
      results.push({ absolutePath, removed: true, existed: false });
      continue;
    }
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
    ownerRoot: mod.configDirectoryPath,
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

/**
 * `stateRoot` is passed in rather than assumed from the default directory name:
 * a project may configure `recoveryRoot` to another `.ymb*` path, and matching on
 * the name alone would find it here and call it disposable.
 */
async function findYmbArtifactsInRoot(
  ownerRoot: string,
  stateRoot: string,
): Promise<CleanupTarget[]> {
  const results: CleanupTarget[] = [];
  const pendingDirectories = [ownerRoot];
  let pendingIndex = 0;

  while (pendingIndex < pendingDirectories.length) {
    const currentDirectory = pendingDirectories[pendingIndex];
    pendingIndex += 1;
    if (currentDirectory === undefined) break;

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
          // The configured root by path, plus anything carrying the default
          // recovery name: one of those is this project's undo data, and the
          // other is undo data belonging to a checkout nested inside it.
          unsafeToRemove:
            isPathInsideOrEqual(stateRoot, absoluteEntryPath) ||
            entry.name === BUILDER_CONFIG.stateDirectoryName,
        });
        continue;
      }
      if (entry.isDirectory() && !CLEANUP_SCAN_SKIP_DIRECTORIES.has(entry.name)) {
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
