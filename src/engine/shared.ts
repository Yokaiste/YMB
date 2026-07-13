import path from 'node:path';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { ensure } from '../errors.ts';
import { assertRealPathWithinRoot, pathExists, resolveOwnedFilePath } from '../path-utils.ts';
import { matchesAnySelectionFilter } from '../selection-filter.ts';
import { resolveTemplateValue } from '../templates.ts';
import { readTrackedText } from '../tracked-targets.ts';
import type {
  BuildContributor,
  BuilderContext,
  PatchApplication,
  PatchTarget,
  SelectionInput,
} from '../types.ts';

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
  target: PatchTarget,
  templateVariables: Record<string, unknown>,
): PatchTarget {
  return resolveTemplateValue(target, templateVariables) as PatchTarget;
}

export async function readTextOrThrow(
  context: BuilderContext,
  absolutePath: string,
  selected: PatchApplication,
  relativeTarget: string,
): Promise<string> {
  const file = Bun.file(absolutePath);
  ensure(await file.exists(), 'IoError', {
    absolutePath,
    modId: selected.mod.config.id,
    modName: selected.mod.config.name,
    patchId: selected.patch.config.id,
    reason: `Target file \`${relativeTarget}\` does not exist.`,
    suggestion: 'Fix the target path or add the missing input file before building.',
  });

  return await readTrackedText(context, absolutePath);
}

export async function loadOriginalBackupBytes(
  context: BuilderContext,
  targetAbsolutePath: string,
  backupFileName: string | undefined,
): Promise<Uint8Array> {
  const originalsRoot = path.join(context.stateRoot, BUILDER_CONFIG.recoveryOriginalsDirectoryName);
  const backupPath =
    backupFileName === undefined
      ? undefined
      : resolveOwnedFilePath(originalsRoot, backupFileName, 'recovery backup');

  if (backupPath) {
    await assertRealPathWithinRoot(backupPath, originalsRoot, 'recovery originals root');
    ensure(await pathExists(backupPath), 'RecoveryError', {
      absolutePath: backupPath,
      reason: `Missing original backup for tracked target \`${path.relative(context.modRoot, targetAbsolutePath).replaceAll('\\', '/')}\`.`,
      suggestion: `Restore the missing file in \`${BUILDER_CONFIG.rootDirectoryName}/${BUILDER_CONFIG.stateDirectoryName}/${BUILDER_CONFIG.recoveryOriginalsDirectoryName}\` or recover from an external backup before syncing again.`,
    });
    return new Uint8Array(await Bun.file(backupPath).arrayBuffer());
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
