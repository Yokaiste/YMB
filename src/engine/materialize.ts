import { createCooperativeYieldController } from '../async.ts';
import { ensure } from '../errors.ts';
import { resolvePrioritizedModId } from '../patch-priority.ts';
import { toPathKey } from '../path-utils.ts';
import { materializeScriptOutputs, type ScriptTestReporter } from '../scripts/materialize.ts';
import { tryMergeTextContributionsCooperative } from '../text-merge.ts';
import type {
  BuildContributor,
  BuildPlan,
  DiscoveredMod,
  ReplaceFile,
  WrittenBuildFile,
} from '../types.ts';
import {
  createPatchCacheKey,
  loadCachedPatchOutput,
  saveCachedPatchOutput,
} from './patch-cache.ts';
import {
  applyContributionSequenceCached,
  buildPatchPriorityContributions,
  comparePatchContributions,
  dedupeContributors,
  groupPatchContributions,
  loadBasePatchText,
} from './patch-contributions.ts';
import { abbreviateProgressPath, reportProgress } from './progress.ts';
import { materializeReplaceOutputs } from './replace-materialize.ts';
import type { ResolvedPatchContribution } from './types.ts';

export { materializeReplaceOutputs, validateReplaceOutputs } from './replace-materialize.ts';

export interface MaterializationMetrics {
  patchCacheHits: number;
  patchCacheMisses: number;
  patchCacheBypassed: number;
  mergedCacheHits: number;
  mergedCacheMisses: number;
}

export async function materializeBuild(
  plan: BuildPlan,
  metrics?: MaterializationMetrics,
  reportScriptTest?: ScriptTestReporter,
): Promise<WrittenBuildFile[]> {
  const outputMap = new Map<string, WrittenBuildFile>();
  const priorityBuckets = groupModsByMaterializationLayer(plan.selectedMods);
  const yieldController = createCooperativeYieldController();

  for (const bucketMods of priorityBuckets) {
    await yieldController.maybeYield();
    const bucketModIds = new Set(bucketMods.map((mod) => mod.config.id));
    const bucketPlan = {
      ...plan,
      selectedMods: bucketMods,
      selectedPatches: plan.selectedPatches.filter((selected) =>
        bucketModIds.has(selected.mod.config.id),
      ),
      selectedReplaceFiles: plan.selectedReplaceFiles.filter((file) =>
        bucketModIds.has(file.modId),
      ),
      selectedScripts: plan.selectedScripts.filter((script) =>
        bucketModIds.has(script.mod.config.id),
      ),
    };
    const bucketScriptsByModId = groupByModId(
      bucketPlan.selectedScripts,
      (script) => script.mod.config.id,
    );
    const bucketReplaceFilesByModId = groupByModId(
      bucketPlan.selectedReplaceFiles,
      (file) => file.modId,
    );
    const lowerPriorityReplaceFilesByPriority = new Map<number, ReplaceFile[]>();

    reportProgress('Materializing patch outputs');
    const patchFiles = await materializePatchOutputs(bucketPlan, metrics, outputMap);
    const bucketOutputMap = new Map<string, WrittenBuildFile>(
      patchFiles.map((file) => [toPathKey(file.targetRelativePath), file] as const),
    );

    for (const mod of bucketMods) {
      const visibleExistingFiles = buildVisibleExistingFiles(mod, outputMap, bucketOutputMap);
      const visibleReplaceFiles = buildVisibleReplaceFiles(
        mod,
        plan.selectedReplaceFiles,
        bucketPlan.selectedReplaceFiles,
        bucketReplaceFilesByModId,
        lowerPriorityReplaceFilesByPriority,
      );
      const modScripts = bucketScriptsByModId.get(mod.config.id) ?? [];
      const modScriptPlan = {
        ...bucketPlan,
        selectedMods: [mod],
        selectedScripts: modScripts,
        selectedReplaceFiles: visibleReplaceFiles,
      };

      if (modScriptPlan.selectedScripts.length === 0) {
        continue;
      }

      reportProgress('Running generation scripts');
      const scriptFiles = await materializeScriptOutputs(
        modScriptPlan,
        visibleExistingFiles,
        reportScriptTest,
      );
      for (const scriptFile of scriptFiles) {
        bucketOutputMap.set(toPathKey(scriptFile.targetRelativePath), scriptFile);
      }
    }

    reportProgress('Materializing replace outputs');
    const replaceFiles = await materializeReplaceOutputs(bucketPlan, yieldController);
    for (const writtenFile of [...bucketOutputMap.values(), ...replaceFiles]) {
      outputMap.set(toPathKey(writtenFile.targetRelativePath), writtenFile);
    }
  }

  return [...outputMap.values()].sort((left, right) =>
    left.targetRelativePath.localeCompare(right.targetRelativePath),
  );
}

export async function materializePatchOutputs(
  plan: BuildPlan,
  metrics?: MaterializationMetrics,
  previousOutputs = new Map<string, WrittenBuildFile>(),
): Promise<WrittenBuildFile[]> {
  const writtenFiles: WrittenBuildFile[] = [];
  const patchGroups = groupPatchContributions(plan);
  const yieldController = createCooperativeYieldController();
  const totalGroups = patchGroups.size;

  for (const patchGroup of patchGroups.values()) {
    await yieldController.maybeYield();
    const firstContribution = patchGroup[0];
    ensure(firstContribution, 'ConflictError', {
      absolutePath: '<patch-group>',
      reason: 'Patch contribution group is empty.',
      suggestion:
        'Re-run the command. If the problem persists, inspect how patch targets were grouped for this build.',
    });
    reportProgress(
      'Materializing patch outputs',
      abbreviateProgressPath(firstContribution.targetRelativePath),
      {
        current: writtenFiles.length + 1,
        total: totalGroups,
      },
    );
    const baseText = await loadBasePatchText(plan, firstContribution, previousOutputs);
    const distinctModIds = new Set(
      patchGroup.map((contribution) => contribution.application.mod.config.id),
    );
    const { updatedText, prioritizedModId } = await materializePatchGroup(
      plan,
      baseText,
      patchGroup,
      firstContribution,
      distinctModIds.size > 1,
      metrics,
      yieldController,
    );
    const orderedContributions = [...patchGroup].sort((left, right) =>
      comparePatchContributions(left, right, prioritizedModId),
    );
    writtenFiles.push({
      targetRelativePath: firstContribution.targetRelativePath,
      sourceType: 'patch',
      content: `${updatedText}${updatedText.endsWith('\n') ? '' : '\n'}`,
      contributors: dedupeBuildContributors([
        ...(firstContribution.application.mod.config.allowWriteToModifiedFiles
          ? (previousOutputs.get(toPathKey(firstContribution.targetRelativePath))?.contributors ??
            [])
          : []),
        ...dedupeContributors(orderedContributions),
      ]),
    });
  }

  return writtenFiles;
}

async function materializePatchGroup(
  plan: BuildPlan,
  baseText: string,
  patchGroup: ResolvedPatchContribution[],
  firstContribution: ResolvedPatchContribution,
  isMultiMod: boolean,
  metrics: MaterializationMetrics | undefined,
  yieldController: ReturnType<typeof createCooperativeYieldController>,
): Promise<{ updatedText: string; prioritizedModId: string | undefined }> {
  const targetRelativePath = firstContribution.targetRelativePath;
  const useCache = plan.selection.useCache !== false;

  if (!isMultiMod) {
    const orderedContributions = [...patchGroup].sort((left, right) =>
      comparePatchContributions(left, right, undefined),
    );
    const updatedText = await applyContributionSequenceCached(
      plan,
      baseText,
      orderedContributions,
      targetRelativePath,
      'sequence',
      metrics,
      yieldController,
    );
    return { updatedText, prioritizedModId: undefined };
  }

  const mergedCacheKey = useCache
    ? createPatchCacheKey(baseText, patchGroup, targetRelativePath, 'merged')
    : undefined;
  if (mergedCacheKey) {
    const cached = await loadCachedPatchOutput(plan, mergedCacheKey);
    if (cached !== undefined) {
      if (metrics) {
        metrics.mergedCacheHits += 1;
      }
      const cachedPrioritizedModId = cached.extra?.prioritizedModId;
      return {
        updatedText: cached.text,
        prioritizedModId:
          typeof cachedPrioritizedModId === 'string' ? cachedPrioritizedModId : undefined,
      };
    }
    if (metrics) {
      metrics.mergedCacheMisses += 1;
    }
  }

  const contributionsByMod = await buildPatchPriorityContributions(
    plan,
    baseText,
    patchGroup,
    metrics,
    yieldController,
  );
  const attemptedMerge =
    contributionsByMod.length > 1
      ? await tryMergeTextContributionsCooperative(
          baseText,
          contributionsByMod.map((contribution) => ({
            id: contribution.application.mod.config.id,
            label: contribution.application.mod.config.id,
            content: contribution.previewContent,
          })),
          yieldController,
        )
      : undefined;
  const prioritizedModId = attemptedMerge?.ok
    ? undefined
    : contributionsByMod.length > 1
      ? await resolvePrioritizedModId(
          plan.context,
          targetRelativePath,
          baseText,
          contributionsByMod,
        )
      : undefined;
  const updatedText = attemptedMerge?.ok
    ? attemptedMerge.content
    : await applyContributionSequenceCached(
        plan,
        baseText,
        [...patchGroup].sort((left, right) =>
          comparePatchContributions(left, right, prioritizedModId),
        ),
        targetRelativePath,
        'sequence',
        metrics,
        yieldController,
      );

  if (mergedCacheKey) {
    await saveCachedPatchOutput(
      plan,
      mergedCacheKey,
      updatedText,
      prioritizedModId === undefined ? undefined : { prioritizedModId },
    );
  }
  return { updatedText, prioritizedModId };
}

function groupModsByMaterializationLayer(selectedMods: DiscoveredMod[]): DiscoveredMod[][] {
  const buckets: DiscoveredMod[][] = [];
  const previousMods: DiscoveredMod[] = [];

  for (const mod of selectedMods) {
    const currentBucket = buckets.at(-1);
    if (!currentBucket || shouldStartNewMaterializationLayer(mod, currentBucket, previousMods)) {
      buckets.push([mod]);
    } else {
      currentBucket.push(mod);
    }
    previousMods.push(mod);
  }

  return buckets;
}

function shouldStartNewMaterializationLayer(
  mod: DiscoveredMod,
  currentBucket: DiscoveredMod[],
  previousMods: DiscoveredMod[],
): boolean {
  if (!mod.config.allowWriteToModifiedFiles) {
    return false;
  }
  if (!previousMods.every((item) => item.config.allowWriteToModifiedFiles)) {
    return false;
  }

  const currentPriority = currentBucket[0]?.config.priority;
  return (
    mod.config.priority !== currentPriority ||
    previousMods.some((item) => mod.config.dependsOn.includes(item.config.id))
  );
}

function buildVisibleExistingFiles(
  mod: DiscoveredMod,
  previousOutputs: Map<string, WrittenBuildFile>,
  bucketOutputs: Map<string, WrittenBuildFile>,
): WrittenBuildFile[] {
  const visiblePreviousOutputs = mod.config.allowWriteToModifiedFiles
    ? [...previousOutputs.values()]
    : [];
  const bucketOutputValues = [...bucketOutputs.values()];
  const samePriorityOutputs = mod.config.allowWriteToModifiedFiles
    ? bucketOutputValues
    : bucketOutputValues.filter((file) =>
        file.contributors.some((contributor) => contributor.modId === mod.config.id),
      );

  return [...visiblePreviousOutputs, ...samePriorityOutputs];
}

function buildVisibleReplaceFiles(
  mod: DiscoveredMod,
  allReplaceFiles: ReplaceFile[],
  bucketReplaceFiles: ReplaceFile[],
  bucketReplaceFilesByModId: ReadonlyMap<string, ReplaceFile[]>,
  lowerPriorityReplaceFilesByPriority: Map<number, ReplaceFile[]>,
): ReplaceFile[] {
  const visiblePreviousReplaceFiles = mod.config.allowWriteToModifiedFiles
    ? getLowerPriorityReplaceFiles(
        allReplaceFiles,
        mod.config.priority,
        lowerPriorityReplaceFilesByPriority,
      )
    : [];
  const samePriorityReplaceFiles = mod.config.allowWriteToModifiedFiles
    ? bucketReplaceFiles
    : (bucketReplaceFilesByModId.get(mod.config.id) ?? []);

  return [...visiblePreviousReplaceFiles, ...samePriorityReplaceFiles];
}

function groupByModId<T>(items: T[], getModId: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const modId = getModId(item);
    const existing = grouped.get(modId);
    if (existing) {
      existing.push(item);
      continue;
    }
    grouped.set(modId, [item]);
  }
  return grouped;
}

function getLowerPriorityReplaceFiles(
  allReplaceFiles: ReplaceFile[],
  priority: number,
  cache: Map<number, ReplaceFile[]>,
): ReplaceFile[] {
  const cached = cache.get(priority);
  if (cached) {
    return cached;
  }
  const visibleFiles = allReplaceFiles.filter((file) => file.priority < priority);
  cache.set(priority, visibleFiles);
  return visibleFiles;
}

function dedupeBuildContributors(contributors: BuildContributor[]): BuildContributor[] {
  const contributorMap = new Map<string, BuildContributor>();

  for (const contributor of contributors) {
    contributorMap.set(`${contributor.modId}:${contributor.patchId ?? ''}`, contributor);
  }

  return [...contributorMap.values()];
}
