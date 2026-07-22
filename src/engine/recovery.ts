import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createCooperativeYieldController } from '../async.ts';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { resolveBuilderContext } from '../config.ts';
import { ensure } from '../errors.ts';
import { hashBytes } from '../hash.ts';
import { loadManifest, saveManifest } from '../markers.ts';
import { withBuilderOperationLock } from '../operation-lock.ts';
import {
  assertRealPathWithinRoot,
  isMissingPathError,
  pathExists,
  removePathDirectly,
  resolveModTargetPath,
  resolveOwnedFilePath,
  toPathKey,
  writeFileAtomic,
} from '../path-utils.ts';
import {
  beginStateTransaction,
  commitStateTransaction,
  recordStateTransactionTarget,
  rollbackStateTransaction,
  type StateTransaction,
} from '../state-transaction.ts';
import type { BuilderContext, SelectionInput, SyncManifest, SyncManifestEntry } from '../types.ts';
import {
  type CommandOutputLines,
  createSummaryLines,
  formatCountSummary,
  formatTimingSummary,
  withOutputMeta,
  withSummary,
} from './command-output.ts';
import { abbreviateProgressPath, reportProgress } from './progress.ts';
import { matchesSelection } from './shared.ts';

export async function restoreOrDeleteTrackedTarget(args: {
  context: BuilderContext;
  entry: SyncManifestEntry;
  missingBackupReason: string;
  missingBackupSuggestion: string;
  requireBackup: boolean;
}): Promise<void> {
  const { context, entry, missingBackupReason, missingBackupSuggestion, requireBackup } = args;
  const targetAbsolutePath = resolveModTargetPath(context.modRoot, entry.targetRelativePath);
  const originalsRoot = path.join(context.stateRoot, BUILDER_CONFIG.recoveryOriginalsDirectoryName);
  const backupAbsolutePath = resolveOwnedFilePath(
    originalsRoot,
    entry.backupFileName,
    'recovery backup',
  );
  const backupFile = Bun.file(backupAbsolutePath);
  if (requireBackup) {
    ensure(await backupFile.exists(), 'RecoveryError', {
      absolutePath: backupAbsolutePath,
      reason: missingBackupReason,
      suggestion: missingBackupSuggestion,
    });
  }
  await assertRealPathWithinRoot(backupAbsolutePath, originalsRoot, 'recovery originals root');
  await assertRealPathWithinRoot(targetAbsolutePath, context.modRoot, 'mod root');
  const targetExists = await pathExists(targetAbsolutePath);
  const currentHash = targetExists
    ? hashBytes(new Uint8Array(await Bun.file(targetAbsolutePath).arrayBuffer()))
    : undefined;
  assertSyncedTargetIsUnchanged(entry, targetExists, currentHash, targetAbsolutePath);
  if (entry.originalExists) {
    await mkdir(path.dirname(targetAbsolutePath), { recursive: true });
    await writeFileAtomic(targetAbsolutePath, new Uint8Array(await backupFile.arrayBuffer()));
  } else {
    await removePathDirectly(targetAbsolutePath);
  }
  await removePathDirectly(backupAbsolutePath);
}

export async function runRecover(
  builderPath: string | undefined,
  selection: SelectionInput,
): Promise<CommandOutputLines> {
  return withBuilderOperationLock(builderPath, 'recover', () =>
    runRecoverUnlocked(builderPath, selection),
  );
}

async function runRecoverUnlocked(
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
  const transaction = selection.dryRun
    ? undefined
    : await beginStateTransaction(context, 'recover');

  let sweptOrphanCount = 0;
  try {
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
        await recordStateTransactionTarget(
          transaction as StateTransaction,
          entry.targetRelativePath,
        );
        await restoreOrDeleteTrackedTarget({
          context,
          entry,
          missingBackupReason: `Missing recovery backup for \`${entry.targetRelativePath}\`.`,
          missingBackupSuggestion: `Restore the missing file in \`${BUILDER_CONFIG.rootDirectoryName}/${BUILDER_CONFIG.stateDirectoryName}/${BUILDER_CONFIG.recoveryOriginalsDirectoryName}\` before running recover again.`,
          requireBackup: true,
        });
        remainingEntriesByTarget.delete(toPathKey(entry.targetRelativePath));
      }
      reportProgress('Recovering tracked files', abbreviateProgressPath(entry.targetRelativePath), {
        current: entryIndex + 1,
        total: filteredEntries.length,
      });
    }

    if (!selection.dryRun) {
      reportProgress('Saving recovery manifest');
      await saveManifest(context.stateRoot, createSortedManifest(remainingEntriesByTarget));
      sweptOrphanCount = await sweepOrphanedBackups(context, remainingEntriesByTarget, logs);
      await commitStateTransaction(transaction as StateTransaction);
    }
  } catch (error) {
    await rollbackStateTransactionAfterFailure(transaction, error);
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
          ...(sweptOrphanCount > 0
            ? [['orphaned backup swept', sweptOrphanCount] as [string, number]]
            : []),
        ]),
        formatTimingSummary(finishedAt - startedAt, []),
      ]),
    ),
    {
      detailHeading: 'recovery actions',
      locations: [{ label: 'recovery state', path: context.stateRoot }],
      nextSteps: selection.dryRun
        ? ['Re-run with `--yes` if this recovery plan looks correct.']
        : ['Run `build` if you want to generate a fresh preview after recovery.'],
    },
  );
}

export function createManifestEntryMap(
  manifest: SyncManifest,
): Map<SyncManifestEntry['targetRelativePath'], SyncManifestEntry> {
  return new Map(
    manifest.entries.map((entry) => [toPathKey(entry.targetRelativePath), entry] as const),
  );
}

export function assertSyncedTargetIsUnchanged(
  entry: SyncManifestEntry | undefined,
  targetExists: boolean,
  currentHash: string | undefined,
  targetAbsolutePath: string,
): void {
  if (!entry?.syncedContentHash) {
    return;
  }
  if (!targetExists && !entry.originalExists) {
    return;
  }
  ensure(targetExists && currentHash === entry.syncedContentHash, 'RecoveryError', {
    absolutePath: targetAbsolutePath,
    reason: 'A tracked live file was changed or removed after YMB synced it.',
    suggestion:
      'Preserve manual edits elsewhere, then restore the last synced file or recover it before continuing.',
  });
}

export async function sweepOrphanedBackups(
  context: BuilderContext,
  manifestEntriesByTarget: Map<string, SyncManifestEntry>,
  logs: string[],
): Promise<number> {
  const originalsRoot = path.join(context.stateRoot, BUILDER_CONFIG.recoveryOriginalsDirectoryName);
  const referencedBackups = new Set(
    [...manifestEntriesByTarget.values()].map((entry) => entry.backupFileName),
  );

  let sweptCount = 0;
  let backupNames: string[];
  try {
    backupNames = await readdir(originalsRoot);
  } catch (error) {
    if (isMissingPathError(error)) {
      return sweptCount;
    }
    logs.push(`warning could not inspect recovery backups -> ${originalsRoot}`);
    return sweptCount;
  }

  for (const backupName of backupNames) {
    if (referencedBackups.has(backupName)) {
      continue;
    }
    if (!/^[a-f0-9]{64}\.(?:ndf|bin)$/.test(backupName)) {
      logs.push(`unrecognized recovery file preserved -> ${backupName}`);
      continue;
    }
    const backupPath = resolveOwnedFilePath(originalsRoot, backupName, 'recovery backup');
    try {
      await assertRealPathWithinRoot(backupPath, originalsRoot, 'recovery originals root');
      await removePathDirectly(backupPath);
      logs.push(`orphaned backup swept -> ${backupName}`);
      sweptCount += 1;
    } catch {
      logs.push(`warning could not sweep orphaned backup -> ${backupName}`);
    }
  }
  return sweptCount;
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
