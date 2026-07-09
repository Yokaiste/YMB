import { realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { BUILDER_CONFIG } from './builder-config.ts';
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
  const tempPath = path.join(
    path.dirname(absolutePath),
    `${BUILDER_CONFIG.tempPrefix}-${path.basename(absolutePath)}.${process.pid}.tmp`,
  );
  await Bun.write(tempPath, content);
  await rename(tempPath, absolutePath);
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
