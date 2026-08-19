import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { type CooperativeYieldController, createCooperativeYieldController } from '../async.ts';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { createErrorCollector, ensure } from '../errors.ts';
import { hashBytes, hashContent, hashText } from '../hash.ts';
import {
  createBuilderId,
  isMarkedContentIntact,
  loadManifest,
  saveManifest,
  unwrapMarkedContent,
} from '../markers.ts';
import { withBuilderOperationLock } from '../operation-lock.ts';
import { isNdfPath } from '../patch/ndf/validate.ts';
import {
  assertGameRelativePath,
  assertRealPathWithinRoot,
  createTemporarySiblingPath,
  pathExists,
  removePathDirectly,
  replaceDirectoryAtomic,
  resolveModTargetPath,
  toDisplayPath,
  toPathKey,
  writeFileAtomic,
} from '../path-utils.ts';
import { type DetailStatus, formatDetailLine } from '../report/detail.ts';
import { countFact, timingFact } from '../report/facts.ts';
import {
  formatFindingGroups,
  type ReportFinding,
  toObsoleteTargetFindings,
  toUnmatchedFilterFinding,
} from '../report/findings.ts';
import { type CommandOutputLines, toCommandOutput } from '../report/output.ts';
import { formatScriptTestLogLine } from '../scripts/testing.ts';
import {
  beginStateTransaction,
  commitStateTransaction,
  recordStateTransactionTarget,
  requireStateTransaction,
  type StateTransaction,
} from '../state-transaction.ts';
import { createTemplateVariables } from '../templates.ts';
import type {
  BuilderContext,
  BuildPlan,
  FileDeletion,
  PatchNotice,
  SelectionInput,
  SyncManifestEntry,
  WrittenBuildFile,
} from '../types.ts';
import { assertRequiredBlockReferences } from './block-references.ts';
import { pruneCacheDirectory } from './cache-store.ts';
import {
  prepareMarkedOutput,
  recordUnmarkedTarget,
  resolveUnmarkableOutputWarning,
} from './marked-output.ts';
import { materializeBuild, validateReplaceOutputs } from './materialize.ts';
import { countWrittenFiles, createMaterializationMetrics, patchCacheFact } from './metrics.ts';
import { toPatchReportFinding } from './patch-notices.ts';
import { preparePlan, preparePlanForContext, withOptionalPatchesResolved } from './plan.ts';
import { reportProgress, trackProgress } from './progress.ts';
import {
  assertChangedTrackedTargetsAreAllowed,
  assertSyncedTargetIsUnchanged,
  assertTrackedBackupsExist,
  createManifestEntryMap,
  createSortedManifest,
  findChangedTrackedTargets,
  resetChangedTrackedTargets,
  restoreOrDeleteTrackedTarget,
  rollbackStateTransactionAfterFailure,
  sweepOrphanedBackups,
} from './recovery.ts';
import {
  loadOriginalBackupBytes,
  matchesSelection,
  readTextOrThrow,
  resolveVariablesInTarget,
} from './shared.ts';
import { validateNdfPersistentlyMemoized } from './validation-memo.ts';

export { runCleanup } from './cleanup.ts';
export { runDoctor, runExplain, runList } from './inspection.ts';
export { preparePlan } from './plan.ts';
export {
  setCommandProgressReporter,
  setCommandProjectRootReporter,
  setCommandRunVariantReporter,
} from './progress.ts';

function pruneBuildCache(context: BuilderContext): Promise<number> {
  return pruneCacheDirectory(context.buildCacheRoot, {
    maxEntries: context.builderConfig.settings.cacheMaxEntries,
    maxBytes: context.builderConfig.settings.cacheMaxBytes,
    maxAgeDays: context.builderConfig.settings.cacheMaxAgeDays,
  });
}

export async function runValidate(
  builderPath: string | undefined,
  selection: SelectionInput,
): Promise<CommandOutputLines> {
  return withBuilderOperationLock(builderPath, 'validate', (context) =>
    runValidateUnlocked(builderPath, selection, context),
  );
}

async function runValidateUnlocked(
  builderPath: string | undefined,
  selection: SelectionInput,
  context?: BuilderContext,
): Promise<CommandOutputLines> {
  const startedAt = performance.now();
  reportProgress('Preparing validation plan');
  const preparedPlan = context
    ? await preparePlanForContext(context, selection)
    : await preparePlan(builderPath, selection);
  const afterPlan = performance.now();
  const { plan, result } = await withOptionalPatchesResolved(preparedPlan, (attemptPlan) =>
    checkPlan(attemptPlan),
  );

  await pruneBuildCache(plan.context);
  const finishedAt = performance.now();
  return toCommandOutput(result.logs, {
    summary: [
      countFact('checked', [
        ['patch target', result.validatedPatchTargets],
        ['replace file', result.validatedReplaceTargets],
        ['file-operation output', result.validatedFileOperationTargets],
        ['file deletion', plan.selectedFileDeletions.length],
        ['script output', result.validatedScriptTargets],
        ['script test', result.validatedScriptTests],
        ['warning', result.warningCount],
        ['skipped optional patch', plan.skippedPatches.length, 'skipped optional patches'],
      ]),
      timingFact(finishedAt - startedAt, [
        ['plan', afterPlan - startedAt],
        ['materialize', result.materializeDurationMs],
      ]),
      patchCacheFact(result.metrics),
    ],
    detailHeading: 'checks',
    nextSteps: [
      'Run `build` to write a preview.',
      'Run `explain` if the selected patches still look wrong.',
    ],
  });
}

/** Separate so it can run again on a plan that leaves out an unbuildable `optional` feature. */
async function checkPlan(plan: BuildPlan) {
  const yieldController = createCooperativeYieldController();
  // Counts now live in the summary, so details only carry per-file results.
  const logs: string[] = [];
  const totalPatchTargets = plan.selectedPatches.reduce(
    (count, selected) => count + selected.patch.config.targets.length,
    0,
  );
  let validatedPatchTargets = 0;
  let validatedReplaceTargets = 0;
  let validatedFileOperationTargets = 0;
  let validatedScriptTargets = 0;
  let validatedScriptTests = 0;
  let warningCount = 0;
  const patchNotices: PatchNotice[] = [];
  const findings: ReportFinding[] = [];
  // Checking is the one job where stopping at the first problem is worst: every
  // failure below is independent, and a modder fixing them one run at a time
  // pays for a whole build per edit.
  const failures = createErrorCollector();

  const patchTargetProgress = trackProgress('Validating patch targets', totalPatchTargets);
  for (const selected of plan.selectedPatches) {
    await yieldController.maybeYield();
    const templateVariables = createTemplateVariables(plan.context, selected.mod, selected.patch);
    for (const target of selected.patch.config.targets) {
      await yieldController.maybeYield();
      await failures.collect(async () => {
        const resolvedTarget = resolveVariablesInTarget(target, templateVariables, selected);
        const absolutePath = resolveModTargetPath(plan.context.modRoot, resolvedTarget.file);
        await readTextOrThrow(plan.context, absolutePath, selected, resolvedTarget.file);
        logs.push(formatDetailLine('ok', toDisplayPath(resolvedTarget.file)));
        validatedPatchTargets += 1;
        patchTargetProgress.step(resolvedTarget.file);
      });
    }
  }

  const replaceProgress = trackProgress(
    'Validating replace files',
    plan.selectedReplaceFiles.length,
  );
  for (const replaceFile of plan.selectedReplaceFiles) {
    await failures.collect(async () => {
      assertGameRelativePath(replaceFile.targetRelativePath, plan.context.modRoot);
      logs.push(formatDetailLine('ok', replaceFile.targetRelativePath));
      if (replaceFile.sourceType === 'file') {
        validatedFileOperationTargets += 1;
      } else {
        validatedReplaceTargets += 1;
      }
      replaceProgress.step(replaceFile.targetRelativePath);
    });
  }
  for (const deletion of plan.selectedFileDeletions) {
    await failures.collect(async () => {
      assertGameRelativePath(deletion.targetRelativePath, plan.context.modRoot);
      logs.push(formatDetailLine('ok', deletion.targetRelativePath));
    });
  }
  warningCount += recordPlanNotices(plan, patchNotices) + plan.unmatchedFilters.length;
  logs.push(...describeSkippedPatches(plan));

  reportProgress('Validating replace templates');
  await failures.collect(() => validateReplaceOutputs(plan, yieldController));

  reportProgress('Materializing generated outputs');
  const materializationMetrics = createMaterializationMetrics();
  const patchMaterializationStartedAt = performance.now();
  const materializedFiles =
    (await failures.collect(() =>
      materializeBuild(plan, materializationMetrics, (result) => {
        logs.push(formatScriptTestLogLine(result));
        validatedScriptTests += 1;
      }),
    )) ?? [];
  const afterPatchMaterialization = performance.now();
  for (const writtenFile of materializedFiles) {
    warningCount += recordPatchNotices(writtenFile, patchNotices);
  }
  const scriptFiles = materializedFiles.filter((file) => file.sourceType === 'script');
  for (const writtenFile of scriptFiles) {
    await failures.collect(async () => {
      assertGameRelativePath(writtenFile.targetRelativePath, plan.context.modRoot);
      if (typeof writtenFile.content === 'string' && isNdfPath(writtenFile.targetRelativePath)) {
        await validateNdfPersistentlyMemoized(
          writtenFile.content,
          writtenFile.targetRelativePath,
          plan.context.buildCacheRoot,
          yieldController,
        );
      }
      logs.push(formatDetailLine('ok', writtenFile.targetRelativePath));
      validatedScriptTargets += 1;
    });
  }

  await failures.collect(() =>
    assertRequiredBlockReferences(plan, materializedFiles, yieldController),
  );

  failures.throwIfFailed();
  logs.push(...formatRunFindings(plan, patchNotices, findings));
  return {
    logs,
    metrics: materializationMetrics,
    materializeDurationMs: afterPatchMaterialization - patchMaterializationStartedAt,
    validatedPatchTargets,
    validatedReplaceTargets,
    validatedFileOperationTargets,
    validatedScriptTargets,
    validatedScriptTests,
    warningCount,
  };
}

export async function runBuild(
  builderPath: string | undefined,
  selection: SelectionInput,
): Promise<CommandOutputLines> {
  return withBuilderOperationLock(builderPath, 'build', (context) =>
    runBuildUnlocked(builderPath, selection, context),
  );
}

async function runBuildUnlocked(
  builderPath: string | undefined,
  selection: SelectionInput,
  context?: BuilderContext,
): Promise<CommandOutputLines> {
  const startedAt = performance.now();
  const yieldController = createCooperativeYieldController();
  reportProgress('Preparing build plan');
  const preparedPlan = context
    ? await preparePlanForContext(context, selection)
    : await preparePlan(builderPath, selection);
  const afterPlan = performance.now();
  reportProgress('Materializing build outputs');
  let logs: string[] = [];
  let materializationMetrics = createMaterializationMetrics();
  const materializeStartedAt = performance.now();
  let executedScriptTests = 0;
  let warningCount = 0;
  let unmarkableCount = 0;
  const patchNotices: PatchNotice[] = [];
  const findings: ReportFinding[] = [];
  const { plan, result: writtenFiles } = await withOptionalPatchesResolved(
    preparedPlan,
    (attemptPlan) => {
      // A retry starts the tally over: the attempt before it never happened as
      // far as the summary is concerned.
      logs = [];
      materializationMetrics = createMaterializationMetrics();
      executedScriptTests = 0;
      return materializeAndCheckReferences(
        attemptPlan,
        materializationMetrics,
        yieldController,
        (testResult) => {
          logs.push(formatScriptTestLogLine(testResult));
          executedScriptTests += 1;
        },
      );
    },
  );
  const buildOutputRoot = plan.context.buildOutputRoot;
  const afterMaterialize = performance.now();
  const outputCounts = countWrittenFiles(writtenFiles);
  const builderId = createBuilderId(plan.context.ymbRoot);

  const stagedBuildOutputRoot = selection.dryRun
    ? undefined
    : createTemporarySiblingPath(buildOutputRoot);
  if (stagedBuildOutputRoot) {
    reportProgress('Writing preview output files');
    await mkdir(stagedBuildOutputRoot, { recursive: true });
  }

  const writeStartedAt = performance.now();
  const previewProgress = trackProgress(
    selection.dryRun ? 'Preparing preview output files' : 'Writing preview output files',
    writtenFiles.length,
  );
  try {
    for (const writtenFile of writtenFiles) {
      await yieldController.maybeYield();
      assertGameRelativePath(writtenFile.targetRelativePath, plan.context.modRoot);
      previewProgress.step(writtenFile.targetRelativePath);
      const absoluteOutputPath = stagedBuildOutputRoot
        ? path.join(stagedBuildOutputRoot, ...writtenFile.targetRelativePath.split('/'))
        : undefined;
      const preparedOutput = selection.dryRun
        ? undefined
        : await prepareMarkedOutput(plan.context, writtenFile, builderId, yieldController);
      const previewWarning = preparedOutput
        ? preparedOutput.warning
        : resolveUnmarkableOutputWarning(writtenFile);
      if (previewWarning) {
        const counts = recordUnmarkedTarget({
          targetKind: 'preview',
          targetRelativePath: writtenFile.targetRelativePath,
          reason: previewWarning,
          stateRootPath: plan.context.stateRoot,
          verbose: selection.verbose,
          findings,
        });
        warningCount += counts.warningCount;
        unmarkableCount += counts.unmarkableCount;
      }
      warningCount += recordPatchNotices(writtenFile, patchNotices);
      logs.push(
        formatDetailLine(
          describeSourceType(writtenFile.sourceType),
          writtenFile.targetRelativePath,
        ),
      );

      if (preparedOutput && absoluteOutputPath) {
        await mkdir(path.dirname(absoluteOutputPath), { recursive: true });
        await Bun.write(absoluteOutputPath, preparedOutput.content);
      }
    }
    if (plan.selectedFileDeletions.length > 0) {
      for (const deletion of plan.selectedFileDeletions) {
        logs.push(formatDetailLine('deleted', deletion.targetRelativePath));
      }
      if (stagedBuildOutputRoot) {
        await Bun.write(
          path.join(stagedBuildOutputRoot, '.ymb-deletions.json'),
          `${JSON.stringify(
            {
              version: 1,
              files: plan.selectedFileDeletions.map((item) => item.targetRelativePath),
            },
            null,
            2,
          )}\n`,
        );
      }
    }
    warningCount += recordPlanNotices(plan, patchNotices) + plan.unmatchedFilters.length;
    logs.push(...describeSkippedPatches(plan));
    logs.push(...formatRunFindings(plan, patchNotices, findings));
    if (stagedBuildOutputRoot) {
      await replaceDirectoryAtomic(stagedBuildOutputRoot, buildOutputRoot);
    }
  } catch (error) {
    if (stagedBuildOutputRoot) {
      await removePathDirectly(stagedBuildOutputRoot, { recursive: true }).catch(() => undefined);
    }
    throw error;
  }

  await pruneBuildCache(plan.context);
  const finishedAt = performance.now();
  return toCommandOutput(logs, {
    summary: [
      countFact('wrote', [
        ['file', writtenFiles.length],
        ['patched file', outputCounts.patch],
        ['generated file', outputCounts.script],
        ['replaced file', outputCounts.replace],
        ['file-operation output', outputCounts.file],
        ['deleted file', plan.selectedFileDeletions.length],
        ['warning', warningCount],
        ['output without in-file markers', unmarkableCount, 'outputs without in-file markers'],
        ['script test', executedScriptTests],
        ['skipped optional patch', plan.skippedPatches.length, 'skipped optional patches'],
      ]),
      timingFact(finishedAt - startedAt, [
        ['plan', afterPlan - startedAt],
        ['materialize', afterMaterialize - materializeStartedAt],
        ['write', finishedAt - writeStartedAt],
      ]),
      patchCacheFact(materializationMetrics),
    ],
    detailHeading: 'preview files',
    locations: [{ label: 'preview', path: buildOutputRoot }],
    nextSteps: selection.dryRun
      ? ['Run `build` to write the preview files.']
      : [
          'Open the preview folder and inspect the files you changed.',
          'Run `sync --yes` only after the preview looks correct.',
        ],
  });
}

export async function runSync(
  builderPath: string | undefined,
  selection: SelectionInput,
): Promise<CommandOutputLines> {
  return withBuilderOperationLock(builderPath, 'sync', (context) =>
    runSyncUnlocked(builderPath, selection, context),
  );
}

async function runSyncUnlocked(
  builderPath: string | undefined,
  selection: SelectionInput,
  context?: BuilderContext,
): Promise<CommandOutputLines> {
  const startedAt = performance.now();
  const yieldController = createCooperativeYieldController();
  reportProgress('Preparing sync plan');
  // Reassigned when an `optional` feature turns out to need game data this
  // install does not have; everything below reads the plan that was built.
  let plan = context
    ? await preparePlanForContext(context, selection)
    : await preparePlan(builderPath, selection);
  const afterPlan = performance.now();
  const logs: string[] = [];
  reportProgress('Loading sync manifest');
  const manifestEntriesByTarget = createManifestEntryMap(
    await loadManifest(plan.context.stateRoot),
  );
  await assertTrackedBackupsExist(plan.context, manifestEntriesByTarget.values());
  reportProgress('Checking tracked live files');
  const changedEntries = await findChangedTrackedTargets(
    plan.context,
    manifestEntriesByTarget.values(),
    selection,
    yieldController,
  );
  // Fails before the expensive part of the run, and before any live file is
  // touched, so a refused sync costs the plan and nothing else.
  assertChangedTrackedTargetsAreAllowed(plan.context, changedEntries, selection);
  const originalsRoot = path.join(
    plan.context.stateRoot,
    BUILDER_CONFIG.recoveryOriginalsDirectoryName,
  );
  const builderId = createBuilderId(plan.context.ymbRoot);
  const materializationMetrics = createMaterializationMetrics();
  let executedScriptTests = 0;
  let warningCount = 0;
  let unmarkableCount = 0;
  let skippedCount = 0;
  let syncedCount = 0;
  let deletedCount = 0;
  let obsoleteCount = 0;
  let resetCount = 0;
  let sweptOrphanCount = 0;
  const patchNotices: PatchNotice[] = [];
  const findings: ReportFinding[] = [];
  let writtenFiles: WrittenBuildFile[] = [];
  let materializeStartedAt = performance.now();
  let afterMaterialize = materializeStartedAt;
  let syncStartedAt = materializeStartedAt;
  // A reset writes live files before materialization, so the transaction has to
  // be open by then. With nothing to reset it opens where it always did, which
  // keeps an ordinary failed build free of rollback work.
  let transaction =
    selection.dryRun || changedEntries.length === 0
      ? undefined
      : await beginStateTransaction(plan.context, 'sync');

  try {
    resetCount = await resetChangedTrackedTargets({
      context: plan.context,
      changedEntries,
      manifestEntriesByTarget,
      transaction,
      selection,
      logs,
      yieldController,
    });

    reportProgress('Materializing sync outputs');
    materializeStartedAt = performance.now();
    // Nothing has been written to the live mod root yet - a reset only puts
    // originals back - so a plan that has to lose an optional feature can still
    // be worked out here, before anything irreversible happens.
    const logsBeforeMaterialize = logs.length;
    const materialized = await withOptionalPatchesResolved(plan, (attemptPlan) => {
      logs.length = logsBeforeMaterialize;
      Object.assign(materializationMetrics, createMaterializationMetrics());
      executedScriptTests = 0;
      return materializeAndCheckReferences(
        attemptPlan,
        materializationMetrics,
        yieldController,
        (result) => {
          logs.push(formatScriptTestLogLine(result));
          executedScriptTests += 1;
        },
      );
    });
    plan = materialized.plan;
    writtenFiles = materialized.result;
    afterMaterialize = performance.now();
    syncStartedAt = afterMaterialize;
    await yieldController.maybeYield();
    if (!selection.dryRun) {
      // Creating the originals folder changes the recovery root, so it has to
      // happen after the transaction has snapshotted it - otherwise a rollback
      // restores a state root that never matched what the run started from.
      transaction ??= await beginStateTransaction(plan.context, 'sync');
      await mkdir(originalsRoot, { recursive: true });
    }

    const syncProgress = trackProgress('Syncing live files', writtenFiles.length);
    for (const writtenFile of writtenFiles) {
      await yieldController.maybeYield();
      const targetAbsolutePath = resolveModTargetPath(
        plan.context.modRoot,
        writtenFile.targetRelativePath,
      );
      syncProgress.step(writtenFile.targetRelativePath);
      const isTextOutput = typeof writtenFile.content === 'string';
      const preparedOutput = await prepareMarkedOutput(
        plan.context,
        writtenFile,
        builderId,
        yieldController,
      );
      const targetFile = Bun.file(targetAbsolutePath);
      const targetExists = await targetFile.exists();
      await yieldController.maybeYield();
      const existingBytes = targetExists
        ? new Uint8Array(await targetFile.arrayBuffer())
        : new Uint8Array(0);
      const existingHash = targetExists ? hashBytes(existingBytes) : undefined;
      const existingText =
        isTextOutput && targetExists ? Buffer.from(existingBytes).toString('utf8') : '';
      const existing = isTextOutput
        ? unwrapMarkedContent(existingText)
        : { payload: undefined, innerContent: '' };
      const targetKey = toPathKey(writtenFile.targetRelativePath);
      const existingEntry = manifestEntriesByTarget.get(targetKey);

      if (existing.payload?.builderId === builderId) {
        ensure(isMarkedContentIntact(existing, writtenFile.targetRelativePath), 'RecoveryError', {
          absolutePath: targetAbsolutePath,
          reason: `Tracked output \`${writtenFile.targetRelativePath}\` was changed after ${BUILDER_CONFIG.name} wrote it.`,
          suggestion:
            'Preserve your manual edits elsewhere, then recover or restore the file before syncing again.',
        });
      }
      assertSyncedTargetIsUnchanged(existingEntry, targetExists, existingHash, targetAbsolutePath);

      if (preparedOutput.warning) {
        const counts = recordUnmarkedTarget({
          targetKind: 'sync',
          targetRelativePath: writtenFile.targetRelativePath,
          reason: preparedOutput.warning,
          stateRootPath: plan.context.stateRoot,
          verbose: selection.verbose,
          findings,
        });
        warningCount += counts.warningCount;
        unmarkableCount += counts.unmarkableCount;
      }
      // Reported before the up-to-date check: an operation that changed nothing
      // is worth saying whether or not this run had to rewrite the file.
      warningCount += recordPatchNotices(writtenFile, patchNotices);

      if (
        (isTextOutput &&
          ((existing.payload?.builderId === builderId &&
            existing.payload.markerHash === preparedOutput.markerHash) ||
            (preparedOutput.warning &&
              targetExists &&
              existingHash === preparedOutput.markerHash))) ||
        (!isTextOutput && targetExists && existingHash === preparedOutput.markerHash)
      ) {
        logs.push(formatDetailLine('current', writtenFile.targetRelativePath));
        skippedCount += 1;
        continue;
      }

      const originalContent = await loadOriginalBackupBytes(
        plan.context,
        targetAbsolutePath,
        existingEntry?.backupFileName,
        existingEntry?.originalContentHash,
      );
      const backupFileName = `${preparedOutput.markerId}${isTextOutput ? '.ndf' : '.bin'}`;
      const outputContent = preparedOutput.content;

      logs.push(
        formatDetailLine(
          describeSourceType(writtenFile.sourceType),
          writtenFile.targetRelativePath,
        ),
      );
      syncedCount += 1;
      if (selection.dryRun) {
        continue;
      }

      await assertRealPathWithinRoot(targetAbsolutePath, plan.context.modRoot, 'mod root');
      await recordStateTransactionTarget(
        requireStateTransaction(transaction),
        writtenFile.targetRelativePath,
      );
      await mkdir(path.dirname(targetAbsolutePath), { recursive: true });
      await writeFileAtomic(path.join(originalsRoot, backupFileName), originalContent);
      manifestEntriesByTarget.set(targetKey, {
        targetRelativePath: writtenFile.targetRelativePath,
        backupFileName,
        originalExists: existingEntry?.originalExists ?? targetExists,
        expectedState: 'present',
        originalContentHash: existingEntry?.originalContentHash ?? hashBytes(originalContent),
        syncedContentHash: hashContent(outputContent),
        contributors: writtenFile.contributors,
      });
      // The manifest is saved once after the loop. An interrupted sync is undone by
      // the state transaction, so rewriting the whole ledger per file only costs
      // quadratic I/O without adding recovery coverage.
      await writeFileAtomic(targetAbsolutePath, outputContent);
    }

    for (const deletion of plan.selectedFileDeletions) {
      await yieldController.maybeYield();
      deletedCount += await syncFileDeletion({
        context: plan.context,
        deletion,
        manifestEntriesByTarget,
        originalsRoot,
        selection,
        logs,
        transaction,
      });
    }

    warningCount += recordPlanNotices(plan, patchNotices) + plan.unmatchedFilters.length;
    logs.push(...describeSkippedPatches(plan));
    logs.push(...formatRunFindings(plan, patchNotices, findings));
    obsoleteCount = await cleanupObsoleteTrackedTargets({
      context: plan.context,
      manifestEntriesByTarget,
      writtenFiles,
      fileDeletions: plan.selectedFileDeletions,
      selection,
      logs,
      yieldController,
      transaction,
    });

    if (!selection.dryRun) {
      reportProgress('Saving sync manifest');
      await saveManifest(plan.context.stateRoot, createSortedManifest(manifestEntriesByTarget));
      const sweep = await sweepOrphanedBackups(plan.context, manifestEntriesByTarget);
      sweptOrphanCount = sweep.sweptCount;
      logs.push(...sweep.lines, ...formatFindingGroups(sweep.findings));
      await commitStateTransaction(requireStateTransaction(transaction));
    }
  } catch (error) {
    await rollbackStateTransactionAfterFailure(transaction, error);
  }

  await pruneBuildCache(plan.context);
  const finishedAt = performance.now();
  return toCommandOutput(logs, {
    summary: [
      countFact('applied', [
        ['updated file', syncedCount],
        ['deleted file', deletedCount],
        ['unchanged file', skippedCount],
        ['removed old file', obsoleteCount],
        ['file reset to its original', resetCount, 'files reset to their originals'],
        ['swept orphan backup', sweptOrphanCount],
        ['warning', warningCount],
        ['output without in-file markers', unmarkableCount, 'outputs without in-file markers'],
        ['script test', executedScriptTests],
        ['skipped optional patch', plan.skippedPatches.length, 'skipped optional patches'],
      ]),
      timingFact(finishedAt - startedAt, [
        ['plan', afterPlan - startedAt],
        ['materialize', afterMaterialize - materializeStartedAt],
        ['write', finishedAt - syncStartedAt],
      ]),
      patchCacheFact(materializationMetrics),
    ],
    detailHeading: 'live file updates',
    locations: [
      { label: 'live mod root', path: plan.context.modRoot },
      { label: 'recovery state', path: plan.context.stateRoot },
    ],
    nextSteps: selection.dryRun
      ? ['Re-run with `--yes` if the plan looks correct.']
      : [
          'Test the live mod in WARNO.',
          'Run `recover --yes` if you need to roll these tracked files back.',
        ],
  });
}

/**
 * Inside the attempt rather than after it, so an `optional` patch whose block was
 * orphaned is dropped and the run continues, as for a selector that stopped matching.
 */
async function materializeAndCheckReferences(
  plan: BuildPlan,
  metrics: ReturnType<typeof createMaterializationMetrics>,
  yieldController: CooperativeYieldController,
  onScriptTest: Parameters<typeof materializeBuild>[2],
): Promise<WrittenBuildFile[]> {
  const writtenFiles = await materializeBuild(plan, metrics, onScriptTest);
  await assertRequiredBlockReferences(plan, writtenFiles, yieldController);
  return writtenFiles;
}

/**
 * Patch notices and marker findings read the same way, so they are grouped together
 * rather than in two blocks repeating one layout. Paths are shortened against the
 * source-mod root, the only part a reader has to type back.
 */
function formatRunFindings(
  plan: BuildPlan,
  patchNotices: PatchNotice[],
  findings: ReportFinding[],
): string[] {
  return formatFindingGroups([
    ...plan.unmatchedFilters.map(toUnmatchedFilterFinding),
    ...patchNotices.map((notice) => toPatchReportFinding(notice, plan.context.modsRoot)),
    ...findings,
  ]);
}

function recordPatchNotices(writtenFile: WrittenBuildFile, collected: PatchNotice[]): number {
  return recordNotices(writtenFile.notices, collected);
}

/**
 * Notices from planning rather than from patching a file: a file operation whose
 * target is already gone never reaches an output to hang them on.
 */
function recordPlanNotices(plan: BuildPlan, collected: PatchNotice[]): number {
  return recordNotices(plan.notices, collected);
}

/** Held, not printed: grouped by fix at the end so the advice is stated once. */
function recordNotices(notices: PatchNotice[] | undefined, collected: PatchNotice[]): number {
  collected.push(...(notices ?? []));
  return notices?.length ?? 0;
}

/**
 * Every command that plans an `optional` patch out reports it, so a feature that
 * quietly did nothing is visible rather than silent.
 */
function describeSkippedPatches(plan: BuildPlan): string[] {
  return plan.skippedPatches.map((skipped) =>
    formatDetailLine('skipped', skipped.patchId, skipped.reason),
  );
}

/** Which shared status names what produced an output. */
function describeSourceType(sourceType: WrittenBuildFile['sourceType']): DetailStatus {
  switch (sourceType) {
    case 'patch':
      return 'patched';
    case 'replace':
      return 'replaced';
    case 'file':
      return 'file op';
    case 'script':
      return 'generated';
  }
}

async function syncFileDeletion(args: {
  context: BuilderContext;
  deletion: FileDeletion;
  manifestEntriesByTarget: Map<string, SyncManifestEntry>;
  originalsRoot: string;
  selection: SelectionInput;
  logs: string[];
  transaction: StateTransaction | undefined;
}): Promise<number> {
  const targetKey = toPathKey(args.deletion.targetRelativePath);
  const targetAbsolutePath = resolveModTargetPath(
    args.context.modRoot,
    args.deletion.targetRelativePath,
  );
  const existingEntry = args.manifestEntriesByTarget.get(targetKey);
  const targetExists = await pathExists(targetAbsolutePath);
  // Telling a file that came back untouched from one holding something else
  // needs the bytes, so a present target is always read here.
  const existingBytes = targetExists
    ? new Uint8Array(await Bun.file(targetAbsolutePath).arrayBuffer())
    : undefined;
  const existingHash = existingBytes ? hashBytes(existingBytes) : undefined;
  assertSyncedTargetIsUnchanged(existingEntry, targetExists, existingHash, targetAbsolutePath);

  // Already absent means there is nothing to do. A tracked deletion whose file
  // came back with its original bytes still has to be deleted again.
  if (existingEntry?.expectedState === 'absent' && !targetExists) {
    args.logs.push(formatDetailLine('current', args.deletion.targetRelativePath));
    return 0;
  }

  const originalContent = await loadOriginalBackupBytes(
    args.context,
    targetAbsolutePath,
    existingEntry?.backupFileName,
    existingEntry?.originalContentHash,
  );
  const backupFileName =
    existingEntry?.backupFileName ??
    `${hashText(`delete:${args.deletion.targetRelativePath}:${hashBytes(originalContent)}`)}.bin`;
  args.logs.push(formatDetailLine('deleted', args.deletion.targetRelativePath));
  if (args.selection.dryRun) {
    return 1;
  }

  await assertRealPathWithinRoot(targetAbsolutePath, args.context.modRoot, 'mod root');
  await recordStateTransactionTarget(
    requireStateTransaction(args.transaction),
    args.deletion.targetRelativePath,
  );
  await writeFileAtomic(path.join(args.originalsRoot, backupFileName), originalContent);
  await removePathDirectly(targetAbsolutePath);
  args.manifestEntriesByTarget.set(targetKey, {
    targetRelativePath: args.deletion.targetRelativePath,
    backupFileName,
    originalExists: existingEntry?.originalExists ?? true,
    expectedState: 'absent',
    originalContentHash: existingEntry?.originalContentHash ?? hashBytes(originalContent),
    contributors: [
      {
        modId: args.deletion.modId,
        modName: args.deletion.modName,
        patchId: args.deletion.patchId,
      },
    ],
  });
  return 1;
}

async function cleanupObsoleteTrackedTargets(args: {
  context: BuilderContext;
  manifestEntriesByTarget: Map<string, SyncManifestEntry>;
  writtenFiles: WrittenBuildFile[];
  fileDeletions: FileDeletion[];
  selection: SelectionInput;
  logs: string[];
  yieldController?: CooperativeYieldController | undefined;
  transaction?: StateTransaction | undefined;
}): Promise<number> {
  const liveTargetPaths = new Set(
    [
      ...args.writtenFiles.map((file) => file.targetRelativePath),
      ...args.fileDeletions.map((deletion) => deletion.targetRelativePath),
    ].map(toPathKey),
  );
  const obsoleteEntries = [...args.manifestEntriesByTarget.values()].filter((entry) => {
    return (
      !liveTargetPaths.has(toPathKey(entry.targetRelativePath)) &&
      entry.contributors.some((item) => matchesSelection(item, args.selection))
    );
  });
  if (obsoleteEntries.length === 0) {
    return 0;
  }

  let obsoleteCount = 0;
  const restoredTargets: string[] = [];
  const deletedTargets: string[] = [];
  const progress = trackProgress('Cleaning obsolete live files', obsoleteEntries.length);
  for (const entry of obsoleteEntries) {
    await args.yieldController?.maybeYield();
    progress.step(entry.targetRelativePath);
    (entry.originalExists ? restoredTargets : deletedTargets).push(entry.targetRelativePath);
    obsoleteCount += 1;
    if (args.selection.dryRun) {
      continue;
    }

    await recordStateTransactionTarget(
      requireStateTransaction(args.transaction),
      entry.targetRelativePath,
    );
    await restoreOrDeleteTrackedTarget({
      context: args.context,
      entry,
      missingBackupReason: `Missing recovery backup for obsolete tracked target \`${entry.targetRelativePath}\`.`,
      missingBackupSuggestion:
        'Restore the missing backup from YMB state, or recover the file before syncing again.',
      requireBackup: entry.originalExists,
    });
    args.manifestEntriesByTarget.delete(toPathKey(entry.targetRelativePath));
  }

  args.logs.push(...formatFindingGroups(toObsoleteTargetFindings(restoredTargets, deletedTargets)));
  return obsoleteCount;
}

export { runRecover } from './recovery.ts';
