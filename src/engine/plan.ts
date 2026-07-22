import { createCooperativeYieldController } from '../async.ts';
import { resolveBuilderContext } from '../config.ts';
import { discoverMods } from '../discovery.ts';
import { createBuildPlan } from '../planner.ts';
import type { BuildPlan, SelectionInput } from '../types.ts';
import { reportProgress } from './progress.ts';

export async function preparePlan(
  builderPath: string | undefined,
  selection: SelectionInput,
): Promise<BuildPlan> {
  const yieldController = createCooperativeYieldController();
  reportProgress('Resolving builder context');
  const context = await resolveBuilderContext(builderPath);
  await yieldController.maybeYield();
  reportProgress('Discovering source mods');
  const discoveredMods = await discoverMods(context, yieldController);
  await yieldController.maybeYield();
  reportProgress('Planning selected patches');
  return createBuildPlan(context, discoveredMods, selection, yieldController);
}
