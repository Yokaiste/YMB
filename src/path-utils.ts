import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { BUILDER_CONFIG } from './builder-config.ts';
import { ensure } from './errors.ts';

export function normalizeRelativePath(value: string): string {
  return value.replaceAll('\\', '/');
}

/**
 * Returns a stable comparison key for WARNO paths.
 *
 * WARNO is a Windows game, so two paths that differ only by case address the
 * same file even when YMB happens to run on a case-sensitive CI filesystem.
 */
export function toPathKey(value: string): string {
  return normalizeRelativePath(value).toLowerCase();
}

export function assertOwnedRelativePath(
  targetRelativePath: string,
  ownerRoot: string,
  ownerLabel: string,
): string {
  const normalized = normalizeRelativePath(targetRelativePath);
  const collapsed = path.posix.normalize(normalized);
  const hasWindowsDrivePrefix = /^[A-Za-z]:\//.test(normalized);
  const hasUncPrefix = normalized.startsWith('//');
  ensure(
    !path.posix.isAbsolute(collapsed) &&
      !hasWindowsDrivePrefix &&
      !hasUncPrefix &&
      collapsed !== '..' &&
      !collapsed.startsWith('../') &&
      !collapsed.includes('/../'),
    'LayoutError',
    {
      absolutePath: path.join(ownerRoot, ...normalized.split('/')),
      reason: `Path must stay inside its ${ownerLabel}, received \`${targetRelativePath}\`.`,
      suggestion: `Use a relative path under the ${ownerLabel} without \`..\` segments or an absolute prefix.`,
    },
  );
  return collapsed;
}

export function assertGameRelativePath(targetRelativePath: string, modRoot: string): string {
  const normalized = assertOwnedRelativePath(targetRelativePath, '', 'mod root');
  ensure(
    normalized.startsWith('GameData/') || normalized.startsWith('CommonData/'),
    'LayoutError',
    {
      absolutePath: path.join(modRoot, ...normalized.split('/')),
      reason: `Target path must stay inside GameData or CommonData, received \`${targetRelativePath}\`.`,
      suggestion: 'Use game-relative paths beginning with `GameData/` or `CommonData/`.',
    },
  );
  return normalized;
}

export function resolveModTargetPath(modRoot: string, targetRelativePath: string): string {
  return path.join(modRoot, ...assertGameRelativePath(targetRelativePath, modRoot).split('/'));
}

export function resolveOwnedFilePath(
  ownerRoot: string,
  fileName: string,
  ownerLabel: string,
): string {
  const normalized = assertOwnedRelativePath(fileName, ownerRoot, ownerLabel);
  ensure(!normalized.includes('/'), 'LayoutError', {
    absolutePath: path.join(ownerRoot, ...normalized.split('/')),
    reason: `${ownerLabel} must be a file name, received \`${fileName}\`.`,
    suggestion: 'Remove all directory separators and use a single file name.',
  });
  return path.join(ownerRoot, normalized);
}

export async function assertRealPathWithinRoot(
  absolutePath: string,
  rootAbsolutePath: string,
  ownerLabel: string,
): Promise<void> {
  const resolvedRoot = await resolveExistingRealPath(rootAbsolutePath);
  const [existingAncestor, missingSuffix] = await splitAtExistingAncestor(absolutePath);
  const resolvedTarget = path.join(await realpath(existingAncestor), missingSuffix);
  ensure(
    resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`),
    'LayoutError',
    {
      absolutePath,
      reason: `Path resolves outside its ${ownerLabel} (a symlink or junction points elsewhere).`,
      suggestion: `Remove the symlink or keep the path physically inside the ${ownerLabel}.`,
    },
  );
}

async function resolveExistingRealPath(absolutePath: string): Promise<string> {
  const [existingAncestor, missingSuffix] = await splitAtExistingAncestor(absolutePath);
  return path.join(await realpath(existingAncestor), missingSuffix);
}

async function splitAtExistingAncestor(absolutePath: string): Promise<[string, string]> {
  let current = path.resolve(absolutePath);
  let suffix = '';
  while (!(await pathExists(current))) {
    const parent = path.dirname(current);
    ensure(parent !== current, 'LayoutError', {
      absolutePath,
      reason: 'Could not resolve any existing ancestor for this path.',
      suggestion: 'Make sure the drive or share the path points to actually exists.',
    });
    suffix = suffix === '' ? path.basename(current) : path.join(path.basename(current), suffix);
    current = parent;
  }
  return [current, suffix];
}

export async function writeFileAtomic(
  absolutePath: string,
  content: string | Uint8Array,
): Promise<void> {
  const tempPath = createTemporarySiblingPath(absolutePath);
  try {
    await Bun.write(tempPath, content);
    await rename(tempPath, absolutePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createTemporarySiblingPath(absolutePath: string): string {
  return path.join(
    path.dirname(absolutePath),
    `${BUILDER_CONFIG.tempPrefix}-${process.pid}-${randomUUID()}.tmp`,
  );
}

export async function replaceDirectoryAtomic(
  stagedDirectory: string,
  destinationDirectory: string,
): Promise<void> {
  const previousDirectory = createTemporarySiblingPath(destinationDirectory);
  const destinationExisted = await pathExists(destinationDirectory);
  if (destinationExisted) {
    await rename(destinationDirectory, previousDirectory);
  }

  try {
    await rename(stagedDirectory, destinationDirectory);
  } catch (error) {
    if (destinationExisted) {
      try {
        await rename(previousDirectory, destinationDirectory);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Failed to publish the staged directory and restore ${destinationDirectory}.`,
        );
      }
    }
    throw error;
  }

  if (destinationExisted) {
    await rm(previousDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  return (await statIfExists(filePath)) !== undefined;
}

export async function statIfExists(filePath: string): Promise<Stats | undefined> {
  try {
    return await stat(filePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

export function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

export async function removePathDirectly(
  filePath: string,
  options?: { recursive?: boolean | undefined },
): Promise<void> {
  await rm(filePath, { recursive: options?.recursive ?? false, force: true });
}
