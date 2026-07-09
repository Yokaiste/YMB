import { createHash } from 'node:crypto';
import path from 'node:path';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { ensure } from '../errors.ts';
import { pathExists } from '../path-utils.ts';
import { resolveTemplateValue } from '../templates.ts';
import { readTrackedText } from '../tracked-targets.ts';
import type {
  BuildContributor,
  BuilderContext,
  PatchApplication,
  PatchTarget,
  SelectionInput,
} from '../types.ts';

const textEncoder = new TextEncoder();
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

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function loadOriginalBackupBytes(
  context: BuilderContext,
  targetAbsolutePath: string,
  backupFileName: string | undefined,
): Promise<Uint8Array> {
  const backupPath =
    backupFileName === undefined
      ? undefined
      : path.join(context.stateRoot, BUILDER_CONFIG.recoveryOriginalsDirectoryName, backupFileName);

  if (backupPath) {
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

export function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? textEncoder.encode(content) : content;
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
  const modMatches =
    selection.modFilters.length === 0 ||
    selection.modFilters.some(
      (filter) =>
        filter.localeCompare(contributor.modId, undefined, { sensitivity: 'accent' }) === 0 ||
        (contributor.modName !== undefined &&
          filter.localeCompare(contributor.modName, undefined, { sensitivity: 'accent' }) === 0),
    );
  const patchMatches =
    selection.patchFilters.length === 0 ||
    (contributor.patchId !== undefined &&
      selection.patchFilters.some(
        (filter) =>
          filter.localeCompare(contributor.patchId ?? '', undefined, {
            sensitivity: 'accent',
          }) === 0,
      ));

  return modMatches && patchMatches;
}
