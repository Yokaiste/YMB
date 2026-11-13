import path from 'node:path';
import type { CooperativeYieldController } from './async.ts';
import { BUILDER_CONFIG } from './builder-config.ts';
import { validateNdfMemoized, validateNdfMemoizedCooperative } from './engine/validation-memo.ts';
import { ensure, YmbError } from './errors.ts';
import { hashBytes } from './hash.ts';
import {
  createBuilderId,
  isMarkedContentIntact,
  loadManifest,
  unwrapMarkedContent,
} from './markers.ts';
import { isNdfPath } from './patch/ndf/validate.ts';
import {
  assertRealPathWithinRoot,
  isFile,
  normalizeRelativePath,
  pathExists,
  resolveOwnedFilePath,
  toPathKey,
} from './path-utils.ts';
import type { BuilderContext } from './types.ts';

export async function readTrackedText(
  context: BuilderContext,
  absolutePath: string,
): Promise<string> {
  return await readTrackedTextInternal(context, absolutePath, validateTrackedTextContent);
}

export async function readTrackedTextCooperative(
  context: BuilderContext,
  absolutePath: string,
  yieldController: CooperativeYieldController,
): Promise<string> {
  return await readTrackedTextInternal(context, absolutePath, (content, filePath) =>
    validateTrackedTextContentCooperative(content, filePath, yieldController),
  );
}

/**
 * A file YMB wrote resolves to the saved original and the live text is discarded, so
 * validating it too would walk a tens-of-megabytes NDF again to check what the marker
 * digest already settles. The saved original's checksum is verified before use.
 */
async function readTrackedTextInternal(
  context: BuilderContext,
  absolutePath: string,
  validateContent: (content: string, absolutePath: string) => void | Promise<void>,
): Promise<string> {
  const file = Bun.file(absolutePath);
  const rawContent = (await file.exists()) ? await file.text() : undefined;
  const originalBackup = await resolveTrackedOriginalTextBackup(
    context,
    absolutePath,
    rawContent ?? '',
  );
  const content = originalBackup
    ? Buffer.from(
        await loadOriginalBackupBytes(
          context,
          absolutePath,
          originalBackup.backupFileName,
          originalBackup.originalContentHash,
        ),
      ).toString('utf8')
    : (rawContent ?? (await file.text()));
  await validateContent(content, absolutePath);
  return content;
}

export async function readTrackedBytes(
  context: BuilderContext,
  absolutePath: string,
): Promise<Uint8Array> {
  const entry = await findTrackedEntry(context, absolutePath);
  return loadOriginalBackupBytes(
    context,
    absolutePath,
    entry?.backupFileName,
    entry?.originalContentHash,
  );
}

async function findTrackedEntry(context: BuilderContext, absolutePath: string) {
  const targetKey = toPathKey(path.relative(context.modRoot, absolutePath));
  return (await loadManifest(context.stateRoot)).entries.find(
    (entry) => toPathKey(entry.targetRelativePath) === targetKey,
  );
}

async function resolveTrackedOriginalTextBackup(
  context: BuilderContext,
  absolutePath: string,
  rawContent: string,
): Promise<{ backupFileName: string; originalContentHash?: string | undefined } | undefined> {
  const marked = unwrapMarkedContent(rawContent);
  if (containsBuilderEnvelope(rawContent) && !marked.payload) {
    throw new YmbError('RecoveryError', {
      absolutePath,
      reason: `This file's ${BUILDER_CONFIG.name} tracking markers are damaged.`,
      suggestion:
        'Save any edits you need, then restore a clean original. If YMB still tracks this file, you can instead discard the edits with `recover` and `--reset-changed`.',
    });
  }
  if (!marked.payload || marked.payload.builderId !== createBuilderId(context.ymbRoot)) {
    return findTrackedEntry(context, absolutePath);
  }

  const targetRelativePath = normalizeRelativePath(path.relative(context.modRoot, absolutePath));
  ensure(isMarkedContentIntact(marked, targetRelativePath), 'RecoveryError', {
    absolutePath,
    reason: `This file changed after ${BUILDER_CONFIG.name} wrote it.`,
    suggestion:
      'Save any edits you need, then restore a clean original. To discard the edits during your next `sync` or `recover`, add `--reset-changed`.',
  });

  return (
    (await findTrackedEntry(context, absolutePath)) ?? {
      backupFileName: `${marked.payload.markerId}.ndf`,
    }
  );
}

export async function loadOriginalBackupBytes(
  context: BuilderContext,
  targetAbsolutePath: string,
  backupFileName: string | undefined,
  expectedContentHash?: string | undefined,
): Promise<Uint8Array> {
  const originalsRoot = path.join(context.stateRoot, BUILDER_CONFIG.recoveryOriginalsDirectoryName);
  if (backupFileName !== undefined) {
    const backupPath = resolveOwnedFilePath(originalsRoot, backupFileName, 'recovery backup');
    await assertRealPathWithinRoot(backupPath, originalsRoot, 'recovery originals root');
    ensure(await isFile(backupPath), 'RecoveryError', {
      absolutePath: backupPath,
      reason: `Missing original backup for tracked target \`${normalizeRelativePath(path.relative(context.modRoot, targetAbsolutePath))}\`.`,
      suggestion: `Restore the missing file in \`${originalsRoot}\` or recover from an external backup before syncing again.`,
    });
    const content = await Bun.file(backupPath).bytes();
    ensure(
      expectedContentHash === undefined || hashBytes(content) === expectedContentHash,
      'RecoveryError',
      {
        absolutePath: backupPath,
        reason: `Original backup for tracked target \`${normalizeRelativePath(path.relative(context.modRoot, targetAbsolutePath))}\` is corrupted.`,
        suggestion: 'Restore the backup from a trusted copy before syncing or recovering again.',
      },
    );
    return content;
  }

  return (await pathExists(targetAbsolutePath))
    ? await Bun.file(targetAbsolutePath).bytes()
    : new Uint8Array(0);
}

function containsBuilderEnvelope(content: string): boolean {
  return (
    content.includes(`${BUILDER_CONFIG.name}-START`) ||
    content.includes(`${BUILDER_CONFIG.name}-END`)
  );
}

function validateTrackedTextContent(content: string, absolutePath: string): void {
  if (!isNdfPath(absolutePath)) {
    return;
  }

  validateNdfMemoized(content, absolutePath);
}

async function validateTrackedTextContentCooperative(
  content: string,
  absolutePath: string,
  yieldController: CooperativeYieldController,
): Promise<void> {
  if (!isNdfPath(absolutePath)) {
    return;
  }

  await validateNdfMemoizedCooperative(content, absolutePath, yieldController);
}
