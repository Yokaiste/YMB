import { createCooperativeYieldController } from '../async.ts';
import { createErrorCollector } from '../errors.ts';
import { resolvePrioritizedModId } from '../patch-priority.ts';
import { abbreviateDisplayPath, toPathKey } from '../path-utils.ts';
import { dedupeScriptContributors } from '../scripts/contributors.ts';
import { materializeScriptOutputs, type ScriptTestReporter } from '../scripts/materialize.ts';
import { resolveTextMergeBudgets, tryMergeTextContributionsCooperative } from '../text-merge.ts';
import type {
  BuildPlan,
  DiscoveredMod,
  PatchNotice,
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
import { dedupePatchNotices, readCachedPatchNotices } from './patch-notices.ts';
import { resolvePatchWorkerCount, runPatchGroupInSubprocess } from './patch-runtime.ts';
import { reportProgress, reportRunVariant } from './progress.ts';
import { materializeReplaceOutputs } from './replace-materialize.ts';
import { requirePatchContribution } from './shared.ts';
import type { MaterializationMetrics, ResolvedPatchContribution } from './types.ts';

export { materializeReplaceOutputs, validateReplaceOutputs } from './replace-materialize.ts';

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
        {
          reservedReplaceTargets: visibleReplaceFiles
            .filter(
              (file) =>
                file.priority >= mod.config.priority ||
                !outputMap.has(toPathKey(file.targetRelativePath)),
            )
            .map((file) => file.targetRelativePath),
        },
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

  reportMeasuredRunVariant(metrics);
  return [...outputMap.values()].sort((left, right) =>
    left.targetRelativePath.localeCompare(right.targetRelativePath),
  );
}

/**
 * Nothing earlier can tell: a populated cache directory says only that some run
 * wrote to it. Too late for this run's own estimate, but it keeps a cold build from
 * being recorded as the prediction for the warm one after it.
 */
function reportMeasuredRunVariant(metrics: MaterializationMetrics | undefined): void {
  if (!metrics) return;
  const decided = metrics.patchCacheHits + metrics.patchCacheMisses + metrics.patchCacheBypassed;
  // No patch targets at all means nothing was measured, so the run says nothing
  // rather than claiming a cache state it never exercised.
  if (decided === 0) return;
  reportRunVariant(metrics.patchCacheHits * 2 >= decided ? 'warm' : 'cold');
}

async function materializePatchOutputs(
  plan: BuildPlan,
  metrics?: MaterializationMetrics,
  previousOutputs = new Map<string, WrittenBuildFile>(),
): Promise<WrittenBuildFile[]> {
  const patchGroups = [...groupPatchContributions(plan).values()];
  const writtenFiles = new Array<WrittenBuildFile>(patchGroups.length);
  const yieldController = createCooperativeYieldController();
  const totalGroups = patchGroups.length;
  // Each target is patched from its own base text, so a selector that matches
  // nothing in one file tells you nothing about the next one. Working through
  // all of them turns "fix one, run again" into one list of edits.
  const failures = createErrorCollector();
  let completedGroups = 0;
  reportProgress('Materializing patch outputs', 'Scheduling independent targets', {
    current: 0,
    total: totalGroups,
  });

  const parallelJobs = patchGroups
    .map((patchGroup, index) => ({ patchGroup, index }))
    .filter(({ patchGroup }) => shouldMaterializeInWorker(plan, patchGroup, previousOutputs));
  const parallelIndexes = new Set(parallelJobs.map((job) => job.index));
  const workerCount = resolvePatchWorkerCount(parallelJobs.length);
  if (workerCount > 1) {
    let jobCursor = 0;
    const startedAt = performance.now();
    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.max(1, Math.round((performance.now() - startedAt) / 1000));
      reportProgress(
        'Materializing patch outputs',
        `${workerCount} CPU workers active - ${elapsedSeconds}s elapsed`,
        { current: completedGroups, total: totalGroups },
      );
    }, 350);
    heartbeat.unref?.();
    try {
      const workerResults = await Promise.allSettled(
        Array.from({ length: workerCount }, async () => {
          while (jobCursor < parallelJobs.length) {
            const job = parallelJobs[jobCursor];
            jobCursor += 1;
            if (!job) return;
            await failures.collect(async () => {
              const firstContribution = requireFirstPatchContribution(job.patchGroup);
              const response = await runPatchGroupInSubprocess({
                plan,
                patchGroup: job.patchGroup,
              });
              writtenFiles[job.index] = response.writtenFile;
              addMaterializationMetrics(metrics, response.metrics);
              completedGroups += 1;
              reportProgress(
                'Materializing patch outputs',
                abbreviateDisplayPath(firstContribution.targetRelativePath),
                { current: completedGroups, total: totalGroups },
              );
            });
          }
        }),
      );
      const failedWorker = workerResults.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failedWorker) throw failedWorker.reason;
    } finally {
      clearInterval(heartbeat);
    }
  }

  for (const [groupIndex, patchGroup] of patchGroups.entries()) {
    if (workerCount > 1 && parallelIndexes.has(groupIndex)) continue;
    await yieldController.maybeYield();
    await failures.collect(async () => {
      const firstContribution = requireFirstPatchContribution(patchGroup);
      reportProgress(
        'Materializing patch outputs',
        abbreviateDisplayPath(firstContribution.targetRelativePath),
        {
          current: completedGroups,
          total: totalGroups,
        },
      );
      writtenFiles[groupIndex] = await materializePatchGroupOutput(
        plan,
        patchGroup,
        previousOutputs,
        metrics,
        yieldController,
      );
      completedGroups += 1;
      reportProgress(
        'Materializing patch outputs',
        abbreviateDisplayPath(firstContribution.targetRelativePath),
        { current: completedGroups, total: totalGroups },
      );
    });
  }

  // Nothing below may read a hole left by a group that failed.
  failures.throwIfFailed();
  return writtenFiles;
}

export async function materializePatchGroupOutput(
  plan: BuildPlan,
  patchGroup: ResolvedPatchContribution[],
  previousOutputs = new Map<string, WrittenBuildFile>(),
  metrics?: MaterializationMetrics,
  yieldController = createCooperativeYieldController(),
): Promise<WrittenBuildFile> {
  const firstContribution = requireFirstPatchContribution(patchGroup);
  const baseText = await loadBasePatchText(plan, firstContribution, previousOutputs);
  const distinctModIds = new Set(
    patchGroup.map((contribution) => contribution.application.mod.config.id),
  );
  const { updatedText, prioritizedModId, notices } = await materializePatchGroup(
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
  // This output replaces the one the layer below wrote, so it has to speak for
  // both. Contributors were already carried across; notices are carried the same
  // way, or every observation the lower layer made about this file disappears the
  // moment a higher-priority mod patches it too.
  const inheritedOutput = firstContribution.application.mod.config.allowWriteToModifiedFiles
    ? previousOutputs.get(toPathKey(firstContribution.targetRelativePath))
    : undefined;
  const layeredNotices = dedupePatchNotices([...(inheritedOutput?.notices ?? []), ...notices]);
  return {
    targetRelativePath: firstContribution.targetRelativePath,
    sourceType: 'patch',
    content: `${updatedText}${updatedText.endsWith('\n') ? '' : '\n'}`,
    contributors: dedupeScriptContributors([
      ...(inheritedOutput?.contributors ?? []),
      ...dedupeContributors(orderedContributions),
    ]),
    ...(layeredNotices.length > 0 ? { notices: layeredNotices } : {}),
  };
}

function requireFirstPatchContribution(
  patchGroup: readonly ResolvedPatchContribution[],
): ResolvedPatchContribution {
  return requirePatchContribution(patchGroup[0]);
}

/**
 * Workers only pay for themselves when the cache is bypassed. Spawning one per
 * target sends the whole plan and returns whole NDF files over IPC, which loses more
 * than it saves on a warm 2.2s phase and multiplies peak memory. Re-measure before
 * widening this.
 */
function shouldMaterializeInWorker(
  plan: BuildPlan,
  patchGroup: ResolvedPatchContribution[],
  previousOutputs: ReadonlyMap<string, WrittenBuildFile>,
): boolean {
  if (plan.selection.useCache !== false) {
    return false;
  }

  const firstContribution = patchGroup[0];
  if (!firstContribution) return false;
  // A worker starts from disk with no inherited output, so a target that layers
  // over an earlier bucket or mixes mods has to stay in this process.
  const modIds = new Set(patchGroup.map((contribution) => contribution.application.mod.config.id));
  return modIds.size === 1 && !previousOutputs.has(toPathKey(firstContribution.targetRelativePath));
}

function addMaterializationMetrics(
  target: MaterializationMetrics | undefined,
  source: MaterializationMetrics,
): void {
  if (!target) return;
  target.patchCacheHits += source.patchCacheHits;
  target.patchCacheMisses += source.patchCacheMisses;
  target.patchCacheBypassed += source.patchCacheBypassed;
  target.mergedCacheHits += source.mergedCacheHits;
  target.mergedCacheMisses += source.mergedCacheMisses;
}

async function materializePatchGroup(
  plan: BuildPlan,
  baseText: string,
  patchGroup: ResolvedPatchContribution[],
  firstContribution: ResolvedPatchContribution,
  isMultiMod: boolean,
  metrics: MaterializationMetrics | undefined,
  yieldController: ReturnType<typeof createCooperativeYieldController>,
): Promise<{
  updatedText: string;
  prioritizedModId: string | undefined;
  notices: PatchNotice[];
}> {
  const targetRelativePath = firstContribution.targetRelativePath;
  const useCache = plan.selection.useCache !== false;

  if (!isMultiMod) {
    const orderedContributions = [...patchGroup].sort((left, right) =>
      comparePatchContributions(left, right, undefined),
    );
    const patched = await applyContributionSequenceCached(
      plan,
      baseText,
      orderedContributions,
      targetRelativePath,
      'sequence',
      metrics,
      yieldController,
    );
    return {
      updatedText: patched.text,
      prioritizedModId: undefined,
      notices: patched.notices,
    };
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
        notices: readCachedPatchNotices(cached.extra) ?? [],
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
          resolveTextMergeBudgets(plan.context.builderConfig.settings),
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
  // A successful merge produces text without re-running the operations, so it
  // carries no notices of its own. It does not need to: every contribution
  // already ran once per mod above, and those previews saw everything.
  const patched =
    (attemptedMerge?.ok ? { text: attemptedMerge.content, notices: [] } : undefined) ??
    (await applyContributionSequenceCached(
      plan,
      baseText,
      [...patchGroup].sort((left, right) =>
        comparePatchContributions(left, right, prioritizedModId),
      ),
      targetRelativePath,
      'sequence',
      metrics,
      yieldController,
    ));
  const notices = dedupePatchNotices([
    ...contributionsByMod.flatMap((contribution) => contribution.notices),
    ...patched.notices,
  ]);

  if (mergedCacheKey) {
    const extra = {
      ...(prioritizedModId === undefined ? {} : { prioritizedModId }),
      ...(notices.length > 0 ? { notices } : {}),
    };
    await saveCachedPatchOutput(
      plan,
      mergedCacheKey,
      patched.text,
      Object.keys(extra).length > 0 ? extra : undefined,
    );
  }
  return { updatedText: patched.text, prioritizedModId, notices };
}

function groupModsByMaterializationLayer(selectedMods: DiscoveredMod[]): DiscoveredMod[][] {
  const buckets: DiscoveredMod[][] = [];
  const previousMods: DiscoveredMod[] = [];
  const orderedMods = [...selectedMods].sort(
    (left, right) => left.config.priority - right.config.priority,
  );

  for (const mod of orderedMods) {
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

/** Mods in earlier buckets only ever modify untouched game files. */
function shouldStartNewMaterializationLayer(
  mod: DiscoveredMod,
  currentBucket: DiscoveredMod[],
  previousMods: DiscoveredMod[],
): boolean {
  if (!mod.config.allowWriteToModifiedFiles) {
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
