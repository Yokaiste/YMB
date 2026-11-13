import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { copyFile, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { BUILDER_CONFIG } from './builder-config.ts';
import { ensure } from './errors.ts';

export function normalizeRelativePath(value: string): string {
  return value.replaceAll('\\', '/');
}

/**
 * A path as output should spell it: forward slashes, trimmed to the part a reader
 * has to type back. Every printed path goes through here, or the same file ends up
 * written two ways in one report.
 */
export function toDisplayPath(value: string, baseDirectory?: string): string {
  const normalized = normalizeRelativePath(value);
  if (!baseDirectory) {
    return normalized;
  }
  const base = `${normalizeRelativePath(baseDirectory).replace(/\/+$/, '')}/`;
  return normalized.startsWith(base) ? normalized.slice(base.length) : normalized;
}

/** The tail of a path, for a progress line that has one line to spend on it. */
export function abbreviateDisplayPath(value: string, maxSegments = 3): string {
  const normalized = normalizeRelativePath(value);
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  return segments.length <= maxSegments
    ? normalized
    : `.../${segments.slice(-maxSegments).join('/')}`;
}

/**
 * WARNO is a Windows game, so two paths differing only by case address the same file
 * even when YMB runs on a case-sensitive filesystem.
 */
export function toPathKey(value: string): string {
  return path.posix.normalize(normalizeRelativePath(value)).replace(/\/$/, '').toLowerCase();
}

/** True when `candidatePath` is a proper descendant of `rootPath`. */
export function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return (
    relativePath.length > 0 &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

/** True when both paths are equal or `candidatePath` is below `rootPath`. */
export function isPathInsideOrEqual(rootPath: string, candidatePath: string): boolean {
  return path.relative(rootPath, candidatePath) === '' || isPathInside(rootPath, candidatePath);
}

export function pathsOverlap(leftPath: string, rightPath: string): boolean {
  return isPathInsideOrEqual(leftPath, rightPath) || isPathInsideOrEqual(rightPath, leftPath);
}

export function assertOwnedRelativePath(
  targetRelativePath: string,
  ownerRoot: string,
  ownerLabel: string,
): string {
  const normalized = normalizeRelativePath(targetRelativePath);
  // `posix.normalize` resolves every `..` it can and hoists the rest to the
  // front, so a path escapes the root exactly when the result is `..` or starts
  // with `../`. It also collapses a UNC `//server/share` prefix to one leading
  // slash, which the absolute check rejects.
  const collapsed = path.posix.normalize(normalized);
  const escapesOwnerRoot = collapsed === '..' || collapsed.startsWith('../');
  const hasWindowsDrivePrefix = /^[A-Za-z]:/.test(normalized);
  ensure(
    !path.posix.isAbsolute(collapsed) && !hasWindowsDrivePrefix && !escapesOwnerRoot,
    'LayoutError',
    {
      absolutePath: path.join(ownerRoot, ...normalized.split('/')),
      reason: `\`${targetRelativePath}\` points outside the ${ownerLabel}.`,
      suggestion: `Use a path relative to the ${ownerLabel}. Remove the drive prefix or any \`..\` that leads outside it.`,
    },
  );
  // `''` and `'.'` both collapse to the root itself. No caller wants that: it
  // would turn "resolve one file" into "resolve the whole owner directory", and
  // a configured temp path of `.` would hand cleanup the entire root to delete.
  ensure(collapsed !== '.', 'LayoutError', {
    absolutePath: ownerRoot,
    reason: `\`${targetRelativePath}\` names the entire ${ownerLabel}.`,
    suggestion: 'Choose a file or subfolder within it.',
  });
  const unsafeSegment = collapsed.split('/').find(isUnsafeWindowsPathSegment);
  ensure(unsafeSegment === undefined, 'LayoutError', {
    absolutePath: path.join(ownerRoot, ...collapsed.split('/')),
    reason: `Windows cannot use \`${unsafeSegment}\` in \`${targetRelativePath}\`.`,
    suggestion:
      'Rename that part. Avoid reserved names such as CON, characters such as : * ? < > |, and dots or spaces at the end.',
  });
  return collapsed;
}

export function assertGameRelativePath(targetRelativePath: string, modRoot: string): string {
  const normalized = assertOwnedRelativePath(targetRelativePath, '', 'WARNO mod folder');
  ensure(
    (normalized.startsWith('GameData/') && normalized !== 'GameData/') ||
      (normalized.startsWith('CommonData/') && normalized !== 'CommonData/'),
    'LayoutError',
    {
      absolutePath: path.join(modRoot, ...normalized.split('/')),
      reason: `\`${targetRelativePath}\` is outside GameData and CommonData.`,
      suggestion:
        'Start the target path with `GameData/` or `CommonData/`, followed by a file path.',
    },
  );
  return normalized;
}

export function isUnsafeWindowsPathSegment(segment: string): boolean {
  if (
    [...segment].some((character) => character.charCodeAt(0) <= 31) ||
    /[<>:"|?*]/.test(segment) ||
    /[. ]$/.test(segment)
  ) {
    return true;
  }
  const baseName = segment.split('.')[0]?.toUpperCase();
  return (
    baseName === 'CON' ||
    baseName === 'PRN' ||
    baseName === 'AUX' ||
    baseName === 'NUL' ||
    /^COM[1-9]$/.test(baseName ?? '') ||
    /^LPT[1-9]$/.test(baseName ?? '')
  );
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
    reason: `\`${fileName}\` includes folders where ${ownerLabel} needs one file name.`,
    suggestion: 'Remove the folders and slashes. Keep only the file name.',
  });
  return path.join(ownerRoot, normalized);
}

export async function assertRealPathWithinRoot(
  absolutePath: string,
  rootAbsolutePath: string,
  ownerLabel: string,
): Promise<void> {
  const resolvedRoot = await resolveRealPath(rootAbsolutePath);
  const resolvedTarget = await resolveRealPath(absolutePath);
  ensure(isPathInsideOrEqual(resolvedRoot, resolvedTarget), 'LayoutError', {
    absolutePath,
    reason: `This path leads outside the ${ownerLabel}.`,
    suggestion: `Use a real file or folder inside the ${ownerLabel}, or fix the symlink or junction target.`,
  });
}

export async function resolveRealPath(absolutePath: string): Promise<string> {
  const [existingAncestor, missingSuffix] = await splitAtExistingAncestor(absolutePath);
  const resolvedAncestor = await realpath(existingAncestor);
  // Bun on Windows currently spells a drive root as `C:`. That is drive-relative
  // to Node's path helpers, so `path.relative('C:', 'C:\\file')` can resolve from
  // the process's per-drive working directory instead of the filesystem root.
  const normalizedAncestor = /^[A-Za-z]:$/.test(resolvedAncestor)
    ? `${resolvedAncestor}${path.sep}`
    : resolvedAncestor;
  return path.join(normalizedAncestor, missingSuffix);
}

async function splitAtExistingAncestor(absolutePath: string): Promise<[string, string]> {
  let current = path.resolve(absolutePath);
  let suffix = '';
  while (!(await pathExists(current))) {
    const parent = path.dirname(current);
    ensure(parent !== current, 'LayoutError', {
      absolutePath,
      reason: 'This path has no accessible parent folder.',
      suggestion: 'Check the drive letter or reconnect the network share, then try again.',
    });
    suffix = suffix === '' ? path.basename(current) : path.join(path.basename(current), suffix);
    current = parent;
  }
  return [current, suffix];
}

export async function writeFileAtomic(
  absolutePath: string,
  content: string | Uint8Array | Blob,
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

/** Copy a regular file without exposing a partially written destination. */
export async function copyFileAtomic(sourcePath: string, destinationPath: string): Promise<void> {
  const tempPath = createTemporarySiblingPath(destinationPath);
  try {
    await copyFile(sourcePath, tempPath);
    await rename(tempPath, destinationPath);
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

export async function isFile(filePath: string): Promise<boolean> {
  return (await statIfExists(filePath))?.isFile() ?? false;
}

export async function isDirectory(directoryPath: string): Promise<boolean> {
  return (await statIfExists(directoryPath))?.isDirectory() ?? false;
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
