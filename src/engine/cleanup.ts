import { createCooperativeYieldController } from '../async.ts';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { withBuilderOperationLock } from '../operation-lock.ts';
import { collectCleanupTargets, removeCleanupTargets } from '../temp-artifacts.ts';
import type { SelectionInput } from '../types.ts';
import {
  type CommandOutputLines,
  createSummaryLines,
  formatCountSummary,
  formatTimingSummary,
  withOutputMeta,
  withSummary,
} from './command-output.ts';
import { preparePlan } from './plan.ts';
import { abbreviateProgressPath, reportProgress } from './progress.ts';

export async function runCleanup(
  builderPath: string | undefined,
  selection: SelectionInput,
  includeRecovery: boolean,
): Promise<CommandOutputLines> {
  return withBuilderOperationLock(builderPath, 'cleanup', () =>
    runCleanupUnlocked(builderPath, selection, includeRecovery),
  );
}

async function runCleanupUnlocked(
  builderPath: string | undefined,
  selection: SelectionInput,
  includeRecovery: boolean,
): Promise<CommandOutputLines> {
  const startedAt = performance.now();
  const yieldController = createCooperativeYieldController();
  reportProgress('Preparing cleanup plan');
  const plan = await preparePlan(builderPath, selection);
  const afterPlan = performance.now();
  reportProgress('Collecting YMB temp artifacts');
  const cleanupTargets = await collectCleanupTargets(plan);
  const logs: string[] = [];
  const unsafeCount = cleanupTargets.filter((target) => target.unsafeToRemove).length;
  const removableTargets = includeRecovery
    ? cleanupTargets
    : cleanupTargets.filter((target) => !target.unsafeToRemove);

  if (selection.dryRun) {
    for (const cleanupTarget of removableTargets) {
      logs.push(
        `cleanup candidate${cleanupTarget.unsafeToRemove ? ' [all-only]' : ''} -> ${cleanupTarget.absolutePath}`,
      );
    }
    if (!includeRecovery) {
      for (const cleanupTarget of cleanupTargets.filter((target) => target.unsafeToRemove)) {
        logs.push(`cleanup preserved all-only -> ${cleanupTarget.absolutePath}`);
      }
    }
  } else {
    reportProgress('Removing YMB temp artifacts', undefined, {
      current: 0,
      total: removableTargets.length,
    });
    const removalResults = await removeCleanupTargets(removableTargets, {
      yieldController,
      onTargetStart: (cleanupTarget, targetIndex, total) => {
        reportProgress(
          'Removing YMB temp artifacts',
          abbreviateProgressPath(cleanupTarget.absolutePath),
          { current: targetIndex + 1, total },
        );
      },
    });
    for (const removal of removalResults.values()) {
      logs.push(
        removal.removed
          ? removal.existed
            ? `cleanup removed -> ${removal.absolutePath}`
            : `cleanup skipped missing -> ${removal.absolutePath}`
          : `cleanup failed -> ${removal.absolutePath}`,
      );
    }
    if (!includeRecovery) {
      for (const cleanupTarget of cleanupTargets.filter((target) => target.unsafeToRemove)) {
        logs.push(`cleanup preserved all-only -> ${cleanupTarget.absolutePath}`);
      }
    }
  }

  const removedCount = logs.filter((line) => line.startsWith('cleanup removed ->')).length;
  const missingCount = logs.filter((line) => line.startsWith('cleanup skipped missing ->')).length;
  const failedCount = logs.filter((line) => line.startsWith('cleanup failed ->')).length;
  const preservedCount = logs.filter((line) =>
    line.startsWith('cleanup preserved all-only ->'),
  ).length;
  const finishedAt = performance.now();
  return withOutputMeta(
    withSummary(
      logs,
      createSummaryLines([
        `mode: ${includeRecovery ? 'all' : 'safe'}`,
        formatCountSummary('cleanup', [
          ['target', cleanupTargets.length],
          ['all-only', unsafeCount],
          ['preserved', preservedCount],
          ['removed', removedCount],
          ['missing', missingCount],
          ['failed', failedCount],
        ]),
        formatTimingSummary(finishedAt - startedAt, [['plan', afterPlan - startedAt]]),
      ]),
    ),
    {
      detailHeading: 'cleanup actions',
      locations: [{ label: 'builder root', path: plan.context.ymbRoot }],
      nextSteps: includeRecovery
        ? ['Run `build` again if you want to regenerate preview output.']
        : [
            `Use \`cleanup --all --yes\` only when you also want to remove ${BUILDER_CONFIG.stateDirectoryName}.`,
          ],
    },
  );
}
