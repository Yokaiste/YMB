import { createCooperativeYieldController } from '../async.ts';
import { ensure } from '../errors.ts';
import { withBuilderOperationLock } from '../operation-lock.ts';
import { formatDetailLine } from '../report/detail.ts';
import { countFact, timingFact } from '../report/facts.ts';
import { formatUnmatchedFilterWarnings } from '../report/findings.ts';
import { type CommandOutputLines, toCommandOutput } from '../report/output.ts';
import { collectCleanupTargets, removeCleanupTargets } from '../temp-artifacts.ts';
import type { BuilderContext, SelectionInput } from '../types.ts';
import { preparePlanForContext } from './plan.ts';
import { reportProgress, trackProgress } from './progress.ts';

export async function runCleanup(
  builderPath: string | undefined,
  selection: SelectionInput,
  includeRecovery: boolean,
): Promise<CommandOutputLines> {
  return withBuilderOperationLock(builderPath, 'cleanup', (context) =>
    runCleanupUnlocked(context, selection, includeRecovery),
  );
}

async function runCleanupUnlocked(
  context: BuilderContext,
  selection: SelectionInput,
  includeRecovery: boolean,
): Promise<CommandOutputLines> {
  const startedAt = performance.now();
  const yieldController = createCooperativeYieldController();
  reportProgress('Preparing cleanup plan');
  const plan = await preparePlanForContext(context, selection);
  const afterPlan = performance.now();
  reportProgress('Collecting YMB temp artifacts');
  const cleanupTargets = await collectCleanupTargets(plan);
  const logs: string[] = [...formatUnmatchedFilterWarnings(plan.unmatchedFilters)];
  const unsafeTargets = cleanupTargets.filter((target) => target.unsafeToRemove);
  const removableTargets = includeRecovery
    ? cleanupTargets
    : cleanupTargets.filter((target) => !target.unsafeToRemove);
  let removedCount = 0;
  let missingCount = 0;
  const failedPaths: string[] = [];

  if (selection.dryRun) {
    // Everything still in `removableTargets` really would be removed. The kept
    // recovery targets are listed separately below, so labelling them here as
    // `keep-only` would have promised `cleanup --all` leaves them alone.
    for (const cleanupTarget of removableTargets) {
      logs.push(formatDetailLine('to remove', cleanupTarget.absolutePath));
    }
  } else {
    const progress = trackProgress('Removing YMB temp artifacts', removableTargets.length);
    const removalResults = await removeCleanupTargets(removableTargets, {
      yieldController,
      onTargetStart: (cleanupTarget) => {
        progress.step(cleanupTarget.absolutePath);
      },
    });
    for (const removal of removalResults) {
      if (!removal.removed) {
        failedPaths.push(removal.absolutePath);
        logs.push(formatDetailLine('failed', removal.absolutePath));
        continue;
      }
      if (removal.existed) {
        removedCount += 1;
        logs.push(formatDetailLine('removed', removal.absolutePath));
        continue;
      }
      missingCount += 1;
      logs.push(formatDetailLine('gone', removal.absolutePath));
    }
  }

  ensure(failedPaths.length === 0, 'IoError', {
    absolutePath: failedPaths[0] ?? context.ymbRoot,
    reason: `Cleanup could not delete ${failedPaths.length} listed path(s). Other files may already be gone.`,
    suggestion:
      'Close any program using these paths, check folder permissions, then run cleanup again.',
    details: failedPaths,
  });

  const preservedCount = includeRecovery ? 0 : unsafeTargets.length;
  if (!includeRecovery) {
    for (const cleanupTarget of unsafeTargets) {
      logs.push(formatDetailLine('kept', cleanupTarget.absolutePath));
    }
  }
  const finishedAt = performance.now();
  return toCommandOutput(logs, {
    summary: [
      { label: 'mode', value: includeRecovery ? 'all' : 'safe' },
      countFact('cleanup', [
        ['target', cleanupTargets.length],
        ['removed file', removedCount],
        ['kept file', preservedCount],
        ['missing file', missingCount],
      ]),
      timingFact(finishedAt - startedAt, [['plan', afterPlan - startedAt]]),
    ],
    data: {
      paths: { builder: plan.context.ymbRoot, recovery: plan.context.stateRoot },
      includeRecovery,
      unmatchedFilters: plan.unmatchedFilters,
      targets: removableTargets.map((entry) => entry.absolutePath),
      preserved: includeRecovery ? [] : unsafeTargets.map((entry) => entry.absolutePath),
      counts: { removed: removedCount, missing: missingCount, failed: 0 },
      durationMs: finishedAt - startedAt,
    },
    detailHeading: 'files removed or kept',
    locations: [{ label: 'YMB folder', path: plan.context.ymbRoot }],
    nextSteps: includeRecovery
      ? ['Full cleanup removes saved originals. Run `build` when you need a new preview.']
      : [
          `Saved originals remain in \`${plan.context.stateRoot}\`. Run \`build\` when you need a new preview.`,
        ],
  });
}
