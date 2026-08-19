import { createCooperativeYieldController } from '../async.ts';
import { applyPatchTargetCooperative } from '../patch/ndf/core.ts';
import { assertGameRelativePath, resolveModTargetPath, toPathKey } from '../path-utils.ts';
import { createTemplateVariables } from '../templates.ts';
import type { BuildContributor, BuildPlan, PatchNotice, WrittenBuildFile } from '../types.ts';
import {
  createPatchCacheKey,
  loadCachedPatchOutput,
  type PatchCacheVariant,
  saveCachedPatchOutput,
} from './patch-cache.ts';
import { dedupePatchNotices, readCachedPatchNotices } from './patch-notices.ts';
import { readTextOrThrow, requirePatchContribution, resolveVariablesInTarget } from './shared.ts';
import type { MaterializationMetrics, ResolvedPatchContribution } from './types.ts';
import { validateNdfMemoized, validateNdfMemoizedCooperative } from './validation-memo.ts';

interface PatchPriorityContributionPreview {
  application: ResolvedPatchContribution['application'];
  targetRelativePath: string;
  hasScripts: boolean;
  previewContent: string;
  notices: PatchNotice[];
}

interface ApplyContributionSequenceOptions {
  validateResult?: boolean;
}

/** Notices travel with the text because the cache stores both: a warm run must say the same things. */
interface PatchedContribution {
  text: string;
  notices: PatchNotice[];
}

export function groupPatchContributions(plan: BuildPlan): Map<string, ResolvedPatchContribution[]> {
  const groupedTargets = new Map<string, ResolvedPatchContribution[]>();
  const activeScriptPatchPaths = new Set(
    plan.selectedScripts.flatMap((script) => (script.patch ? [script.patch.configFilePath] : [])),
  );

  for (const [patchOrder, selected] of plan.selectedPatches.entries()) {
    const templateVariables = createTemplateVariables(plan.context, selected.mod, selected.patch);
    for (const rawTarget of selected.patch.config.targets) {
      const target = resolveVariablesInTarget(rawTarget, templateVariables, selected);
      const targetRelativePath = assertGameRelativePath(target.file, plan.context.modRoot);
      const targetKey = toPathKey(targetRelativePath);
      const entries = groupedTargets.get(targetKey) ?? [];
      entries.push({
        application: selected,
        target,
        targetRelativePath,
        hasScripts: activeScriptPatchPaths.has(selected.patch.configFilePath),
        patchOrder,
      });
      groupedTargets.set(targetKey, entries);
    }
  }

  return new Map(
    [...groupedTargets.entries()].sort((left, right) => left[0].localeCompare(right[0])),
  );
}

export function comparePatchContributions(
  left: ResolvedPatchContribution,
  right: ResolvedPatchContribution,
  prioritizedModId: string | undefined,
): number {
  const leftRank = left.application.mod.config.id === prioritizedModId ? 1 : 0;
  const rightRank = right.application.mod.config.id === prioritizedModId ? 1 : 0;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  if (left.patchOrder !== right.patchOrder) {
    return left.patchOrder - right.patchOrder;
  }

  return left.application.mod.config.id.localeCompare(right.application.mod.config.id);
}

async function applyContributionSequence(
  baseText: string,
  contributions: ResolvedPatchContribution[],
  absolutePath: string,
  yieldController?: ReturnType<typeof createCooperativeYieldController>,
  options: ApplyContributionSequenceOptions = {},
): Promise<PatchedContribution> {
  let updatedText = baseText;
  const notices: PatchNotice[] = [];

  for (const contribution of contributions) {
    await yieldController?.maybeYield();
    updatedText = await applyPatchTargetCooperative(
      updatedText,
      contribution.target,
      contribution.application,
      absolutePath,
      yieldController ?? createCooperativeYieldController(),
      {
        validateBeforeApply: false,
        validateAfterApply: false,
        onNotice: (notice) => notices.push(notice),
      },
    );
  }
  if (options.validateResult !== false) {
    if (yieldController) {
      await validateNdfMemoizedCooperative(updatedText, absolutePath, yieldController);
    } else {
      validateNdfMemoized(updatedText, absolutePath);
    }
  }
  return { text: updatedText, notices: dedupePatchNotices(notices) };
}

export async function applyContributionSequenceCached(
  plan: BuildPlan,
  baseText: string,
  contributions: ResolvedPatchContribution[],
  targetRelativePath: string,
  variant: PatchCacheVariant,
  metrics?: MaterializationMetrics,
  yieldController?: ReturnType<typeof createCooperativeYieldController>,
  options: ApplyContributionSequenceOptions = {},
): Promise<PatchedContribution> {
  if (plan.selection.useCache === false) {
    if (metrics) {
      metrics.patchCacheBypassed += 1;
    }
    return applyContributionSequence(
      baseText,
      contributions,
      targetRelativePath,
      yieldController,
      options,
    );
  }

  const cacheKey = createPatchCacheKey(baseText, contributions, targetRelativePath, variant);
  const cached = await loadCachedPatchOutput(plan, cacheKey);
  if (cached !== undefined) {
    if (metrics) {
      metrics.patchCacheHits += 1;
    }
    return { text: cached.text, notices: readCachedPatchNotices(cached.extra) ?? [] };
  }

  if (metrics) {
    metrics.patchCacheMisses += 1;
  }
  const patched = await applyContributionSequence(
    baseText,
    contributions,
    targetRelativePath,
    yieldController,
    options,
  );
  await saveCachedPatchOutput(
    plan,
    cacheKey,
    patched.text,
    patched.notices.length > 0 ? { notices: patched.notices } : undefined,
  );
  return patched;
}

export function dedupeContributors(contributions: ResolvedPatchContribution[]): BuildContributor[] {
  const contributorMap = new Map<string, BuildContributor>();

  for (const contribution of contributions) {
    const modId = contribution.application.mod.config.id;
    const modName = contribution.application.mod.config.name;
    const patchId = contribution.application.patch.config.id;
    contributorMap.set(`${modId}:${patchId}`, { modId, modName, patchId });
  }

  return [...contributorMap.values()];
}

export async function buildPatchPriorityContributions(
  plan: BuildPlan,
  baseText: string,
  patchGroup: ResolvedPatchContribution[],
  metrics?: MaterializationMetrics,
  yieldController?: ReturnType<typeof createCooperativeYieldController>,
): Promise<PatchPriorityContributionPreview[]> {
  const contributionsByMod = new Map<
    string,
    {
      firstContribution: ResolvedPatchContribution;
      hasScripts: boolean;
      scriptedContributions: ResolvedPatchContribution[];
      plainContributions: ResolvedPatchContribution[];
    }
  >();

  for (const contribution of patchGroup) {
    const modId = contribution.application.mod.config.id;
    const entry = contributionsByMod.get(modId);
    if (entry) {
      entry.hasScripts ||= contribution.hasScripts;
      (contribution.hasScripts ? entry.scriptedContributions : entry.plainContributions).push(
        contribution,
      );
      continue;
    }
    contributionsByMod.set(modId, {
      firstContribution: contribution,
      hasScripts: contribution.hasScripts,
      scriptedContributions: contribution.hasScripts ? [contribution] : [],
      plainContributions: contribution.hasScripts ? [] : [contribution],
    });
  }

  const previews: PatchPriorityContributionPreview[] = [];

  const sortedModIds = [...contributionsByMod.keys()].sort((left, right) =>
    left.localeCompare(right),
  );
  for (const modId of sortedModIds) {
    await yieldController?.maybeYield();
    const contributionGroup = contributionsByMod.get(modId);
    const firstContribution = requirePatchContribution(contributionGroup?.firstContribution);
    const orderedContributions = [
      ...(contributionGroup?.scriptedContributions ?? []),
      ...(contributionGroup?.plainContributions ?? []),
    ];

    const patched = await applyContributionSequenceCached(
      plan,
      baseText,
      orderedContributions,
      firstContribution.targetRelativePath,
      `preview:${modId}`,
      metrics,
      yieldController,
      { validateResult: false },
    );
    previews.push({
      application: firstContribution.application,
      targetRelativePath: firstContribution.targetRelativePath,
      hasScripts: contributionGroup?.hasScripts ?? false,
      previewContent: patched.text,
      notices: patched.notices,
    });
  }

  return previews;
}

export async function loadBasePatchText(
  plan: BuildPlan,
  firstContribution: ResolvedPatchContribution,
  previousOutputs = new Map<string, WrittenBuildFile>(),
): Promise<string> {
  const inheritedOutput = previousOutputs.get(toPathKey(firstContribution.targetRelativePath));
  if (
    firstContribution.application.mod.config.allowWriteToModifiedFiles &&
    inheritedOutput &&
    typeof inheritedOutput.content === 'string'
  ) {
    return inheritedOutput.content;
  }

  return readTextOrThrow(
    plan.context,
    resolveModTargetPath(plan.context.modRoot, firstContribution.target.file),
    firstContribution.application,
    firstContribution.target.file,
  );
}
