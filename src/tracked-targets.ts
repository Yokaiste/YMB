import path from 'node:path';
import type { CooperativeYieldController } from './async.ts';
import { BUILDER_CONFIG } from './builder-config.ts';
import { validateNdfMemoized, validateNdfMemoizedCooperative } from './engine/validation-memo.ts';
import { ensure } from './errors.ts';
import { createBuilderId, isMarkedContentIntact, unwrapMarkedContent } from './markers.ts';
import { isNdfPath } from './patch/ndf.ts';
import {
  assertRealPathWithinRoot,
  normalizeRelativePath,
  pathExists,
  resolveOwnedFilePath,
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

async function readTrackedTextInternal(
  context: BuilderContext,
  absolutePath: string,
  validateContent: (content: string, absolutePath: string) => void | Promise<void>,
): Promise<string> {
  const rawContent = await Bun.file(absolutePath).text();
  if (containsBuilderEnvelope(rawContent)) {
    await validateContent(rawContent, absolutePath);
  }
  const originalBackupPath = await resolveTrackedOriginalTextPath(
    context,
    absolutePath,
    rawContent,
  );
  const content = originalBackupPath ? await Bun.file(originalBackupPath).text() : rawContent;
  await validateContent(content, originalBackupPath ?? absolutePath);
  return content;
}

async function resolveTrackedOriginalTextPath(
  context: BuilderContext,
  absolutePath: string,
  rawContent: string,
): Promise<string | undefined> {
  const marked = unwrapMarkedContent(rawContent);
  if (containsBuilderEnvelope(rawContent) && !marked.payload) {
    ensure(false, 'RecoveryError', {
      absolutePath,
      reason: `The live tracked file contains malformed ${BUILDER_CONFIG.name} markers.`,
      suggestion:
        'Recover the file through YMB, or restore a clean original before building again.',
    });
  }
  if (!marked.payload || marked.payload.builderId !== createBuilderId(context.ymbRoot)) {
    return undefined;
  }

  const targetRelativePath = normalizeRelativePath(path.relative(context.modRoot, absolutePath));
  ensure(isMarkedContentIntact(marked, targetRelativePath), 'RecoveryError', {
    absolutePath,
    reason: `The live tracked file was changed after ${BUILDER_CONFIG.name} wrote it.`,
    suggestion:
      'Preserve your manual edits elsewhere, then recover or restore the file before building again.',
  });

  const originalsRoot = path.join(context.stateRoot, BUILDER_CONFIG.recoveryOriginalsDirectoryName);
  const backupPath = resolveOwnedFilePath(
    originalsRoot,
    `${marked.payload.markerId}.ndf`,
    'recovery backup',
  );
  await assertRealPathWithinRoot(backupPath, originalsRoot, 'recovery originals root');
  ensure(await pathExists(backupPath), 'RecoveryError', {
    absolutePath: backupPath,
    reason: `Missing tracked original backup for \`${path.relative(context.modRoot, absolutePath).replaceAll('\\', '/')}\`.`,
    suggestion:
      'Restore the missing backup from YMB state, or restore a clean game copy before building again.',
  });
  return backupPath;
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
