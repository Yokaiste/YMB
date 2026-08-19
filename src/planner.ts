import type { CooperativeYieldController } from './async.ts';
import { detectTargetConflictsCooperative } from './planner/conflicts.ts';
import {
  resolvePatchDependenciesCooperative,
  resolveSelectedModsCooperative,
} from './planner/dependencies.ts';
import { collectPatchFileChanges } from './planner/file-operations.ts';
import {
  dropOptionalPatchesMissingTargets,
  dropPatchesAndDependents,
} from './planner/optional-patches.ts';
import {
  collectInitiallySelectedMods,
  collectReplaceFiles,
  collectSelectedMods,
  collectSelectedScriptsCooperative,
  collectTargetFilesCooperative,
  selectPatchesCooperative,
} from './planner/selection.ts';
import { collectUnmatchedSelectionFilters } from './selection-filter.ts';
import type {
  BuilderContext,
  BuildPlan,
  DiscoveredMod,
  SelectionInput,
  SkippedPatch,
} from './types.ts';

/**
 * `alreadySkipped` carries forward the `optional` patches an earlier attempt found
 * missing, so every later phase agrees on one set of patches.
 */
export async function createBuildPlan(
  context: BuilderContext,
  discoveredMods: DiscoveredMod[],
  selection: SelectionInput,
  yieldController?: CooperativeYieldController,
  alreadySkipped: readonly SkippedPatch[] = [],
): Promise<BuildPlan> {
  const initiallySelectedMods = collectInitiallySelectedMods(discoveredMods, selection);
  await yieldController?.maybeYield();
  const dependencySelectedMods = await resolveSelectedModsCooperative(
    initiallySelectedMods,
    discoveredMods,
    yieldController,
  );
  await yieldController?.maybeYield();
  const { explanations, selectedPatches: matchedPatches } = await selectPatchesCooperative(
    discoveredMods,
    selection,
    new Set(dependencySelectedMods.map((mod) => mod.config.id)),
    yieldController,
  );
  await yieldController?.maybeYield();
  await resolvePatchDependenciesCooperative(
    matchedPatches,
    discoveredMods,
    dependencySelectedMods,
    yieldController,
  );
  await yieldController?.maybeYield();
  // Both passes run after dependency resolution, which pulls prerequisites back
  // in, and before everything below, so conflict detection, the target list, and
  // materialization all see one set of patches.
  const carriedForward = dropPatchesAndDependents(matchedPatches, alreadySkipped);
  const missingTargets = await dropOptionalPatchesMissingTargets(
    context,
    selection,
    carriedForward.selectedPatches,
    yieldController,
  );
  const stranded = dropPatchesAndDependents(
    missingTargets.selectedPatches,
    missingTargets.skippedPatches,
  );
  const selectedPatches = stranded.selectedPatches;
  const skippedPatches = [...carriedForward.skippedPatches, ...stranded.skippedPatches];
  const selectedPatchKeys = new Set(
    selectedPatches.map((selected) => `${selected.mod.config.id}:${selected.patch.config.id}`),
  );
  for (const explanation of explanations) {
    if (
      !explanation.included &&
      selectedPatchKeys.has(`${explanation.modId}:${explanation.patchId}`)
    ) {
      explanation.included = true;
      explanation.reasons = ['included as a required patch dependency'];
    }
  }
  const selectedMods = collectSelectedMods(dependencySelectedMods, selectedPatches);
  await yieldController?.maybeYield();
  const modReplaceFiles = await collectReplaceFiles(context, selectedMods, yieldController);
  const fileChanges = await collectPatchFileChanges(context, selectedPatches, yieldController);
  const selectedReplaceFiles = [...modReplaceFiles, ...fileChanges.writes].sort((left, right) =>
    left.targetRelativePath.localeCompare(right.targetRelativePath),
  );
  const selectedFileDeletions = fileChanges.deletions;
  await yieldController?.maybeYield();
  const selectedScripts = await collectSelectedScriptsCooperative(
    context,
    selectedMods,
    selectedPatches,
    yieldController,
  );
  await yieldController?.maybeYield();
  await detectTargetConflictsCooperative(
    context,
    selectedMods,
    selectedPatches,
    selectedReplaceFiles,
    selectedFileDeletions,
    yieldController,
  );
  await yieldController?.maybeYield();
  const targetFiles = await collectTargetFilesCooperative(
    context,
    selectedPatches,
    selectedReplaceFiles,
    selectedFileDeletions,
    yieldController,
  );

  return {
    context,
    selection,
    discoveredMods,
    selectedMods,
    selectedPatches,
    selectedReplaceFiles,
    selectedFileDeletions,
    selectedScripts,
    explanations,
    skippedPatches,
    targetFiles,
    notices: fileChanges.notices,
    unmatchedFilters: [
      ...collectUnmatchedSelectionFilters(
        '--mod',
        selection.modFilters,
        discoveredMods.map((mod) => ({ id: mod.config.id, name: mod.config.name })),
      ),
      ...collectUnmatchedSelectionFilters(
        '--patch',
        selection.patchFilters,
        discoveredMods.flatMap((mod) =>
          mod.patches.map((patch) => ({ id: patch.config.id, name: patch.config.name })),
        ),
      ),
    ],
  };
}
