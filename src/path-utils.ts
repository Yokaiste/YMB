import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { ensure } from './errors.ts';

export function normalizeRelativePath(value: string): string {
  return value.replaceAll('\\', '/');
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

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function removePathDirectly(
  filePath: string,
  options?: { recursive?: boolean | undefined },
): Promise<void> {
  await rm(filePath, { recursive: options?.recursive ?? false, force: true });
}
