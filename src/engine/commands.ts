import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { type CooperativeYieldController, createCooperativeYieldController } from '../async.ts';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { resolveBuilderContext } from '../config.ts';
import { ensure } from '../errors.ts';
import {
  createBuilderId,
  decorateTextWithExactMarkers,
  loadManifest,
  saveManifest,
  supportsMarkerComments,
  unwrapMarkedContent,
  wrapWithMarker,
} from '../markers.ts';
import { isNdfPath, validateNdf, validateNdfCooperative } from '../patch/ndf.ts';
import {
  assertGameRelativePath,
  pathExists,
  removePathDirectly,
  resolveModTargetPath,
} from '../path-utils.ts';
import { materializeScriptOutputs } from '../scripts/materialize.ts';
import { formatScriptTestLabel } from '../scripts/testing.ts';
import { collectCleanupTargets, removeCleanupTargets } from '../temp-artifacts.ts';
import { createTemplateVariables } from '../templates.ts';
import { readTrackedText, readTrackedTextCooperative } from '../tracked-targets.ts';
import type {
  BuilderContext,
  SelectionInput,
  SyncManifest,
  SyncManifestEntry,
  WrittenBuildFile,
} from '../types.ts';
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
import {
  materializeBuild,
  materializePatchOutputs,
  validateReplaceOutputs,
} from './materialize.ts';
import { preparePlan } from './plan.ts';
import { abbreviateProgressPath, reportProgress } from './progress.ts';
import {
  hashBytes,
  hashText,
  loadOriginalBackupBytes,
  matchesSelection,
  readTextOrThrow,
  resolveVariablesInTarget,
  toBytes,
} from './shared.ts';

export { preparePlan } from './plan.ts';
export { setCommandProgressReporter } from './progress.ts';

export async function runValidate(
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
      const content = await readTextOrThrow(
        plan.context,
        absolutePath,
        selected,
        resolvedTarget.file,
      );
      await validateNdfCooperative(content, absolutePath, yieldController);
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
  const patchFiles = await materializePatchOutputs(plan, materializationMetrics);
  const afterPatchMaterialization = performance.now();
  const scriptFiles = await materializeScriptOutputs(plan, patchFiles, (result) => {
    logs.push(`script test ok -> ${formatScriptTestLabel(result)}`);
    validatedScriptTests += 1;
  });
  for (const writtenFile of scriptFiles) {
    assertGameRelativePath(writtenFile.targetRelativePath, plan.context.modRoot);
    if (typeof writtenFile.content === 'string' && isNdfPath(writtenFile.targetRelativePath)) {
      await validateNdfCooperative(
        writtenFile.content,
        writtenFile.targetRelativePath,
        yieldController,
      );
    }
    logs.push(`script output ok -> ${writtenFile.targetRelativePath}`);
    validatedScriptTargets += 1;
  }

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
        'Run `bun run ymb build` to write a preview.',
        'Run `bun run ymb explain` if the selected patches still look wrong.',
      ],
    },
  );
}

export async function runList(
  builderPath: string | undefined,
  selection: SelectionInput,
): Promise<CommandOutputLines> {
  const startedAt = performance.now();
  reportProgress('Preparing source mod list');
  const plan = await preparePlan(builderPath, selection);
  const logs: string[] = [];

  for (const mod of plan.discoveredMods) {
    logs.push(`mod ${mod.config.id} | ${mod.config.name} | ${mod.config.enabled ? 'on' : 'off'}`);
    for (const patch of mod.patches) {
      logs.push(
        `patch ${patch.config.id} | ${patch.config.name} | ${patch.config.scope} | ${patch.config.enabled ? 'on' : 'off'}`,
      );
    }
  }

  return withOutputMeta(
    withSummary(
      logs,
      createSummaryLines([
        formatCountSummary('found', [
          ['source mod', plan.discoveredMods.length],
          ['patch', plan.discoveredMods.reduce((count, mod) => count + mod.patches.length, 0)],
        ]),
        formatTimingSummary(performance.now() - startedAt, []),
      ]),
    ),
    {
      detailHeading: 'discovered items',
      nextSteps: ['Run `bun run ymb explain` if a patch is missing or unexpectedly included.'],
    },
  );
}

export async function runExplain(
  builderPath: string | undefined,
  selection: SelectionInput,
): Promise<CommandOutputLines> {
  const startedAt = performance.now();
  reportProgress('Explaining selected patches');
  const plan = await preparePlan(builderPath, selection);
  return withOutputMeta(
    withSummary(
      plan.explanations.map(
        (entry) =>
          `${entry.patchId} -> ${entry.included ? 'included' : 'excluded'} | ${entry.reasons.join('; ')}`,
      ),
      createSummaryLines([
        formatCountSummary('explained', [
          ['included', plan.explanations.filter((entry) => entry.included).length],
          ['excluded', plan.explanations.filter((entry) => !entry.included).length],
        ]),
        formatTimingSummary(performance.now() - startedAt, []),
      ]),
    ),
    {
      detailHeading: 'selection reasons',
      nextSteps: [
        'Adjust `--mod`, `--patch`, `--scope`, or `dependsOn` based on the reasons above.',
      ],
    },
  );
}

export async function runDoctor(
  builderPath: string | undefined,
  selection: SelectionInput,
): Promise<CommandOutputLines> {
  const startedAt = performance.now();
  reportProgress('Inspecting builder paths');
  const plan = await preparePlan(builderPath, selection);
  return withOutputMeta(
    withSummary(
      [
        `builder root -> ${plan.context.ymbRoot}`,
        `mod root -> ${plan.context.modRoot}`,
        `source mods -> ${plan.context.modsRoot}`,
        `preview root -> ${plan.context.buildRoot}`,
        `recovery root -> ${plan.context.stateRoot}`,
        `GameData -> ${(await pathExists(plan.context.gameDataRoot)) ? 'found' : 'missing'}`,
        `CommonData -> ${(await pathExists(plan.context.commonDataRoot)) ? 'found' : 'missing'}`,
      ],
      createSummaryLines([
        formatCountSummary('current selection', [
          ['patch', plan.selectedPatches.length],
          ['replace', plan.selectedReplaceFiles.length],
          ['script', plan.selectedScripts.length],
        ]),
        formatTimingSummary(performance.now() - startedAt, []),
      ]),
    ),
    {
      detailHeading: 'paths',
      locations: [
        { label: 'builder', path: plan.context.ymbRoot },
        { label: 'live mod root', path: plan.context.modRoot },
      ],
      nextSteps: ['Run `bun run ymb validate` if these paths look correct.'],
    },
  );
}

export async function runBuild(
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
    logs.push(`script test ok -> ${formatScriptTestLabel(result)}`);
    executedScriptTests += 1;
  });
  const afterMaterialize = performance.now();
  const outputCounts = countWrittenFiles(writtenFiles);
  const builderId = createBuilderId(plan.context.ymbRoot);

  if (!selection.dryRun) {
    reportProgress('Writing preview output files');
    if (await pathExists(buildOutputRoot)) {
      await removePathDirectly(buildOutputRoot, { recursive: true });
    }
    await mkdir(buildOutputRoot, { recursive: true });
  }

  const writeStartedAt = performance.now();
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
    const absoluteOutputPath = path.join(
      buildOutputRoot,
      ...writtenFile.targetRelativePath.split('/'),
    );
    const preparedOutput = await prepareMarkedOutput(
      plan.context,
      writtenFile,
      builderId,
      yieldController,
    );
    if (preparedOutput.warning) {
      logs.push(
        formatUnmarkedTargetWarning(
          'preview',
          writtenFile.targetRelativePath,
          preparedOutput.warning,
        ),
      );
      warningCount += 1;
    }
    logs.push(`${writtenFile.sourceType} -> ${writtenFile.targetRelativePath}`);

    if (!selection.dryRun) {
      await mkdir(path.dirname(absoluteOutputPath), { recursive: true });
      await Bun.write(absoluteOutputPath, preparedOutput.content);
    }
  }

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
        ? ['Run `bun run ymb build` to write the preview files.']
        : [
            'Open the preview folder and inspect the files you changed.',
            'Run `bun run ymb sync --yes` only after the preview looks correct.',
          ],
    },
  );
}

export async function runSync(
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
    logs.push(`script test ok -> ${formatScriptTestLabel(result)}`);
    executedScriptTests += 1;
  });
  const afterMaterialize = performance.now();
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

  if (!selection.dryRun) {
    await mkdir(originalsRoot, { recursive: true });
  }

  reportProgress('Syncing live files', undefined, {
    current: 0,
    total: writtenFiles.length,
  });
  const syncStartedAt = performance.now();
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
    const existingBytes = targetExists
      ? new Uint8Array(await targetFile.arrayBuffer())
      : new Uint8Array(0);
    const existingHash = targetExists ? hashBytes(existingBytes) : undefined;
    const existingText =
      isTextOutput && targetExists ? Buffer.from(existingBytes).toString('utf8') : '';
    const existing = isTextOutput ? unwrapMarkedContent(existingText) : { payload: undefined };

    if (preparedOutput.warning) {
      logs.push(
        formatUnmarkedTargetWarning('sync', writtenFile.targetRelativePath, preparedOutput.warning),
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

    const existingEntry = manifestEntriesByTarget.get(writtenFile.targetRelativePath);
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

    await mkdir(path.dirname(targetAbsolutePath), { recursive: true });
    await Bun.write(path.join(originalsRoot, backupFileName), originalContent);
    await Bun.write(targetAbsolutePath, outputContent);
    manifestEntriesByTarget.set(writtenFile.targetRelativePath, {
      targetRelativePath: writtenFile.targetRelativePath,
      backupFileName,
      originalExists: targetExists,
      contributors: writtenFile.contributors,
    });
  }

  obsoleteCount = await cleanupObsoleteTrackedTargets({
    context: plan.context,
    manifestEntriesByTarget,
    writtenFiles,
    selection,
    logs,
    yieldController,
  });

  if (!selection.dryRun) {
    reportProgress('Saving sync manifest');
    await saveManifest(plan.context.stateRoot, createSortedManifest(manifestEntriesByTarget));
  }

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
            'Run `bun run ymb recover --yes` if you need to roll these tracked files back.',
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
      : decorateTextWithExactMarkers(
          await loadMarkerBaseText(context, writtenFile.targetRelativePath, yieldController),
          writtenFile.content,
          writtenFile.targetRelativePath,
          builderId,
          writtenFile.contributors,
        );
  const markerHash = hashBytes(toBytes(exactMarkedContent.content));
  const markerId = hashText(`${writtenFile.targetRelativePath}:${markerHash}`);
  if (isNdfPath(writtenFile.targetRelativePath)) {
    if (yieldController) {
      await validateNdfCooperative(
        exactMarkedContent.content,
        writtenFile.targetRelativePath,
        yieldController,
      );
    } else {
      validateNdf(exactMarkedContent.content, writtenFile.targetRelativePath);
    }
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
}): Promise<number> {
  const liveTargetPaths = new Set(args.writtenFiles.map((file) => file.targetRelativePath));
  const obsoleteEntries = [...args.manifestEntriesByTarget.values()].filter((entry) => {
    return (
      !liveTargetPaths.has(entry.targetRelativePath) &&
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

    await restoreOrDeleteTrackedTarget({
      context: args.context,
      entry,
      missingBackupReason: `Missing recovery backup for obsolete tracked target \`${entry.targetRelativePath}\`.`,
      missingBackupSuggestion:
        'Restore the missing backup from YMB state, or recover the file before syncing again.',
      requireBackup: entry.originalExists,
    });
    args.manifestEntriesByTarget.delete(entry.targetRelativePath);
  }

  return obsoleteCount;
}

async function restoreOrDeleteTrackedTarget(args: {
  context: BuilderContext;
  entry: SyncManifestEntry;
  missingBackupReason: string;
  missingBackupSuggestion: string;
  requireBackup: boolean;
}): Promise<void> {
  const { context, entry, missingBackupReason, missingBackupSuggestion, requireBackup } = args;
  const targetAbsolutePath = resolveModTargetPath(context.modRoot, entry.targetRelativePath);
  const backupAbsolutePath = path.join(
    context.stateRoot,
    BUILDER_CONFIG.recoveryOriginalsDirectoryName,
    entry.backupFileName,
  );
  const backupFile = Bun.file(backupAbsolutePath);
  if (requireBackup) {
    ensure(await backupFile.exists(), 'RecoveryError', {
      absolutePath: backupAbsolutePath,
      reason: missingBackupReason,
      suggestion: missingBackupSuggestion,
    });
  }
  if (entry.originalExists) {
    await mkdir(path.dirname(targetAbsolutePath), { recursive: true });
    await Bun.write(targetAbsolutePath, new Uint8Array(await backupFile.arrayBuffer()));
  } else {
    await removePathDirectly(targetAbsolutePath);
  }
  await removePathDirectly(backupAbsolutePath);
}

export async function runRecover(
  builderPath: string | undefined,
  selection: SelectionInput,
): Promise<CommandOutputLines> {
  const startedAt = performance.now();
  const yieldController = createCooperativeYieldController();
  reportProgress('Loading recovery manifest');
  const context = await resolveBuilderContext(builderPath);
  const manifest = await loadManifest(context.stateRoot);
  const remainingEntriesByTarget = createManifestEntryMap(manifest);
  const filteredEntries = manifest.entries.filter((entry) => {
    return entry.contributors.some((item) => matchesSelection(item, selection));
  });

  const logs: string[] = [];
  let restoredCount = 0;
  let deletedGeneratedCount = 0;

  reportProgress('Recovering tracked files', undefined, {
    current: 0,
    total: filteredEntries.length,
  });
  for (const [entryIndex, entry] of filteredEntries.entries()) {
    await yieldController.maybeYield();
    logs.push(
      `${entry.originalExists ? 'restore' : 'delete generated'} -> ${entry.targetRelativePath}`,
    );
    if (entry.originalExists) {
      restoredCount += 1;
    } else {
      deletedGeneratedCount += 1;
    }
    if (!selection.dryRun) {
      await restoreOrDeleteTrackedTarget({
        context,
        entry,
        missingBackupReason: `Missing recovery backup for \`${entry.targetRelativePath}\`.`,
        missingBackupSuggestion: `Restore the missing file in \`${BUILDER_CONFIG.rootDirectoryName}/${BUILDER_CONFIG.stateDirectoryName}/${BUILDER_CONFIG.recoveryOriginalsDirectoryName}\` before running recover again.`,
        requireBackup: true,
      });
      remainingEntriesByTarget.delete(entry.targetRelativePath);
    }
    reportProgress('Recovering tracked files', abbreviateProgressPath(entry.targetRelativePath), {
      current: entryIndex + 1,
      total: filteredEntries.length,
    });
  }

  if (!selection.dryRun) {
    reportProgress('Saving recovery manifest');
    await saveManifest(context.stateRoot, createSortedManifest(remainingEntriesByTarget));
  }

  const finishedAt = performance.now();
  return withOutputMeta(
    withSummary(
      logs,
      createSummaryLines([
        formatCountSummary('recover', [
          ['restored', restoredCount],
          ['deleted generated', deletedGeneratedCount],
          ['remaining tracked', remainingEntriesByTarget.size],
        ]),
        formatTimingSummary(finishedAt - startedAt, []),
      ]),
    ),
    {
      detailHeading: 'recovery actions',
      locations: [{ label: 'recovery state', path: context.stateRoot }],
      nextSteps: selection.dryRun
        ? ['Re-run with `--yes` if this recovery plan looks correct.']
        : ['Run `bun run ymb build` if you want to generate a fresh preview after recovery.'],
    },
  );
}

function createManifestEntryMap(
  manifest: SyncManifest,
): Map<SyncManifestEntry['targetRelativePath'], SyncManifestEntry> {
  return new Map(manifest.entries.map((entry) => [entry.targetRelativePath, entry] as const));
}

function createSortedManifest(
  manifestEntriesByTarget: ReadonlyMap<string, SyncManifestEntry>,
): SyncManifest {
  return {
    entries: [...manifestEntriesByTarget.values()].sort((left, right) =>
      left.targetRelativePath.localeCompare(right.targetRelativePath),
    ),
  };
}

export async function runCleanup(
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
          {
            current: targetIndex + 1,
            total,
          },
        );
      },
    });
    for (const [, removal] of removalResults.entries()) {
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
        ? ['Run `bun run ymb build` again if you want to regenerate preview output.']
        : [
            'Use `bun run ymb cleanup --all --yes` only when you also want to remove recovery state.',
          ],
    },
  );
}
