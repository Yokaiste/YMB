import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { type CooperativeYieldController, createCooperativeYieldController } from '../async.ts';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { ensure } from '../errors.ts';
import { hashBytes, hashText, toBytes } from '../hash.ts';
import {
  createBuilderId,
  decorateTextWithExactMarkers,
  decorateTextWithExactMarkersCooperative,
  isMarkedContentIntact,
  loadManifest,
  saveManifest,
  supportsMarkerComments,
  unwrapMarkedContent,
  wrapWithMarker,
} from '../markers.ts';
import { withBuilderOperationLock } from '../operation-lock.ts';
import { isNdfPath } from '../patch/ndf.ts';
import {
  assertGameRelativePath,
  assertRealPathWithinRoot,
  createTemporarySiblingPath,
  pathExists,
  removePathDirectly,
  replaceDirectoryAtomic,
  resolveModTargetPath,
  toPathKey,
  writeFileAtomic,
} from '../path-utils.ts';
import { formatScriptTestLabel } from '../scripts/testing.ts';
import {
  beginStateTransaction,
  commitStateTransaction,
  recordStateTransactionTarget,
  type StateTransaction,
} from '../state-transaction.ts';
import { createTemplateVariables } from '../templates.ts';
import { readTrackedText, readTrackedTextCooperative } from '../tracked-targets.ts';
import type {
  BuilderContext,
  SelectionInput,
  SyncManifestEntry,
  WrittenBuildFile,
} from '../types.ts';
import { pruneCacheDirectory } from './cache-store.ts';
import {
  type CommandOutputLines,
  countWrittenFiles,
  createMaterializationMetrics,
  createSummaryLines,
  formatCountSummary,
  formatPatchCacheSummary,
  formatTimingSummary,
  withOutputMeta,
  withSummary,
} from './command-output.ts';
import { materializeBuild, validateReplaceOutputs } from './materialize.ts';
import { preparePlan } from './plan.ts';
import { abbreviateProgressPath, reportProgress } from './progress.ts';
import {
  assertSyncedTargetIsUnchanged,
  createManifestEntryMap,
  createSortedManifest,
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
export { setCommandProgressReporter } from './progress.ts';

export async function runValidate(
  builderPath: string | undefined,
  selection: SelectionInput,
): Promise<CommandOutputLines> {
  return withBuilderOperationLock(builderPath, 'validate', () =>
    runValidateUnlocked(builderPath, selection),
  );
}

async function runValidateUnlocked(
  builderPath: string | undefined,
  selection: SelectionInput,
): Promise<CommandOutputLines> {
  const startedAt = performance.now();
  const yieldController = createCooperativeYieldController();
  reportProgress('Preparing validation plan');
  const plan = await preparePlan(builderPath, selection);
  const afterPlan = performance.now();
  const logs = [
    `builder ok -> ${plan.context.modRoot}`,
    `discovered -> ${plan.discoveredMods.length} source mod`,
    `selected -> ${plan.selectedPatches.length} patch`,
  ];
  const totalPatchTargets = plan.selectedPatches.reduce(
    (count, selected) => count + selected.patch.config.targets.length,
    0,
  );
  let validatedPatchTargets = 0;
  let validatedReplaceTargets = 0;
  let validatedScriptTargets = 0;
  let validatedScriptTests = 0;

  reportProgress('Validating patch targets', undefined, {
    current: 0,
    total: totalPatchTargets,
  });
  for (const selected of plan.selectedPatches) {
    await yieldController.maybeYield();
    const templateVariables = createTemplateVariables(plan.context, selected.mod, selected.patch);
    for (const target of selected.patch.config.targets) {
      await yieldController.maybeYield();
      const resolvedTarget = resolveVariablesInTarget(target, templateVariables);
      const absolutePath = resolveModTargetPath(plan.context.modRoot, resolvedTarget.file);
      await readTextOrThrow(plan.context, absolutePath, selected, resolvedTarget.file);
      logs.push(`patch ok -> ${resolvedTarget.file.replace(/\\/g, '/')}`);
      validatedPatchTargets += 1;
      reportProgress('Validating patch targets', abbreviateProgressPath(resolvedTarget.file), {
        current: validatedPatchTargets,
        total: totalPatchTargets,
      });
    }
  }

  reportProgress('Validating replace files', undefined, {
    current: 0,
    total: plan.selectedReplaceFiles.length,
  });
  for (const replaceFile of plan.selectedReplaceFiles) {
    assertGameRelativePath(replaceFile.targetRelativePath, plan.context.modRoot);
    logs.push(`replace ok -> ${replaceFile.targetRelativePath}`);
    validatedReplaceTargets += 1;
    reportProgress(
      'Validating replace files',
      abbreviateProgressPath(replaceFile.targetRelativePath),
      {
        current: validatedReplaceTargets,
        total: plan.selectedReplaceFiles.length,
      },
    );
  }

  reportProgress('Validating replace templates');
  await validateReplaceOutputs(plan, yieldController);

  reportProgress('Materializing generated outputs');
  const materializationMetrics = createMaterializationMetrics();
  const patchMaterializationStartedAt = performance.now();
  const materializedFiles = await materializeBuild(plan, materializationMetrics, (result) => {
    logs.push(
      `${result.cached ? 'script test cached ok' : 'script test ok'} -> ${formatScriptTestLabel(result)}`,
    );
    validatedScriptTests += 1;
  });
  const afterPatchMaterialization = performance.now();
  const scriptFiles = materializedFiles.filter((file) => file.sourceType === 'script');
  for (const writtenFile of scriptFiles) {
    assertGameRelativePath(writtenFile.targetRelativePath, plan.context.modRoot);
    if (typeof writtenFile.content === 'string' && isNdfPath(writtenFile.targetRelativePath)) {
      await validateNdfPersistentlyMemoized(
        writtenFile.content,
        writtenFile.targetRelativePath,
        path.join(plan.context.buildRoot, BUILDER_CONFIG.cacheDirectoryName),
        yieldController,
      );
    }
    logs.push(`script output ok -> ${writtenFile.targetRelativePath}`);
    validatedScriptTargets += 1;
  }

  await pruneCacheDirectory(path.join(plan.context.buildRoot, BUILDER_CONFIG.cacheDirectoryName));

  const finishedAt = performance.now();
  return withOutputMeta(
    withSummary(
      logs,
      createSummaryLines([
        formatCountSummary('validated', [
          ['patch target', validatedPatchTargets],
          ['replace file', validatedReplaceTargets],
          ['script output', validatedScriptTargets],
          ['script test', validatedScriptTests],
        ]),
        formatTimingSummary(finishedAt - startedAt, [
          ['plan', afterPlan - startedAt],
          ['materialize', afterPatchMaterialization - patchMaterializationStartedAt],
        ]),
        formatPatchCacheSummary(materializationMetrics),
      ]),
    ),
    {
      detailHeading: 'checks',
      nextSteps: [
        'Run `build` to write a preview.',
        'Run `explain` if the selected patches still look wrong.',
      ],
    },
  );
}

export async function runBuild(
  builderPath: string | undefined,
  selection: SelectionInput,
): Promise<CommandOutputLines> {
  return withBuilderOperationLock(builderPath, 'build', () =>
    runBuildUnlocked(builderPath, selection),
  );
}

async function runBuildUnlocked(
  builderPath: string | undefined,
  selection: SelectionInput,
): Promise<CommandOutputLines> {
  const startedAt = performance.now();
  const yieldController = createCooperativeYieldController();
  reportProgress('Preparing build plan');
  const plan = await preparePlan(builderPath, selection);
  const afterPlan = performance.now();
  const buildOutputRoot = path.join(
    plan.context.buildRoot,
    BUILDER_CONFIG.buildOutputDirectoryName,
  );
  reportProgress('Materializing build outputs');
  const logs: string[] = [];
  const materializationMetrics = createMaterializationMetrics();
  const materializeStartedAt = performance.now();
  let executedScriptTests = 0;
  let warningCount = 0;
  const writtenFiles = await materializeBuild(plan, materializationMetrics, (result) => {
    logs.push(
      `${result.cached ? 'script test cached ok' : 'script test ok'} -> ${formatScriptTestLabel(result)}`,
    );
    executedScriptTests += 1;
  });
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
  try {
    for (const [writtenIndex, writtenFile] of writtenFiles.entries()) {
      await yieldController.maybeYield();
      assertGameRelativePath(writtenFile.targetRelativePath, plan.context.modRoot);
      reportProgress(
        selection.dryRun ? 'Preparing preview output files' : 'Writing preview output files',
        abbreviateProgressPath(writtenFile.targetRelativePath),
        {
          current: writtenIndex + 1,
          total: writtenFiles.length,
        },
      );
      const absoluteOutputPath = stagedBuildOutputRoot
        ? path.join(stagedBuildOutputRoot, ...writtenFile.targetRelativePath.split('/'))
        : undefined;
      const preparedOutput = selection.dryRun
        ? undefined
        : await prepareMarkedOutput(plan.context, writtenFile, builderId, yieldController);
      const previewWarning = preparedOutput
        ? preparedOutput.warning
        : resolveDryRunPreviewWarning(writtenFile);
      if (previewWarning) {
        logs.push(
          formatUnmarkedTargetWarning('preview', writtenFile.targetRelativePath, previewWarning),
        );
        warningCount += 1;
      }
      logs.push(`${writtenFile.sourceType} -> ${writtenFile.targetRelativePath}`);

      if (preparedOutput && absoluteOutputPath) {
        await mkdir(path.dirname(absoluteOutputPath), { recursive: true });
        await Bun.write(absoluteOutputPath, preparedOutput.content);
      }
    }
    if (stagedBuildOutputRoot) {
      await replaceDirectoryAtomic(stagedBuildOutputRoot, buildOutputRoot);
    }
  } catch (error) {
    if (stagedBuildOutputRoot) {
      await removePathDirectly(stagedBuildOutputRoot, { recursive: true }).catch(() => undefined);
    }
    throw error;
  }

  await pruneCacheDirectory(path.join(plan.context.buildRoot, BUILDER_CONFIG.cacheDirectoryName));
  const finishedAt = performance.now();
  return withOutputMeta(
    withSummary(
      logs,
      createSummaryLines([
        formatCountSummary('outputs', [
          ['file', writtenFiles.length],
          ['patch', outputCounts.patch],
          ['script', outputCounts.script],
          ['replace', outputCounts.replace],
          ['warning', warningCount],
          ['script test', executedScriptTests],
        ]),
        formatTimingSummary(finishedAt - startedAt, [
          ['plan', afterPlan - startedAt],
          ['materialize', afterMaterialize - materializeStartedAt],
          ['write', finishedAt - writeStartedAt],
        ]),
        formatPatchCacheSummary(materializationMetrics),
      ]),
    ),
    {
      detailHeading: 'preview files',
      locations: [{ label: 'preview', path: buildOutputRoot }],
      nextSteps: selection.dryRun
        ? ['Run `build` to write the preview files.']
        : [
            'Open the preview folder and inspect the files you changed.',
            'Run `sync --yes` only after the preview looks correct.',
          ],
    },
  );
}

export async function runSync(
  builderPath: string | undefined,
  selection: SelectionInput,
): Promise<CommandOutputLines> {
  return withBuilderOperationLock(builderPath, 'sync', () =>
    runSyncUnlocked(builderPath, selection),
  );
}

async function runSyncUnlocked(
  builderPath: string | undefined,
  selection: SelectionInput,
): Promise<CommandOutputLines> {
  const startedAt = performance.now();
  const yieldController = createCooperativeYieldController();
  reportProgress('Preparing sync plan');
  const plan = await preparePlan(builderPath, selection);
  const afterPlan = performance.now();
  reportProgress('Materializing sync outputs');
  const logs: string[] = [];
  const materializationMetrics = createMaterializationMetrics();
  const materializeStartedAt = performance.now();
  let executedScriptTests = 0;
  const writtenFiles = await materializeBuild(plan, materializationMetrics, (result) => {
    logs.push(
      `${result.cached ? 'script test cached ok' : 'script test ok'} -> ${formatScriptTestLabel(result)}`,
    );
    executedScriptTests += 1;
  });
  const afterMaterialize = performance.now();
  await yieldController.maybeYield();
  reportProgress('Loading sync manifest');
  const manifestEntriesByTarget = createManifestEntryMap(
    await loadManifest(plan.context.stateRoot),
  );
  const originalsRoot = path.join(
    plan.context.stateRoot,
    BUILDER_CONFIG.recoveryOriginalsDirectoryName,
  );
  const builderId = createBuilderId(plan.context.ymbRoot);
  let warningCount = 0;
  let skippedCount = 0;
  let syncedCount = 0;
  let obsoleteCount = 0;
  const transaction = selection.dryRun
    ? undefined
    : await beginStateTransaction(plan.context, 'sync');
  const syncStartedAt = performance.now();

  try {
    if (!selection.dryRun) {
      await mkdir(originalsRoot, { recursive: true });
    }

    reportProgress('Syncing live files', undefined, {
      current: 0,
      total: writtenFiles.length,
    });
    for (const [writtenIndex, writtenFile] of writtenFiles.entries()) {
      await yieldController.maybeYield();
      const targetAbsolutePath = resolveModTargetPath(
        plan.context.modRoot,
        writtenFile.targetRelativePath,
      );
      reportProgress('Syncing live files', abbreviateProgressPath(writtenFile.targetRelativePath), {
        current: writtenIndex + 1,
        total: writtenFiles.length,
      });
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
        logs.push(
          formatUnmarkedTargetWarning(
            'sync',
            writtenFile.targetRelativePath,
            preparedOutput.warning,
          ),
        );
        warningCount += 1;
      }

      if (
        (isTextOutput &&
          ((existing.payload?.builderId === builderId &&
            existing.payload.markerHash === preparedOutput.markerHash) ||
            (preparedOutput.warning &&
              targetExists &&
              existingHash === preparedOutput.markerHash))) ||
        (!isTextOutput && targetExists && existingHash === preparedOutput.markerHash)
      ) {
        logs.push(`unchanged -> ${writtenFile.targetRelativePath}`);
        skippedCount += 1;
        continue;
      }

      const originalContent = await loadOriginalBackupBytes(
        plan.context,
        targetAbsolutePath,
        existingEntry?.backupFileName,
      );
      const backupFileName = `${preparedOutput.markerId}${isTextOutput ? '.ndf' : '.bin'}`;
      const outputContent = preparedOutput.content;

      logs.push(`${writtenFile.sourceType} -> ${writtenFile.targetRelativePath}`);
      syncedCount += 1;
      if (selection.dryRun) {
        continue;
      }

      await assertRealPathWithinRoot(targetAbsolutePath, plan.context.modRoot, 'mod root');
      await recordStateTransactionTarget(
        transaction as StateTransaction,
        writtenFile.targetRelativePath,
      );
      await mkdir(path.dirname(targetAbsolutePath), { recursive: true });
      await writeFileAtomic(path.join(originalsRoot, backupFileName), originalContent);
      manifestEntriesByTarget.set(targetKey, {
        targetRelativePath: writtenFile.targetRelativePath,
        backupFileName,
        originalExists: targetExists,
        syncedContentHash: hashBytes(toBytes(outputContent)),
        contributors: writtenFile.contributors,
      });
      await saveManifest(plan.context.stateRoot, createSortedManifest(manifestEntriesByTarget));
      await writeFileAtomic(targetAbsolutePath, outputContent);
    }

    obsoleteCount = await cleanupObsoleteTrackedTargets({
      context: plan.context,
      manifestEntriesByTarget,
      writtenFiles,
      selection,
      logs,
      yieldController,
      transaction,
    });

    if (!selection.dryRun) {
      reportProgress('Saving sync manifest');
      await saveManifest(plan.context.stateRoot, createSortedManifest(manifestEntriesByTarget));
      await sweepOrphanedBackups(plan.context, manifestEntriesByTarget, logs);
      await commitStateTransaction(transaction as StateTransaction);
    }
  } catch (error) {
    await rollbackStateTransactionAfterFailure(transaction, error);
  }

  await pruneCacheDirectory(path.join(plan.context.buildRoot, BUILDER_CONFIG.cacheDirectoryName));
  const finishedAt = performance.now();
  return withOutputMeta(
    withSummary(
      logs,
      createSummaryLines([
        formatCountSummary('sync', [
          ['changed', syncedCount],
          ['unchanged', skippedCount],
          ['obsolete cleaned', obsoleteCount],
          ['warning', warningCount],
          ['script test', executedScriptTests],
        ]),
        formatTimingSummary(finishedAt - startedAt, [
          ['plan', afterPlan - startedAt],
          ['materialize', afterMaterialize - materializeStartedAt],
          ['write', finishedAt - syncStartedAt],
        ]),
        formatPatchCacheSummary(materializationMetrics),
      ]),
    ),
    {
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
    },
  );
}

interface PreparedMarkedOutput {
  content: string | Uint8Array;
  markerId: string;
  markerHash: string;
  warning?: 'unsupported_comment_syntax' | 'binary_output' | 'exact_change_budget_exceeded';
}

function resolveDryRunPreviewWarning(
  writtenFile: WrittenBuildFile,
): PreparedMarkedOutput['warning'] | undefined {
  if (typeof writtenFile.content !== 'string') {
    return 'binary_output';
  }
  if (!supportsMarkerComments(writtenFile.targetRelativePath)) {
    return 'unsupported_comment_syntax';
  }
  return undefined;
}

async function prepareMarkedOutput(
  context: BuilderContext,
  writtenFile: WrittenBuildFile,
  builderId: string,
  yieldController?: CooperativeYieldController,
): Promise<PreparedMarkedOutput> {
  if (typeof writtenFile.content !== 'string') {
    const markerHash = hashBytes(toBytes(writtenFile.content));
    return {
      content: writtenFile.content,
      markerId: hashText(`${writtenFile.targetRelativePath}:${markerHash}`),
      markerHash,
      warning: 'binary_output',
    };
  }

  if (!supportsMarkerComments(writtenFile.targetRelativePath)) {
    const markerHash = hashBytes(toBytes(writtenFile.content));
    return {
      content: writtenFile.content,
      markerId: hashText(`${writtenFile.targetRelativePath}:${markerHash}`),
      markerHash,
      warning: 'unsupported_comment_syntax',
    };
  }

  const exactMarkedContent =
    writtenFile.sourceType === 'patch'
      ? { content: writtenFile.content, warning: undefined }
      : yieldController
        ? await decorateTextWithExactMarkersCooperative(
            await loadMarkerBaseText(context, writtenFile.targetRelativePath, yieldController),
            writtenFile.content,
            writtenFile.targetRelativePath,
            builderId,
            writtenFile.contributors,
            yieldController,
          )
        : decorateTextWithExactMarkers(
            await loadMarkerBaseText(context, writtenFile.targetRelativePath, yieldController),
            writtenFile.content,
            writtenFile.targetRelativePath,
            builderId,
            writtenFile.contributors,
          );
  const markerHash = hashBytes(toBytes(exactMarkedContent.content));
  const markerId = hashText(`${writtenFile.targetRelativePath}:${markerHash}`);
  if (writtenFile.sourceType !== 'patch' && isNdfPath(writtenFile.targetRelativePath)) {
    await validateNdfPersistentlyMemoized(
      exactMarkedContent.content,
      writtenFile.targetRelativePath,
      path.join(context.buildRoot, BUILDER_CONFIG.cacheDirectoryName),
      yieldController,
    );
  }

  return {
    content: wrapWithMarker(
      exactMarkedContent.content,
      {
        markerId,
        markerHash,
        builderId,
        contributors: writtenFile.contributors,
      },
      writtenFile.targetRelativePath,
    ),
    markerId,
    markerHash,
    ...(exactMarkedContent.warning ? { warning: exactMarkedContent.warning } : {}),
  };
}

async function loadMarkerBaseText(
  context: BuilderContext,
  targetRelativePath: string,
  yieldController?: CooperativeYieldController,
): Promise<string> {
  const targetAbsolutePath = resolveModTargetPath(context.modRoot, targetRelativePath);
  return (await pathExists(targetAbsolutePath))
    ? yieldController
      ? await readTrackedTextCooperative(context, targetAbsolutePath, yieldController)
      : await readTrackedText(context, targetAbsolutePath)
    : '';
}

function formatUnmarkedTargetWarning(
  targetKind: 'preview' | 'sync',
  targetRelativePath: string,
  reason: PreparedMarkedOutput['warning'],
): string {
  const detail =
    reason === 'binary_output'
      ? `Binary output; ${BUILDER_CONFIG.name} cannot embed in-file comment markers.`
      : reason === 'exact_change_budget_exceeded'
        ? `Exact inline markers were skipped because this target exceeded ${BUILDER_CONFIG.name}'s protected diff budget.`
        : `This file type does not support ${BUILDER_CONFIG.name} comment markers.`;
  const fallback =
    reason === 'exact_change_budget_exceeded'
      ? 'Whole-file markers were kept for this target.'
      : targetKind === 'sync'
        ? `Recovery will rely on ${BUILDER_CONFIG.stateDirectoryName} backups for this file.`
        : 'Preview output will not show in-file ownership markers for this file.';
  return `warning marker ${targetKind} -> ${targetRelativePath} (${detail} ${fallback})`;
}

async function cleanupObsoleteTrackedTargets(args: {
  context: BuilderContext;
  manifestEntriesByTarget: Map<string, SyncManifestEntry>;
  writtenFiles: WrittenBuildFile[];
  selection: SelectionInput;
  logs: string[];
  yieldController?: CooperativeYieldController | undefined;
  transaction?: StateTransaction | undefined;
}): Promise<number> {
  const liveTargetPaths = new Set(
    args.writtenFiles.map((file) => toPathKey(file.targetRelativePath)),
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
  reportProgress('Cleaning obsolete live files', undefined, {
    current: 0,
    total: obsoleteEntries.length,
  });
  for (const entry of obsoleteEntries) {
    await args.yieldController?.maybeYield();
    reportProgress(
      'Cleaning obsolete live files',
      abbreviateProgressPath(entry.targetRelativePath),
      {
        current: obsoleteCount + 1,
        total: obsoleteEntries.length,
      },
    );
    args.logs.push(
      `${entry.originalExists ? 'restore obsolete' : 'delete obsolete'} -> ${entry.targetRelativePath}`,
    );
    obsoleteCount += 1;
    if (args.selection.dryRun) {
      continue;
    }

    if (args.transaction) {
      await recordStateTransactionTarget(args.transaction, entry.targetRelativePath);
    }
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

  return obsoleteCount;
}

export { runRecover } from './recovery.ts';
