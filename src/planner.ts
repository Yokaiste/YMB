import type { CooperativeYieldController } from './async.ts';
import { detectTargetConflictsCooperative } from './planner/conflicts.ts';
import {
  resolvePatchDependenciesCooperative,
  resolveSelectedModsCooperative,
} from './planner/dependencies.ts';
import {
  collectInitiallySelectedMods,
  collectReplaceFiles,
  collectSelectedMods,
  collectSelectedScriptsCooperative,
  collectTargetFilesCooperative,
  selectPatchesCooperative,
} from './planner/selection.ts';
import type { BuilderContext, BuildPlan, DiscoveredMod, SelectionInput } from './types.ts';

export async function createBuildPlan(
  context: BuilderContext,
  discoveredMods: DiscoveredMod[],
  selection: SelectionInput,
  yieldController?: CooperativeYieldController,
): Promise<BuildPlan> {
  const initiallySelectedMods = collectInitiallySelectedMods(discoveredMods, selection);
  await yieldController?.maybeYield();
  const dependencySelectedMods = await resolveSelectedModsCooperative(
    initiallySelectedMods,
    discoveredMods,
    yieldController,
  );
  await yieldController?.maybeYield();
  const { explanations, selectedPatches } = await selectPatchesCooperative(
    discoveredMods,
    selection,
    new Set(dependencySelectedMods.map((mod) => mod.config.id)),
    yieldController,
  );
  await yieldController?.maybeYield();
  await resolvePatchDependenciesCooperative(
    selectedPatches,
    discoveredMods,
    dependencySelectedMods,
    yieldController,
  );
  const selectedMods = collectSelectedMods(dependencySelectedMods, selectedPatches);
  await yieldController?.maybeYield();
  const selectedReplaceFiles = await collectReplaceFiles(context, selectedMods, yieldController);
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
    yieldController,
  );
  await yieldController?.maybeYield();
  const targetFiles = await collectTargetFilesCooperative(
    context,
    selectedPatches,
    selectedReplaceFiles,
    yieldController,
  );

  return {
    context,
    selection,
    discoveredMods,
    selectedMods,
    selectedPatches,
    selectedReplaceFiles,
    selectedScripts,
    explanations,
    targetFiles,
  };
}
