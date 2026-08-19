import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { type CooperativeYieldController, createCooperativeYieldController } from '../async.ts';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { resolveBuilderContext } from '../config/layout.ts';
import { ensure, YmbError } from '../errors.ts';
import { hashFile } from '../hash.ts';
import { loadManifest, saveManifest } from '../markers.ts';
import { withBuilderOperationLock } from '../operation-lock.ts';
import {
  assertRealPathWithinRoot,
  copyFileAtomic,
  isFile,
  isMissingPathError,
  pathExists,
  removePathDirectly,
  resolveModTargetPath,
  resolveOwnedFilePath,
  toPathKey,
} from '../path-utils.ts';
import { formatDetailLine } from '../report/detail.ts';
import { countFact, timingFact } from '../report/facts.ts';
import {
  formatFindingGroups,
  type ReportFinding,
  toSharedFindings,
  toUnmatchedFilterFinding,
} from '../report/findings.ts';
import { type CommandOutputLines, toCommandOutput } from '../report/output.ts';
import { collectUnmatchedSelectionFilters } from '../selection-filter.ts';
import {
  beginStateTransaction,
  commitStateTransaction,
  recordStateTransactionTarget,
  requireStateTransaction,
  rollbackStateTransaction,
  type StateTransaction,
} from '../state-transaction.ts';
import type { BuilderContext, SelectionInput, SyncManifest, SyncManifestEntry } from '../types.ts';
import { reportProgress, trackProgress } from './progress.ts';
import { matchesSelection } from './shared.ts';

export async function restoreOrDeleteTrackedTarget(args: {
  context: BuilderContext;
  entry: SyncManifestEntry;
  missingBackupReason: string;
  missingBackupSuggestion: string;
  requireBackup: boolean;
  /** Set when the caller is deliberately discarding whatever is on disk. */
  allowChangedTarget?: boolean | undefined;
  dryRun?: boolean | undefined;
}): Promise<void> {
  const {
    context,
    entry,
    missingBackupReason,
    missingBackupSuggestion,
    requireBackup,
    allowChangedTarget,
    dryRun,
  } = args;
  const targetAbsolutePath = resolveModTargetPath(context.modRoot, entry.targetRelativePath);
  const originalsRoot = path.join(context.stateRoot, BUILDER_CONFIG.recoveryOriginalsDirectoryName);
  const backupAbsolutePath = resolveOwnedFilePath(
    originalsRoot,
    entry.backupFileName,
    'recovery backup',
  );
  const backupPathExists = await pathExists(backupAbsolutePath);
  const backupExists = backupPathExists && (await isFile(backupAbsolutePath));
  ensure(!backupPathExists || backupExists, 'RecoveryError', {
    absolutePath: backupAbsolutePath,
    reason: `Recovery backup for \`${entry.targetRelativePath}\` is not a regular file.`,
    suggestion: 'Restore the backup from a trusted copy before recovering again.',
  });
  if (requireBackup) {
    ensure(backupExists, 'RecoveryError', {
      absolutePath: backupAbsolutePath,
      reason: missingBackupReason,
      suggestion: missingBackupSuggestion,
    });
  }
  await assertRealPathWithinRoot(backupAbsolutePath, originalsRoot, 'recovery originals root');
  ensure(
    !backupExists ||
      entry.originalContentHash === undefined ||
      (await hashFile(backupAbsolutePath)) === entry.originalContentHash,
    'RecoveryError',
    {
      absolutePath: backupAbsolutePath,
      reason: `Original backup for \`${entry.targetRelativePath}\` is corrupted.`,
      suggestion: 'Restore the backup from a trusted copy before recovering again.',
    },
  );
  await assertRealPathWithinRoot(targetAbsolutePath, context.modRoot, 'mod root');
  const targetExists = await pathExists(targetAbsolutePath);
  const currentHash = targetExists ? await hashFile(targetAbsolutePath) : undefined;
  if (!allowChangedTarget) {
    assertSyncedTargetIsUnchanged(entry, targetExists, currentHash, targetAbsolutePath);
  }
  if (dryRun) return;
  if (entry.originalExists) {
    await mkdir(path.dirname(targetAbsolutePath), { recursive: true });
    await copyFileAtomic(backupAbsolutePath, targetAbsolutePath);
  } else {
    await removePathDirectly(targetAbsolutePath);
  }
  await removePathDirectly(backupAbsolutePath);
}

export async function assertTrackedBackupsExist(
  context: BuilderContext,
  entries: Iterable<SyncManifestEntry>,
): Promise<void> {
  const originalsRoot = path.join(context.stateRoot, BUILDER_CONFIG.recoveryOriginalsDirectoryName);
  for (const entry of entries) {
    if (!entry.originalExists) continue;
    const backupPath = resolveOwnedFilePath(originalsRoot, entry.backupFileName, 'recovery backup');
    await assertRealPathWithinRoot(backupPath, originalsRoot, 'recovery originals root');
    ensure(await isFile(backupPath), 'RecoveryError', {
      absolutePath: backupPath,
      reason: `Missing original backup for tracked target \`${entry.targetRelativePath}\`.`,
      suggestion: 'Restore the missing backup from a trusted copy before syncing again.',
    });
  }
}

export async function runRecover(
  builderPath: string | undefined,
  selection: SelectionInput,
): Promise<CommandOutputLines> {
  return withBuilderOperationLock(builderPath, 'recover', (context) =>
    runRecoverUnlocked(builderPath, selection, context),
  );
}

async function runRecoverUnlocked(
  builderPath: string | undefined,
  selection: SelectionInput,
  context?: BuilderContext,
): Promise<CommandOutputLines> {
  const startedAt = performance.now();
  const yieldController = createCooperativeYieldController();
  reportProgress('Loading recovery manifest');
  const activeContext = context ?? (await resolveBuilderContext(builderPath));
  const manifest = await loadManifest(activeContext.stateRoot);
  const remainingEntriesByTarget = createManifestEntryMap(manifest);
  const filteredEntries = manifest.entries.filter((entry) => {
    return entry.contributors.some((item) => matchesSelection(item, selection));
  });

  const originalsRoot = path.join(
    activeContext.stateRoot,
    BUILDER_CONFIG.recoveryOriginalsDirectoryName,
  );
  // `recover` never plans: it has to work after the mod that wrote these files
  // is gone. So a filter is checked against who the manifest says contributed,
  // not against what is currently checked out.
  const contributors = manifest.entries.flatMap((entry) => entry.contributors);
  const findings: ReportFinding[] = [
    ...collectUnmatchedSelectionFilters(
      '--mod',
      selection.modFilters,
      contributors.map((item) => ({ id: item.modId, name: item.modName ?? item.modId })),
    ).map(toUnmatchedFilterFinding),
    ...collectUnmatchedSelectionFilters(
      '--patch',
      selection.patchFilters,
      contributors.flatMap((item) =>
        item.patchId === undefined ? [] : [{ id: item.patchId, name: item.patchId }],
      ),
    ).map(toUnmatchedFilterFinding),
  ];
  const logs: string[] = [];
  let restoredCount = 0;
  let deletedGeneratedCount = 0;
  const transaction = selection.dryRun
    ? undefined
    : await beginStateTransaction(activeContext, 'recover');

  let sweptOrphanCount = 0;
  try {
    const progress = trackProgress('Recovering tracked files', filteredEntries.length);
    for (const entry of filteredEntries) {
      await yieldController.maybeYield();
      logs.push(
        formatDetailLine(entry.originalExists ? 'restored' : 'deleted', entry.targetRelativePath),
      );
      if (entry.originalExists) {
        restoredCount += 1;
      } else {
        deletedGeneratedCount += 1;
      }
      if (!selection.dryRun) {
        await recordStateTransactionTarget(
          requireStateTransaction(transaction),
          entry.targetRelativePath,
        );
      }
      await restoreOrDeleteTrackedTarget({
        context: activeContext,
        entry,
        missingBackupReason: `Missing recovery backup for \`${entry.targetRelativePath}\`.`,
        missingBackupSuggestion: `Restore the missing file in \`${originalsRoot}\` before running recover again.`,
        requireBackup: entry.originalExists,
        // Recover exists to put originals back, so the flag simply says the
        // caller accepts losing whatever replaced the file in the meantime.
        allowChangedTarget: selection.resetChanged ?? false,
        dryRun: selection.dryRun,
      });
      if (!selection.dryRun) {
        remainingEntriesByTarget.delete(toPathKey(entry.targetRelativePath));
      }
      progress.step(entry.targetRelativePath);
    }

    if (!selection.dryRun) {
      reportProgress('Saving recovery manifest');
      await saveManifest(activeContext.stateRoot, createSortedManifest(remainingEntriesByTarget));
      const sweep = await sweepOrphanedBackups(activeContext, remainingEntriesByTarget);
      sweptOrphanCount = sweep.sweptCount;
      logs.push(...sweep.lines);
      findings.push(...sweep.findings);
      await commitStateTransaction(requireStateTransaction(transaction));
    }
  } catch (error) {
    await rollbackStateTransactionAfterFailure(transaction, error);
  }

  const finishedAt = performance.now();
  return toCommandOutput([...formatFindingGroups(findings), ...logs], {
    summary: [
      countFact('recover', [
        ['restored file', restoredCount],
        ['deleted generated file', deletedGeneratedCount],
        ['still-tracked file', remainingEntriesByTarget.size],
        ['swept orphan backup', sweptOrphanCount],
      ]),
      timingFact(finishedAt - startedAt, []),
    ],
    detailHeading: 'recovery actions',
    locations: [{ label: 'recovery state', path: activeContext.stateRoot }],
    nextSteps: selection.dryRun
      ? ['Re-run with `--yes` if this recovery plan looks correct.']
      : ['Run `build` if you want to generate a fresh preview after recovery.'],
  });
}

export function createManifestEntryMap(
  manifest: SyncManifest,
): Map<SyncManifestEntry['targetRelativePath'], SyncManifestEntry> {
  return new Map(
    manifest.entries.map((entry) => [toPathKey(entry.targetRelativePath), entry] as const),
  );
}

/**
 * `original` is worth naming separately: WARNO's own pipeline rewrites some
 * declaration files every run, and a file at its untouched bytes needs no rescue.
 * Only `changed` means something YMB cannot account for is there.
 */
type TrackedTargetState = 'synced' | 'original' | 'changed';

export function classifyTrackedTarget(
  entry: SyncManifestEntry | undefined,
  targetExists: boolean,
  currentHash: string | undefined,
): TrackedTargetState {
  if (entry?.expectedState === 'absent') {
    if (!targetExists) {
      return 'synced';
    }
    return currentHash === entry.originalContentHash ? 'original' : 'changed';
  }
  // Nothing recorded to compare against, so there is nothing to protect.
  if (!entry?.syncedContentHash) {
    return 'synced';
  }
  if (!targetExists) {
    return entry.originalExists ? 'changed' : 'original';
  }
  if (currentHash === entry.syncedContentHash) {
    return 'synced';
  }
  return currentHash === entry.originalContentHash ? 'original' : 'changed';
}

export async function readTrackedTargetState(
  context: BuilderContext,
  entry: SyncManifestEntry,
): Promise<TrackedTargetState> {
  const targetAbsolutePath = resolveModTargetPath(context.modRoot, entry.targetRelativePath);
  const targetExists = await pathExists(targetAbsolutePath);
  const currentHash = targetExists ? await hashFile(targetAbsolutePath) : undefined;
  return classifyTrackedTarget(entry, targetExists, currentHash);
}

const RESET_CHANGED_FLAG = '--reset-changed';

const RESET_CHANGED_SUGGESTION =
  `Preserve any edits you want to keep elsewhere, then re-run with \`${RESET_CHANGED_FLAG}\` ` +
  'to put the original back and apply your changes on top of it.';

export function assertSyncedTargetIsUnchanged(
  entry: SyncManifestEntry | undefined,
  targetExists: boolean,
  currentHash: string | undefined,
  targetAbsolutePath: string,
): void {
  ensure(classifyTrackedTarget(entry, targetExists, currentHash) !== 'changed', 'RecoveryError', {
    absolutePath: targetAbsolutePath,
    reason:
      entry?.expectedState === 'absent'
        ? 'A tracked live file was recreated with unexpected content after YMB removed it.'
        : 'A tracked live file was changed or removed after YMB synced it.',
    suggestion: RESET_CHANGED_SUGGESTION,
  });
}

/**
 * Run before materialization: a patch takes its base text from the live file, so an
 * externally overwritten file would be patched in that state.
 */
export async function findChangedTrackedTargets(
  context: BuilderContext,
  entries: Iterable<SyncManifestEntry>,
  selection: SelectionInput,
  yieldController = createCooperativeYieldController(),
): Promise<SyncManifestEntry[]> {
  const changedEntries: SyncManifestEntry[] = [];
  for (const entry of entries) {
    await yieldController.maybeYield();
    if (!entry.contributors.some((item) => matchesSelection(item, selection))) {
      continue;
    }
    if ((await readTrackedTargetState(context, entry)) === 'changed') {
      changedEntries.push(entry);
    }
  }
  return changedEntries;
}

/** How many changed paths the error lists before it stops naming them. */
const LISTED_CHANGED_TARGET_LIMIT = 5;

export function assertChangedTrackedTargetsAreAllowed(
  context: BuilderContext,
  changedEntries: readonly SyncManifestEntry[],
  selection: SelectionInput,
): void {
  const firstEntry = changedEntries[0];
  if (!firstEntry || (selection.resetChanged && !selection.dryRun)) {
    return;
  }

  const listedPaths = changedEntries
    .slice(0, LISTED_CHANGED_TARGET_LIMIT)
    .map((entry) => entry.targetRelativePath);
  const hiddenCount = changedEntries.length - listedPaths.length;
  throw new YmbError('RecoveryError', {
    absolutePath: resolveModTargetPath(context.modRoot, firstEntry.targetRelativePath),
    reason:
      changedEntries.length === 1
        ? 'A tracked live file was changed outside YMB after the last sync.'
        : `${changedEntries.length} tracked live files were changed outside YMB after the last sync.`,
    // A patch reads its base text from the live file, so YMB cannot show what
    // the sync would produce until the original is really back on disk - and a
    // dry run writes nothing. Saying so beats printing a preview built on top of
    // content nobody meant to keep.
    suggestion: selection.dryRun
      ? `Re-run without \`--dry-run\` and with \`${RESET_CHANGED_FLAG}\`: the original has to be back on disk before YMB can show what the sync would produce.`
      : RESET_CHANGED_SUGGESTION,
    details: [
      ...listedPaths,
      ...(hiddenCount > 0 ? [`and ${hiddenCount} more`] : []),
      'A WARNO update or `GenerateMod.bat` rewriting a file it owns looks the same here.',
    ],
  });
}

/** Leaves the run where a fresh sync over an untouched game file would start. */
export async function resetChangedTrackedTargets(args: {
  context: BuilderContext;
  changedEntries: readonly SyncManifestEntry[];
  manifestEntriesByTarget: Map<string, SyncManifestEntry>;
  transaction: StateTransaction | undefined;
  selection: SelectionInput;
  logs: string[];
  yieldController?: CooperativeYieldController | undefined;
}): Promise<number> {
  if (args.changedEntries.length === 0) {
    return 0;
  }

  let resetCount = 0;
  const progress = trackProgress('Resetting changed live files', args.changedEntries.length);
  for (const entry of args.changedEntries) {
    await args.yieldController?.maybeYield();
    progress.step(entry.targetRelativePath);
    args.logs.push(formatDetailLine('reset', entry.targetRelativePath));
    resetCount += 1;
    if (!args.selection.dryRun) {
      await recordStateTransactionTarget(
        requireStateTransaction(args.transaction),
        entry.targetRelativePath,
      );
    }
    await restoreOrDeleteTrackedTarget({
      context: args.context,
      entry,
      missingBackupReason: `Missing original backup for changed tracked target \`${entry.targetRelativePath}\`.`,
      missingBackupSuggestion:
        'Restore the missing backup from YMB state, or put a clean game copy of the file back before syncing again.',
      requireBackup: entry.originalExists,
      allowChangedTarget: true,
      dryRun: args.selection.dryRun,
    });
    args.manifestEntriesByTarget.delete(toPathKey(entry.targetRelativePath));
  }

  return resetCount;
}

/**
 * The routine and notable halves travel apart because they read differently: a swept
 * backup is one aligned line, while what the sweep refused is a list of names
 * sharing one explanation.
 */
interface OrphanSweepResult {
  sweptCount: number;
  lines: string[];
  findings: ReportFinding[];
}

export async function sweepOrphanedBackups(
  context: BuilderContext,
  manifestEntriesByTarget: Map<string, SyncManifestEntry>,
): Promise<OrphanSweepResult> {
  const originalsRoot = path.join(context.stateRoot, BUILDER_CONFIG.recoveryOriginalsDirectoryName);
  const referencedBackups = new Set(
    [...manifestEntriesByTarget.values()].map((entry) => entry.backupFileName),
  );

  const lines: string[] = [];
  const unrecognized: string[] = [];
  const unsweepable: string[] = [];
  let sweptCount = 0;
  let backupNames: string[];
  try {
    backupNames = await readdir(originalsRoot);
  } catch (error) {
    if (isMissingPathError(error)) {
      return { sweptCount, lines, findings: [] };
    }
    return {
      sweptCount,
      lines,
      findings: [
        {
          severity: 'warning',
          label: 'recovery folder',
          subject: originalsRoot,
          detail: 'YMB could not read this folder, so orphaned backups were left in place.',
          suggestion: 'Check the folder is readable, then run `recover` again to clear them.',
        },
      ],
    };
  }

  for (const backupName of backupNames) {
    if (referencedBackups.has(backupName)) {
      continue;
    }
    if (!/^[a-f0-9]{64}\.(?:ndf|bin)$/.test(backupName)) {
      unrecognized.push(backupName);
      continue;
    }
    const backupPath = resolveOwnedFilePath(originalsRoot, backupName, 'recovery backup');
    try {
      await assertRealPathWithinRoot(backupPath, originalsRoot, 'recovery originals root');
      await removePathDirectly(backupPath);
      lines.push(formatDetailLine('swept', backupName));
      sweptCount += 1;
    } catch {
      unsweepable.push(backupName);
    }
  }

  return {
    sweptCount,
    lines,
    findings: [
      ...toSharedFindings(
        {
          severity: 'note',
          label: 'recovery file',
          detail: 'Not something YMB wrote, so the sweep left it alone.',
          suggestion: `Delete it yourself if it does not belong in \`${originalsRoot}\`.`,
        },
        unrecognized,
      ),
      ...toSharedFindings(
        {
          severity: 'warning',
          label: 'orphaned backup',
          detail: 'YMB could not delete this file, so it still takes up space.',
          suggestion: `Remove it by hand from \`${originalsRoot}\`, or run \`recover\` again.`,
        },
        unsweepable,
      ),
    ],
  };
}

export function createSortedManifest(
  manifestEntriesByTarget: ReadonlyMap<string, SyncManifestEntry>,
): SyncManifest {
  return {
    entries: [...manifestEntriesByTarget.values()].sort((left, right) =>
      left.targetRelativePath.localeCompare(right.targetRelativePath),
    ),
  };
}

export async function rollbackStateTransactionAfterFailure(
  transaction: StateTransaction | undefined,
  operationError: unknown,
): Promise<never> {
  if (!transaction) {
    throw operationError;
  }
  try {
    await rollbackStateTransaction(transaction);
  } catch (rollbackError) {
    throw new AggregateError(
      [operationError, rollbackError],
      'The operation failed and YMB could not completely restore its state transaction.',
    );
  }
  throw operationError;
}
