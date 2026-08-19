import path from 'node:path';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { ensure } from '../errors.ts';
import { hashBytes } from '../hash.ts';
import { expandPatchTarget } from '../patch/for-each.ts';
import {
  assertRealPathWithinRoot,
  isFile,
  pathExists,
  resolveOwnedFilePath,
  statIfExists,
} from '../path-utils.ts';
import { matchesAnySelectionFilter } from '../selection-filter.ts';
import { readTrackedText } from '../tracked-targets.ts';
import type {
  AuthoredPatchTarget,
  BuildContributor,
  BuilderContext,
  PatchApplication,
  PatchTarget,
  SelectionInput,
} from '../types.ts';
import type { ResolvedPatchContribution } from './types.ts';

const textTemplateExtensions = new Set([
  '.csv',
  '.ini',
  '.json',
  '.md',
  '.ndf',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

export function resolveVariablesInTarget(
  target: AuthoredPatchTarget,
  templateVariables: Record<string, unknown>,
  application: PatchApplication,
): PatchTarget {
  return expandPatchTarget(target, templateVariables, {
    // A `forEach` mistake is a mistake in the patch config, so the error points
    // there rather than at the game file the operations happen to target.
    absolutePath: application.patch.configFilePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
  });
}

export async function readTextOrThrow(
  context: BuilderContext,
  absolutePath: string,
  selected: PatchApplication,
  relativeTarget: string,
): Promise<string> {
  // A folder standing where the file belongs is a different problem from an
  // absent one, and only the absent one is something an `optional` patch may be
  // skipped for. Reporting both as "does not exist" hid that, and told the
  // reader nothing about the folder sitting in the way.
  const stats = await statIfExists(absolutePath);
  ensure(stats !== undefined, 'IoError', {
    absolutePath,
    modId: selected.mod.config.id,
    modName: selected.mod.config.name,
    patchId: selected.patch.config.id,
    reason: `Target file \`${relativeTarget}\` does not exist.`,
    suggestion: 'Fix the target path or add the missing input file before building.',
  });
  ensure(stats.isFile(), 'LayoutError', {
    absolutePath,
    modId: selected.mod.config.id,
    modName: selected.mod.config.name,
    patchId: selected.patch.config.id,
    reason: `Target path \`${relativeTarget}\` is a folder, not a file.`,
    suggestion: 'Point the target at a game file, or remove the folder standing in its place.',
  });

  return await readTrackedText(context, absolutePath);
}

export async function loadOriginalBackupBytes(
  context: BuilderContext,
  targetAbsolutePath: string,
  backupFileName: string | undefined,
  expectedContentHash?: string | undefined,
): Promise<Uint8Array> {
  const originalsRoot = path.join(context.stateRoot, BUILDER_CONFIG.recoveryOriginalsDirectoryName);
  const backupPath =
    backupFileName === undefined
      ? undefined
      : resolveOwnedFilePath(originalsRoot, backupFileName, 'recovery backup');

  if (backupPath) {
    await assertRealPathWithinRoot(backupPath, originalsRoot, 'recovery originals root');
    ensure(await isFile(backupPath), 'RecoveryError', {
      absolutePath: backupPath,
      reason: `Missing original backup for tracked target \`${path.relative(context.modRoot, targetAbsolutePath).replaceAll('\\', '/')}\`.`,
      suggestion: `Restore the missing file in \`${originalsRoot}\` or recover from an external backup before syncing again.`,
    });
    const content = new Uint8Array(await Bun.file(backupPath).arrayBuffer());
    ensure(
      expectedContentHash === undefined || hashBytes(content) === expectedContentHash,
      'RecoveryError',
      {
        absolutePath: backupPath,
        reason: `Original backup for tracked target \`${path.relative(context.modRoot, targetAbsolutePath).replaceAll('\\', '/')}\` is corrupted.`,
        suggestion: `Restore the backup from a trusted copy before syncing or recovering again.`,
      },
    );
    return content;
  }

  if (await pathExists(targetAbsolutePath)) {
    return new Uint8Array(await Bun.file(targetAbsolutePath).arrayBuffer());
  }

  return new Uint8Array(0);
}

export function isTextTemplateFile(filePath: string): boolean {
  return textTemplateExtensions.has(path.extname(filePath).toLowerCase());
}

export function stringifyTemplateContent(content: unknown): string {
  return typeof content === 'string' ? content : String(content ?? '');
}

export function matchesSelection(
  contributor: BuildContributor,
  selection: SelectionInput,
): boolean {
  const modMatches = matchesAnySelectionFilter(
    selection.modFilters,
    contributor.modId,
    contributor.modName,
  );
  const patchMatches =
    selection.patchFilters.length === 0 ||
    (contributor.patchId !== undefined &&
      matchesAnySelectionFilter(selection.patchFilters, contributor.patchId));

  return modMatches && patchMatches;
}

export function requirePatchContribution(
  contribution: ResolvedPatchContribution | undefined,
): ResolvedPatchContribution {
  ensure(contribution, 'ConflictError', {
    absolutePath: '<patch-group>',
    reason: 'Patch contribution group is empty.',
    suggestion:
      'Re-run the command. If the problem persists, inspect how patch targets were grouped for this build.',
  });
  return contribution;
}
