import { resolveBuilderContext } from '../config.ts';
import { discoverMods } from '../discovery.ts';
import { createBuildPlan } from '../planner.ts';
import type { BuildPlan, SelectionInput } from '../types.ts';
import { reportProgress } from './progress.ts';

export async function preparePlan(
  builderPath: string | undefined,
  selection: SelectionInput,
): Promise<BuildPlan> {
  reportProgress('Resolving builder context');
  const context = await resolveBuilderContext(builderPath);
  reportProgress('Discovering source mods');
  const discoveredMods = await discoverMods(context);
  reportProgress('Planning selected patches');
  return createBuildPlan(context, discoveredMods, selection);
}
