import path from 'node:path';
import type { CooperativeYieldController } from './async.ts';
import { BUILDER_CONFIG } from './builder-config.ts';
import { ensure } from './errors.ts';
import { createBuilderId, unwrapMarkedContent } from './markers.ts';
import { isNdfPath, validateNdf, validateNdfCooperative } from './patch/ndf.ts';
import { pathExists } from './path-utils.ts';
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
  const originalBackupPath = await resolveTrackedOriginalTextPath(
    context,
    absolutePath,
    rawContent,
  );
  if (originalBackupPath) {
    await validateContent(rawContent, absolutePath);
  }
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

  const backupPath = path.join(
    context.stateRoot,
    BUILDER_CONFIG.recoveryOriginalsDirectoryName,
    `${marked.payload.markerId}.ndf`,
  );
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

  validateNdf(content, absolutePath);
}

async function validateTrackedTextContentCooperative(
  content: string,
  absolutePath: string,
  yieldController: CooperativeYieldController,
): Promise<void> {
  if (!isNdfPath(absolutePath)) {
    return;
  }

  await validateNdfCooperative(content, absolutePath, yieldController);
}
