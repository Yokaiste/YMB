import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { ensure, YmbError } from './errors.ts';
import { hashFile } from './hash.ts';
import {
  assertRealPathWithinRoot,
  copyFileAtomic,
  createTemporarySiblingPath,
  pathExists,
  removePathDirectly,
  replaceDirectoryAtomic,
  resolveModTargetPath,
  toPathKey,
  writeFileAtomic,
} from './path-utils.ts';
import type { BuilderContext } from './types.ts';

const TRANSACTION_VERSION = 1 as const;
const METADATA_FILE_NAME = 'transaction.json';
const STATE_SNAPSHOT_DIRECTORY_NAME = 'state-before';
const TARGET_SNAPSHOT_DIRECTORY_NAME = 'targets-before';

interface StateTransactionTarget {
  targetRelativePath: string;
  existed: boolean;
  snapshotFileName?: string | undefined;
  contentHash?: string | undefined;
}

interface StateTransactionMetadata {
  version: typeof TRANSACTION_VERSION;
  command: 'sync' | 'recover';
  startedAt: string;
  stateExisted: boolean;
  stateSnapshotHash?: string | undefined;
  targets: StateTransactionTarget[];
}

export interface StateTransaction {
  context: BuilderContext;
  root: string;
  metadata: StateTransactionMetadata;
  targetKeys: Set<string>;
}

export async function beginStateTransaction(
  context: BuilderContext,
  command: StateTransactionMetadata['command'],
): Promise<StateTransaction> {
  const root = resolveTransactionRoot(context);
  ensure(!(await pathExists(root)), 'RecoveryError', {
    absolutePath: root,
    reason: 'An unfinished state transaction already exists.',
    suggestion: 'Run any mutating YMB command again so it can recover the interrupted operation.',
  });

  const stagedRoot = createTemporarySiblingPath(root);
  const stateExisted = await pathExists(context.stateRoot);
  const metadata: StateTransactionMetadata = {
    version: TRANSACTION_VERSION,
    command,
    startedAt: new Date().toISOString(),
    stateExisted,
    targets: [],
  };

  try {
    await mkdir(stagedRoot, { recursive: true });
    if (stateExisted) {
      await assertRealPathWithinRoot(
        context.stateRoot,
        context.stateRoot,
        'configured recovery root',
      );
      await cp(context.stateRoot, resolveStateSnapshotRoot(stagedRoot), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      metadata.stateSnapshotHash = await hashDirectoryTree(
        resolveStateSnapshotRoot(stagedRoot),
        stagedRoot,
      );
    }
    await writeTransactionMetadata(stagedRoot, metadata);
    await rename(stagedRoot, root);
  } catch (error) {
    await rm(stagedRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return { context, root, metadata, targetKeys: new Set() };
}

/**
 * A live write must be covered by an open transaction. Only a dry run leaves it
 * unset, and a dry run writes nothing - so reaching here without one means a guard
 * was lost in a refactor. Saying so beats letting `undefined` reach the filesystem.
 */
export function requireStateTransaction(
  transaction: StateTransaction | undefined,
): StateTransaction {
  ensure(transaction, 'RecoveryError', {
    absolutePath: '<state-transaction>',
    reason: 'YMB tried to change a live file without an open state transaction.',
    suggestion:
      'Re-run the command. If it happens again, report it: this is a YMB bug, not a problem with your mod.',
  });
  return transaction;
}

export async function recordStateTransactionTarget(
  transaction: StateTransaction,
  targetRelativePath: string,
): Promise<void> {
  const targetKey = toPathKey(targetRelativePath);
  if (transaction.targetKeys.has(targetKey)) {
    return;
  }

  const targetAbsolutePath = resolveModTargetPath(transaction.context.modRoot, targetRelativePath);
  await assertRealPathWithinRoot(targetAbsolutePath, transaction.context.modRoot, 'mod root');
  const existed = await pathExists(targetAbsolutePath);
  const snapshotFileName = `${createHash('sha256').update(targetKey).digest('hex')}.bin`;
  let contentHash: string | undefined;
  if (existed) {
    const targetStats = await stat(targetAbsolutePath);
    ensure(targetStats.isFile(), 'RecoveryError', {
      absolutePath: targetAbsolutePath,
      reason: 'A live sync target is not a regular file and cannot be transactionally protected.',
      suggestion: 'Replace the directory, link, or special file with the expected WARNO file.',
    });
    const snapshotPath = path.join(
      transaction.root,
      TARGET_SNAPSHOT_DIRECTORY_NAME,
      snapshotFileName,
    );
    await mkdir(path.dirname(snapshotPath), { recursive: true });
    await copyFileAtomic(targetAbsolutePath, snapshotPath);
    contentHash = await hashFile(snapshotPath);
  }

  transaction.metadata.targets.push({
    targetRelativePath,
    existed,
    ...(existed ? { snapshotFileName, contentHash } : {}),
  });
  transaction.targetKeys.add(targetKey);
  await writeTransactionMetadata(transaction.root, transaction.metadata);
}

export async function commitStateTransaction(transaction: StateTransaction): Promise<void> {
  await assertRealPathWithinRoot(
    transaction.root,
    transaction.context.stateTransactionRoot,
    'configured state transaction root',
  );
  const committedRoot = createTemporarySiblingPath(transaction.root);
  await rename(transaction.root, committedRoot);
  await rm(committedRoot, { recursive: true, force: true }).catch(() => undefined);
}

export async function rollbackStateTransaction(transaction: StateTransaction): Promise<void> {
  await validateTransactionSnapshots(transaction);
  for (const target of [...transaction.metadata.targets].reverse()) {
    const targetAbsolutePath = resolveModTargetPath(
      transaction.context.modRoot,
      target.targetRelativePath,
    );
    await assertRealPathWithinRoot(targetAbsolutePath, transaction.context.modRoot, 'mod root');
    if (!target.existed) {
      await removePathDirectly(targetAbsolutePath);
      continue;
    }

    const { path: snapshotPath } = resolveTargetSnapshot(transaction, target);
    await assertRealPathWithinRoot(snapshotPath, transaction.root, 'state transaction root');
    await mkdir(path.dirname(targetAbsolutePath), { recursive: true });
    await copyFileAtomic(snapshotPath, targetAbsolutePath);
  }

  await restoreStateSnapshot(transaction);
  await commitStateTransaction(transaction);
}

export async function recoverPendingStateTransactionOrThrow(
  context: BuilderContext,
): Promise<void> {
  const transaction = await loadPendingStateTransaction(context);
  if (!transaction) {
    return;
  }
  await rollbackStateTransaction(transaction);
  throw new YmbError('RecoveryError', {
    absolutePath: transaction.root,
    reason: `Recovered files and recovery state from interrupted \`${transaction.metadata.command}\` started at ${transaction.metadata.startedAt}.`,
    suggestion: 'Review the restored files, then rerun the command.',
  });
}

export async function loadPendingStateTransaction(
  context: BuilderContext,
): Promise<StateTransaction | undefined> {
  const root = resolveTransactionRoot(context);
  if (!(await pathExists(root))) {
    return undefined;
  }
  try {
    const raw: unknown = JSON.parse(await readFile(resolveMetadataPath(root), 'utf8'));
    const metadata = parseTransactionMetadata(raw, context);
    return {
      context,
      root,
      metadata,
      targetKeys: new Set(metadata.targets.map((target) => toPathKey(target.targetRelativePath))),
    };
  } catch (error) {
    if (error instanceof YmbError) {
      throw error;
    }
    throw new YmbError('RecoveryError', {
      absolutePath: root,
      reason: 'The interrupted state transaction metadata is unreadable or corrupted.',
      suggestion: buildTrustedBackupSuggestion(context),
      details: [error instanceof Error ? error.message : String(error)],
    });
  }
}

async function restoreStateSnapshot(transaction: StateTransaction): Promise<void> {
  await assertRealPathWithinRoot(
    transaction.context.stateRoot,
    transaction.context.stateRoot,
    'configured recovery root',
  );
  if (!transaction.metadata.stateExisted) {
    await removePathDirectly(transaction.context.stateRoot, { recursive: true });
    return;
  }

  const snapshotRoot = resolveStateSnapshotRoot(transaction.root);
  ensure(await pathExists(snapshotRoot), 'RecoveryError', {
    absolutePath: snapshotRoot,
    reason: 'The recovery-state snapshot for an interrupted transaction is missing.',
    suggestion: `Restore \`${transaction.context.stateRoot}\` from a trusted backup before continuing.`,
  });
  await assertRealPathWithinRoot(snapshotRoot, transaction.root, 'state transaction root');
  const stagedStateRoot = createTemporarySiblingPath(transaction.context.stateRoot);
  try {
    await cp(snapshotRoot, stagedStateRoot, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await replaceDirectoryAtomic(stagedStateRoot, transaction.context.stateRoot);
  } catch (error) {
    await rm(stagedStateRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function validateTransactionSnapshots(transaction: StateTransaction): Promise<void> {
  if (transaction.metadata.stateExisted) {
    const stateSnapshotRoot = resolveStateSnapshotRoot(transaction.root);
    ensure(await pathExists(stateSnapshotRoot), 'RecoveryError', {
      absolutePath: stateSnapshotRoot,
      reason: 'The recovery-state snapshot for an interrupted transaction is missing.',
      suggestion: buildTrustedBackupSuggestion(transaction.context, 'before continuing.'),
    });
    const actualStateHash = await hashDirectoryTree(stateSnapshotRoot, transaction.root);
    ensure(actualStateHash === transaction.metadata.stateSnapshotHash, 'RecoveryError', {
      absolutePath: stateSnapshotRoot,
      reason: 'The recovery-state snapshot for an interrupted transaction is corrupted.',
      suggestion: buildTrustedBackupSuggestion(transaction.context, 'before continuing.'),
    });
  }

  for (const target of transaction.metadata.targets) {
    if (!target.existed) {
      continue;
    }
    const snapshotMetadata = resolveTargetSnapshot(transaction, target);
    const snapshotPath = snapshotMetadata.path;
    await assertRealPathWithinRoot(snapshotPath, transaction.root, 'state transaction root');
    const snapshotFile = Bun.file(snapshotPath);
    ensure(await snapshotFile.exists(), 'RecoveryError', {
      absolutePath: snapshotPath,
      reason: `Transaction snapshot for \`${target.targetRelativePath}\` is missing or corrupted.`,
      suggestion: buildTrustedBackupSuggestion(transaction.context),
    });
    ensure((await hashFile(snapshotPath)) === snapshotMetadata.contentHash, 'RecoveryError', {
      absolutePath: snapshotPath,
      reason: `Transaction snapshot for \`${target.targetRelativePath}\` is missing or corrupted.`,
      suggestion: buildTrustedBackupSuggestion(transaction.context),
    });
  }
}

function requireTargetSnapshotMetadata(
  target: StateTransactionTarget,
  transactionRoot: string,
  stateRoot: string,
): { snapshotFileName: string; contentHash: string } {
  ensure(
    target.existed &&
      typeof target.snapshotFileName === 'string' &&
      /^[a-f0-9]{64}\.bin$/.test(target.snapshotFileName) &&
      typeof target.contentHash === 'string' &&
      /^[a-f0-9]{64}$/.test(target.contentHash),
    'RecoveryError',
    {
      absolutePath: transactionRoot,
      reason: `Transaction snapshot metadata for \`${target.targetRelativePath}\` is invalid.`,
      suggestion: buildTrustedBackupSuggestionFromPaths(stateRoot),
    },
  );
  return {
    snapshotFileName: target.snapshotFileName,
    contentHash: target.contentHash,
  };
}

function resolveTargetSnapshot(
  transaction: StateTransaction,
  target: StateTransactionTarget,
): { path: string; contentHash: string } {
  const snapshot = requireTargetSnapshotMetadata(
    target,
    transaction.root,
    transaction.context.stateRoot,
  );
  return {
    path: path.join(transaction.root, TARGET_SNAPSHOT_DIRECTORY_NAME, snapshot.snapshotFileName),
    contentHash: snapshot.contentHash,
  };
}

function parseTransactionMetadata(
  value: unknown,
  context: BuilderContext,
): StateTransactionMetadata {
  ensure(isRecord(value), 'RecoveryError', {
    absolutePath: resolveTransactionRoot(context),
    reason: 'State transaction metadata must be a JSON object.',
    suggestion: buildTrustedBackupSuggestion(context),
  });
  ensure(
    value.version === TRANSACTION_VERSION &&
      (value.command === 'sync' || value.command === 'recover') &&
      typeof value.startedAt === 'string' &&
      Number.isFinite(Date.parse(value.startedAt)) &&
      typeof value.stateExisted === 'boolean' &&
      Array.isArray(value.targets),
    'RecoveryError',
    {
      absolutePath: resolveTransactionRoot(context),
      reason: 'State transaction metadata has an unsupported or incomplete shape.',
      suggestion: buildTrustedBackupSuggestion(context),
    },
  );

  const seenTargets = new Set<string>();
  const targets = value.targets.map((rawTarget, index) => {
    ensure(isRecord(rawTarget), 'RecoveryError', {
      absolutePath: resolveTransactionRoot(context),
      reason: `State transaction target #${index + 1} is invalid.`,
      suggestion: buildTrustedBackupSuggestion(context),
    });
    ensure(
      typeof rawTarget.targetRelativePath === 'string' && typeof rawTarget.existed === 'boolean',
      'RecoveryError',
      {
        absolutePath: resolveTransactionRoot(context),
        reason: `State transaction target #${index + 1} is missing required fields.`,
        suggestion: buildTrustedBackupSuggestion(context),
      },
    );
    resolveModTargetPath(context.modRoot, rawTarget.targetRelativePath);
    const targetKey = toPathKey(rawTarget.targetRelativePath);
    ensure(!seenTargets.has(targetKey), 'RecoveryError', {
      absolutePath: resolveTransactionRoot(context),
      reason: `State transaction contains duplicate target \`${rawTarget.targetRelativePath}\`.`,
      suggestion: buildTrustedBackupSuggestion(context),
    });
    seenTargets.add(targetKey);

    if (!rawTarget.existed) {
      return { targetRelativePath: rawTarget.targetRelativePath, existed: false };
    }
    ensure(
      typeof rawTarget.snapshotFileName === 'string' &&
        /^[a-f0-9]{64}\.bin$/.test(rawTarget.snapshotFileName) &&
        typeof rawTarget.contentHash === 'string' &&
        /^[a-f0-9]{64}$/.test(rawTarget.contentHash),
      'RecoveryError',
      {
        absolutePath: resolveTransactionRoot(context),
        reason: `State transaction snapshot metadata for \`${rawTarget.targetRelativePath}\` is invalid.`,
        suggestion: buildTrustedBackupSuggestion(context),
      },
    );
    return {
      targetRelativePath: rawTarget.targetRelativePath,
      existed: true,
      snapshotFileName: rawTarget.snapshotFileName,
      contentHash: rawTarget.contentHash,
    };
  });

  return {
    version: TRANSACTION_VERSION,
    command: value.command,
    startedAt: value.startedAt,
    stateExisted: value.stateExisted,
    ...(value.stateExisted
      ? {
          stateSnapshotHash: readHash(
            value.stateSnapshotHash,
            context,
            'State transaction recovery snapshot hash is invalid.',
          ),
        }
      : {}),
    targets,
  };
}

function readHash(value: unknown, context: BuilderContext, reason: string): string {
  ensure(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'RecoveryError', {
    absolutePath: resolveTransactionRoot(context),
    reason,
    suggestion: buildTrustedBackupSuggestion(context),
  });
  return value;
}

function writeTransactionMetadata(root: string, metadata: StateTransactionMetadata): Promise<void> {
  return writeFileAtomic(resolveMetadataPath(root), `${JSON.stringify(metadata, null, 2)}\n`);
}

function resolveTransactionRoot(context: BuilderContext): string {
  return context.stateTransactionRoot;
}

function resolveMetadataPath(root: string): string {
  return path.join(root, METADATA_FILE_NAME);
}

function resolveStateSnapshotRoot(root: string): string {
  return path.join(root, STATE_SNAPSHOT_DIRECTORY_NAME);
}

async function hashDirectoryTree(directoryRoot: string, ownerRoot: string): Promise<string> {
  const hash = createHash('sha256');
  const pending = [''];
  for (let index = 0; index < pending.length; index += 1) {
    const relativeDirectory = pending[index];
    if (relativeDirectory === undefined) break;
    const absoluteDirectory = path.join(directoryRoot, relativeDirectory);
    await assertRealPathWithinRoot(absoluteDirectory, ownerRoot, 'state transaction root');
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativeEntry = path.join(relativeDirectory, entry.name).replaceAll('\\', '/');
      const absoluteEntry = path.join(directoryRoot, ...relativeEntry.split('/'));
      if (entry.isDirectory()) {
        hash.update(`D:${relativeEntry}\0`);
        pending.push(relativeEntry);
        continue;
      }
      ensure(entry.isFile(), 'RecoveryError', {
        absolutePath: absoluteEntry,
        reason: 'Recovery state contains a link or special file that cannot be safely snapshotted.',
        suggestion: 'Replace it with regular files and directories before running sync or recover.',
      });
      hash.update(`F:${relativeEntry}\0`);
      hash.update(await hashFile(absoluteEntry));
      hash.update('\0');
    }
  }
  return hash.digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildTrustedBackupSuggestion(context: BuilderContext, suffix = '.'): string {
  return buildTrustedBackupSuggestionFromPaths(context.stateRoot, suffix);
}

function buildTrustedBackupSuggestionFromPaths(stateRoot: string, suffix = '.'): string {
  return `Restore the live files and \`${stateRoot}\` from a trusted backup${suffix}`;
}
