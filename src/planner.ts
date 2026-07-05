import { detectTargetConflicts } from './planner/conflicts.ts';
import { resolvePatchDependencies, resolveSelectedMods } from './planner/dependencies.ts';
import {
  collectInitiallySelectedMods,
  collectReplaceFiles,
  collectSelectedMods,
  collectSelectedScripts,
  collectTargetFiles,
  selectPatches,
} from './planner/selection.ts';
import type { BuilderContext, BuildPlan, DiscoveredMod, SelectionInput } from './types.ts';

export async function createBuildPlan(
  context: BuilderContext,
  discoveredMods: DiscoveredMod[],
  selection: SelectionInput,
): Promise<BuildPlan> {
  const initiallySelectedMods = collectInitiallySelectedMods(discoveredMods, selection);
  const dependencySelectedMods = resolveSelectedMods(initiallySelectedMods, discoveredMods);
  const { explanations, selectedPatches } = selectPatches(
    discoveredMods,
    selection,
    new Set(dependencySelectedMods.map((mod) => mod.config.id)),
  );
  resolvePatchDependencies(selectedPatches, discoveredMods, dependencySelectedMods);
  const selectedMods = collectSelectedMods(dependencySelectedMods, selectedPatches);
  const selectedReplaceFiles = await collectReplaceFiles(context, selectedMods);
  const selectedScripts = collectSelectedScripts(context, selectedMods, selectedPatches);
  detectTargetConflicts(context, selectedMods, selectedPatches, selectedReplaceFiles);
  const targetFiles = collectTargetFiles(context, selectedPatches, selectedReplaceFiles);

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
