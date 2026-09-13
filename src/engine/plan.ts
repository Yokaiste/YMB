import { createCooperativeYieldController } from '../async.ts';
import { resolveBuilderContext } from '../config/layout.ts';
import { discoverMods } from '../discovery.ts';
import { collectDroppableOptionalPatches, listYmbFailures } from '../planner/optional-patches.ts';
import { createBuildPlan } from '../planner.ts';
import type { BuildPlan, SelectionInput, SkippedPatch } from '../types.ts';
import { reportProgress, reportProjectRoot } from './progress.ts';

export async function preparePlan(
  builderPath: string | undefined,
  selection: SelectionInput,
): Promise<BuildPlan> {
  reportProgress('Resolving builder context');
  const context = await resolveBuilderContext(builderPath);
  return preparePlanForContext(context, selection);
}

export async function preparePlanForContext(
  context: Awaited<ReturnType<typeof resolveBuilderContext>>,
  selection: SelectionInput,
  alreadySkipped: readonly SkippedPatch[] = [],
): Promise<BuildPlan> {
  reportProjectRoot(context.buildRoot);
  const yieldController = createCooperativeYieldController();
  await yieldController.maybeYield();
  reportProgress('Discovering source mods');
  const discoveredMods = await discoverMods(context, yieldController);
  await yieldController.maybeYield();
  reportProgress('Planning selected patches');
  return createBuildPlan(context, discoveredMods, selection, yieldController, alreadySkipped);
}

/**
 * Retries the plan without an `optional` patch whose game data is missing. It lives
 * here rather than inside materialization because dropping a patch changes the plan:
 * its file operations, scripts, and shared targets are all worked out again.
 */
export async function withOptionalPatchesResolved<T>(
  plan: BuildPlan,
  attempt: (plan: BuildPlan) => Promise<T>,
): Promise<{ plan: BuildPlan; result: T }> {
  let currentPlan = plan;
  for (;;) {
    try {
      return { plan: currentPlan, result: await attempt(currentPlan) };
    } catch (error) {
      const dropped = collectDroppableOptionalPatches(
        currentPlan.selectedPatches,
        currentPlan.selection,
        listYmbFailures(error),
      );
      if (dropped.length === 0) {
        throw error;
      }
      reportProgress('Planning selected patches', 'leaving out optional features');
      const nextPlan = await preparePlanForContext(currentPlan.context, currentPlan.selection, [
        ...currentPlan.skippedPatches,
        ...dropped,
      ]);
      // Every retry must remove work; the number of selected patches bounds the loop.
      if (nextPlan.selectedPatches.length >= currentPlan.selectedPatches.length) throw error;
      currentPlan = nextPlan;
    }
  }
}
