import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { CooperativeYieldController } from '../async.ts';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { createErrorCollector, ensure, YmbError } from '../errors.ts';
import { loadManifest } from '../markers.ts';
import {
  assertGameRelativePath,
  assertOwnedRelativePath,
  assertRealPathWithinRoot,
  isMissingPathError,
  normalizeRelativePath,
  resolveModTargetPath,
  resolveOwnedFilePath,
  toPathKey,
} from '../path-utils.ts';
import { createTemplateVariables, resolveTemplateValue } from '../templates.ts';
import type {
  BuilderContext,
  FileDeletion,
  FileOperation,
  FileSource,
  PatchApplication,
  PatchNotice,
  ReplaceFile,
  SyncManifestEntry,
} from '../types.ts';

type PlannedFileChange =
  | {
      kind: 'write';
      file: ReplaceFile;
      owner: PatchApplication;
      originalExists: boolean;
    }
  | {
      kind: 'delete';
      deletion: FileDeletion;
      owner: PatchApplication;
      originalExists: true;
    };

interface ExpandedSourceFile {
  absolutePath: string;
  relativePath: string;
  gameRelativePath?: string | undefined;
  contentMode: 'template' | 'exact';
}

export async function collectPatchFileChanges(
  context: BuilderContext,
  selectedPatches: PatchApplication[],
  yieldController?: CooperativeYieldController,
): Promise<{ writes: ReplaceFile[]; deletions: FileDeletion[]; notices: PatchNotice[] }> {
  const notices: PatchNotice[] = [];
  const manifest = await loadManifest(context.stateRoot);
  const manifestByTarget = new Map(
    manifest.entries.map((entry) => [toPathKey(entry.targetRelativePath), entry] as const),
  );
  const originalManifestAncestorKeys = collectOriginalManifestAncestorKeys(manifest.entries);
  const virtualExistence = new Map<string, boolean>();
  const validatedDirectoryAncestors = new Set<string>();
  const changes = new Map<string, PlannedFileChange>();
  // One broken patch must not hide the next one, but inside a patch later
  // operations are allowed to build on earlier ones - so a failure there ends
  // that patch rather than reporting the consequences of its own first cause.
  const failures = createErrorCollector();

  for (const application of selectedPatches) {
    const variables = createTemplateVariables(context, application.mod, application.patch);
    for (const [operationIndex, unresolvedOperation] of application.patch.config.files.entries()) {
      await yieldController?.maybeYield();
      try {
        const operation = resolveFileOperation(unresolvedOperation, variables);
        if (operation.op === 'remove') {
          const targets = await expandRemovalTargets(
            context,
            operation.target,
            manifestByTarget,
            virtualExistence,
            changes,
          );
          assertExpectedFileCount(operation, targets.length, application, operationIndex);
          if (targets.length === 0) {
            notices.push(
              createFileOperationNotice(
                context,
                application,
                operationIndex,
                operation.target,
                `No files at \`${operation.target}\`. There was nothing to remove.`,
                'Delete the operation if the game no longer ships this path, or fix the target if it should still match.',
              ),
            );
            continue;
          }
          for (const targetRelativePath of targets) {
            await applyDeletion(
              context,
              application,
              targetRelativePath,
              manifestByTarget,
              virtualExistence,
              changes,
            );
          }
          continue;
        }

        const sourceFiles = await expandSourceFiles(
          context,
          application,
          operation.source,
          manifestByTarget,
        );
        assertExpectedFileCount(operation, sourceFiles.length, application, operationIndex);
        const sourceIsDirectory =
          sourceFiles.length > 1 || sourceFiles[0]?.relativePath.length !== 0;
        for (const sourceFile of sourceFiles) {
          const targetRelativePath = resolveWriteTarget(
            context,
            operation.destination,
            sourceFile.relativePath,
            sourceIsDirectory,
          );
          await applyWrite(
            context,
            application,
            operation.op,
            sourceFile,
            targetRelativePath,
            variables,
            manifestByTarget,
            originalManifestAncestorKeys,
            validatedDirectoryAncestors,
            virtualExistence,
            changes,
          );
        }
      } catch (error) {
        // The failing operation is only known here, so stamp it on the way out,
        // along with the config file and line it was written on.
        if (error instanceof YmbError && error.context.operationIndex === undefined) {
          error.context.operationIndex = operationIndex;
          error.context.patchConfigPath = application.patch.configFilePath;
          error.context.operationLine =
            application.patch.config.fileOperationLines?.[operationIndex];
        }
        failures.record(error);
        break;
      }
    }
  }

  failures.throwIfFailed();
  const writes: ReplaceFile[] = [];
  const deletions: FileDeletion[] = [];
  for (const change of changes.values()) {
    if (change.kind === 'write') {
      writes.push(change.file);
    } else {
      deletions.push(change.deletion);
    }
  }
  writes.sort((left, right) => left.targetRelativePath.localeCompare(right.targetRelativePath));
  deletions.sort((left, right) => left.targetRelativePath.localeCompare(right.targetRelativePath));
  return { writes, deletions, notices };
}

/**
 * A file operation reporting what it found rather than failing on it. Shares the
 * shape NDF operations use, so one command prints both the same way.
 */
function createFileOperationNotice(
  context: BuilderContext,
  application: PatchApplication,
  operationIndex: number,
  target: string,
  reason: string,
  suggestion: string,
): PatchNotice {
  return {
    absolutePath: resolveModTargetPath(context.modRoot, target),
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    operationIndex,
    patchConfigPath: application.patch.configFilePath,
    operationLine: application.patch.config.fileOperationLines?.[operationIndex],
    reason,
    suggestion,
  };
}

async function applyWrite(
  context: BuilderContext,
  application: PatchApplication,
  operation: 'add' | 'copy' | 'replace',
  source: ExpandedSourceFile,
  targetRelativePath: string,
  templateVariables: Record<string, unknown>,
  manifestByTarget: ReadonlyMap<string, SyncManifestEntry>,
  originalManifestAncestorKeys: ReadonlySet<string>,
  validatedDirectoryAncestors: Set<string>,
  virtualExistence: Map<string, boolean>,
  changes: Map<string, PlannedFileChange>,
): Promise<void> {
  await assertWriteTargetHierarchyIsSafe(
    context,
    application,
    targetRelativePath,
    manifestByTarget,
    originalManifestAncestorKeys,
    validatedDirectoryAncestors,
    changes,
  );
  const { targetKey, previousChange, exists } = await resolvePlannedTargetState(
    context,
    application,
    targetRelativePath,
    manifestByTarget,
    virtualExistence,
    changes,
  );
  if (operation !== 'copy') {
    const expectsExisting = operation === 'replace';
    ensure(exists === expectsExisting, 'ConflictError', {
      absolutePath: resolveModTargetPath(context.modRoot, targetRelativePath),
      modId: application.mod.config.id,
      modName: application.mod.config.name,
      patchId: application.patch.config.id,
      reason: expectsExisting
        ? `File operation \`replace\` requires existing target \`${targetRelativePath}\`.`
        : `File operation \`add\` requires absent target \`${targetRelativePath}\`.`,
      suggestion: expectsExisting
        ? 'Use `add` for a new path, `copy` for either state, or fix the destination path.'
        : 'Use `replace` for an existing path, `copy` for either state, or choose a new destination.',
    });
  }

  const file: ReplaceFile = {
    sourceAbsolutePath: source.absolutePath,
    targetRelativePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    priority: application.mod.config.priority,
    allowWriteToModifiedFiles: application.mod.config.allowWriteToModifiedFiles,
    templateVariables,
    sourceType: 'file',
    contentMode: source.contentMode,
    patchId: application.patch.config.id,
    sourceGameRelativePath: source.gameRelativePath,
  };
  virtualExistence.set(targetKey, true);
  changes.set(targetKey, {
    kind: 'write',
    file,
    owner: application,
    originalExists: previousChange?.originalExists ?? exists,
  });
}

async function assertWriteTargetHierarchyIsSafe(
  context: BuilderContext,
  application: PatchApplication,
  targetRelativePath: string,
  manifestByTarget: ReadonlyMap<string, SyncManifestEntry>,
  originalManifestAncestorKeys: ReadonlySet<string>,
  validatedDirectoryAncestors: Set<string>,
  changes: ReadonlyMap<string, PlannedFileChange>,
): Promise<void> {
  const targetKey = toPathKey(targetRelativePath);
  ensure(!originalManifestAncestorKeys.has(targetKey), 'LayoutError', {
    absolutePath: resolveModTargetPath(context.modRoot, targetRelativePath),
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    reason: `File-operation destination \`${targetRelativePath}\` conflicts with a descendant file.`,
    suggestion: 'Choose destinations where no file path is also used as a directory.',
  });

  const segments = targetRelativePath.split('/');
  for (let length = 1; length < segments.length; length += 1) {
    const ancestorRelativePath = segments.slice(0, length).join('/');
    if (ancestorRelativePath === 'GameData' || ancestorRelativePath === 'CommonData') {
      continue;
    }
    const ancestorKey = toPathKey(ancestorRelativePath);
    const plannedAncestor = changes.get(ancestorKey);
    const trackedAncestor = manifestByTarget.get(ancestorKey);
    if (
      !plannedAncestor &&
      !trackedAncestor?.originalExists &&
      validatedDirectoryAncestors.has(ancestorKey)
    ) {
      continue;
    }
    const ancestorAbsolutePath = resolveModTargetPath(context.modRoot, ancestorRelativePath);
    const stats = await lstatOrUndefined(ancestorAbsolutePath);
    ensure(
      !plannedAncestor && !trackedAncestor?.originalExists && (!stats || stats.isDirectory()),
      'LayoutError',
      {
        absolutePath: ancestorAbsolutePath,
        modId: application.mod.config.id,
        modName: application.mod.config.name,
        patchId: application.patch.config.id,
        reason: `File-operation destination \`${targetRelativePath}\` has file ancestor \`${ancestorRelativePath}\`.`,
        suggestion: 'Choose a destination whose parent components are directories.',
      },
    );
    validatedDirectoryAncestors.add(ancestorKey);
  }
}

function collectOriginalManifestAncestorKeys(entries: SyncManifestEntry[]): ReadonlySet<string> {
  const ancestors = new Set<string>();
  for (const entry of entries) {
    if (!entry.originalExists) continue;
    const segments = toPathKey(entry.targetRelativePath).split('/');
    for (let length = 1; length < segments.length; length += 1) {
      ancestors.add(segments.slice(0, length).join('/'));
    }
  }
  return ancestors;
}

async function applyDeletion(
  context: BuilderContext,
  application: PatchApplication,
  targetRelativePath: string,
  manifestByTarget: ReadonlyMap<string, SyncManifestEntry>,
  virtualExistence: Map<string, boolean>,
  changes: Map<string, PlannedFileChange>,
): Promise<void> {
  const { targetKey, previousChange, exists } = await resolvePlannedTargetState(
    context,
    application,
    targetRelativePath,
    manifestByTarget,
    virtualExistence,
    changes,
  );
  ensure(exists, 'ConflictError', {
    absolutePath: resolveModTargetPath(context.modRoot, targetRelativePath),
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    reason: `File operation \`remove\` requires existing target \`${targetRelativePath}\`.`,
    suggestion: 'Fix the target path or remove the stale deletion operation.',
  });

  const deletion: FileDeletion = {
    targetRelativePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    priority: application.mod.config.priority,
    allowWriteToModifiedFiles: application.mod.config.allowWriteToModifiedFiles,
  };
  virtualExistence.set(targetKey, false);
  const originalExists = previousChange?.originalExists ?? exists;
  if (!originalExists) {
    changes.delete(targetKey);
    return;
  }
  changes.set(targetKey, { kind: 'delete', deletion, owner: application, originalExists: true });
}

async function expandSourceFiles(
  context: BuilderContext,
  application: PatchApplication,
  source: FileSource,
  manifestByTarget: ReadonlyMap<string, SyncManifestEntry>,
): Promise<ExpandedSourceFile[]> {
  const root = resolveSourceRoot(context, application, source.root);
  const sourceRelativePath =
    source.root === 'game'
      ? assertFileTargetPath(source.path, context.modRoot)
      : assertOwnedRelativePath(source.path, root, `${source.root} source root`);
  const absolutePath = path.join(root, ...sourceRelativePath.split('/'));
  await assertRealPathWithinRoot(absolutePath, root, `${source.root} source root`);
  const stats = await lstatOrUndefined(absolutePath);
  const exactManifestEntry =
    source.root === 'game' ? manifestByTarget.get(toPathKey(sourceRelativePath)) : undefined;
  ensure(exactManifestEntry?.originalExists !== false, 'IoError', {
    absolutePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    reason: `Game source \`${source.path}\` has no original file to copy.`,
    suggestion: 'Copy from a patch/mod source, or choose a game path that existed before sync.',
  });
  const trackedDescendants =
    source.root === 'game'
      ? [...manifestByTarget.values()].filter(
          (entry) =>
            entry.originalExists &&
            toPathKey(entry.targetRelativePath).startsWith(
              `${toPathKey(sourceRelativePath).replace(/\/+$/, '')}/`,
            ),
        )
      : [];
  if (!stats && exactManifestEntry?.originalExists) {
    return [
      {
        absolutePath: resolvePristineGameSourcePath(
          context,
          sourceRelativePath,
          exactManifestEntry,
        ),
        relativePath: '',
        gameRelativePath: sourceRelativePath,
        contentMode: 'exact',
      },
    ];
  }
  if (!stats && trackedDescendants.length > 0) {
    return trackedDescendants
      .map((entry) => ({
        absolutePath: resolvePristineGameSourcePath(context, entry.targetRelativePath, entry),
        relativePath: normalizeRelativePath(
          path.relative(
            absolutePath,
            resolveModTargetPath(context.modRoot, entry.targetRelativePath),
          ),
        ),
        gameRelativePath: entry.targetRelativePath,
        contentMode: 'exact' as const,
      }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }
  ensure(stats, 'IoError', {
    absolutePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    reason: `File operation source \`${source.path}\` does not exist.`,
    suggestion: 'Fix the source path or restore the missing file/directory.',
  });
  ensure(!stats.isSymbolicLink(), 'LayoutError', {
    absolutePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    reason: `File operation source \`${source.path}\` is a symbolic link or junction.`,
    suggestion:
      'Use regular files and directories physically contained by the selected source root.',
  });

  if (stats.isFile()) {
    return [
      {
        absolutePath:
          source.root === 'game'
            ? resolvePristineGameSourcePath(context, sourceRelativePath, exactManifestEntry)
            : absolutePath,
        relativePath: '',
        gameRelativePath: source.root === 'game' ? sourceRelativePath : undefined,
        contentMode: source.root === 'patch' || source.root === 'mod' ? 'template' : 'exact',
      },
    ];
  }
  ensure(stats.isDirectory(), 'LayoutError', {
    absolutePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    reason: `File operation source \`${source.path}\` is not a regular file or directory.`,
    suggestion: 'Use a regular file or directory as the operation source.',
  });

  const filesByPath = new Map<string, string>();
  for (const filePath of await walkRegularFiles(absolutePath, root, application)) {
    const gameRelativePath =
      source.root === 'game'
        ? normalizeRelativePath(path.relative(context.modRoot, filePath))
        : undefined;
    const tracked = gameRelativePath
      ? manifestByTarget.get(toPathKey(gameRelativePath))
      : undefined;
    if (tracked?.originalExists === false) continue;
    filesByPath.set(toPathKey(filePath), filePath);
  }
  if (source.root === 'game') {
    const sourcePrefix = `${toPathKey(sourceRelativePath).replace(/\/+$/, '')}/`;
    for (const entry of manifestByTarget.values()) {
      const entryKey = toPathKey(entry.targetRelativePath);
      if (!entry.originalExists || !entryKey.startsWith(sourcePrefix)) continue;
      const filePath = resolveModTargetPath(context.modRoot, entry.targetRelativePath);
      filesByPath.set(toPathKey(filePath), filePath);
    }
  }
  const files = [...filesByPath.values()].sort((left, right) => left.localeCompare(right));
  ensure(files.length > 0, 'IoError', {
    absolutePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    reason: `File operation source directory \`${source.path}\` contains no files.`,
    suggestion: 'Add source files or remove the empty directory operation.',
  });
  return files.map((filePath) => {
    const relativePath = normalizeRelativePath(path.relative(absolutePath, filePath));
    const gameRelativePath =
      source.root === 'game'
        ? normalizeRelativePath(path.relative(context.modRoot, filePath))
        : undefined;
    const tracked = gameRelativePath
      ? manifestByTarget.get(toPathKey(gameRelativePath))
      : undefined;
    return {
      absolutePath: gameRelativePath
        ? resolvePristineGameSourcePath(context, gameRelativePath, tracked)
        : filePath,
      relativePath,
      gameRelativePath,
      contentMode: source.root === 'patch' || source.root === 'mod' ? 'template' : 'exact',
    };
  });
}

async function resolvePlannedTargetState(
  context: BuilderContext,
  application: PatchApplication,
  targetRelativePath: string,
  manifestByTarget: ReadonlyMap<string, SyncManifestEntry>,
  virtualExistence: Map<string, boolean>,
  changes: ReadonlyMap<string, PlannedFileChange>,
): Promise<{
  targetKey: string;
  previousChange: PlannedFileChange | undefined;
  exists: boolean;
}> {
  const targetKey = toPathKey(targetRelativePath);
  const previousChange = changes.get(targetKey);
  assertLayeringAllowed(previousChange?.owner, application, targetRelativePath);
  return {
    targetKey,
    previousChange,
    exists: await resolveVirtualExistence(
      context,
      targetRelativePath,
      manifestByTarget,
      virtualExistence,
    ),
  };
}

function resolvePristineGameSourcePath(
  context: BuilderContext,
  gameRelativePath: string,
  manifestEntry: SyncManifestEntry | undefined,
): string {
  if (!manifestEntry?.backupFileName) {
    return resolveModTargetPath(context.modRoot, gameRelativePath);
  }
  return resolveOwnedFilePath(
    path.join(context.stateRoot, BUILDER_CONFIG.recoveryOriginalsDirectoryName),
    manifestEntry.backupFileName,
    'recovery backup',
  );
}

async function expandRemovalTargets(
  context: BuilderContext,
  unresolvedTarget: string,
  manifestByTarget: ReadonlyMap<string, SyncManifestEntry>,
  virtualExistence: ReadonlyMap<string, boolean>,
  changes: ReadonlyMap<string, PlannedFileChange>,
): Promise<string[]> {
  const target = assertFileTargetPath(unresolvedTarget, context.modRoot);
  const targetKey = toPathKey(target);
  const exactVirtualState = virtualExistence.get(targetKey);
  const absoluteTarget = resolveModTargetPath(context.modRoot, target);
  const stats = await lstatOrUndefined(absoluteTarget);
  const manifestEntry = manifestByTarget.get(targetKey);

  if (
    exactVirtualState === true ||
    (exactVirtualState === undefined &&
      (manifestEntry?.originalExists === true || (stats?.isFile() ?? false)))
  ) {
    ensure(!stats?.isSymbolicLink(), 'LayoutError', {
      absolutePath: absoluteTarget,
      reason: `File removal target \`${target}\` is a symbolic link or junction.`,
      suggestion: 'Remove links manually and target regular files or directories.',
    });
    return [target];
  }

  const prefix = `${targetKey.replace(/\/+$/, '')}/`;
  const targets = new Map<string, string>();
  if (stats?.isDirectory()) {
    for (const filePath of await walkRegularFiles(absoluteTarget, context.modRoot)) {
      const relativePath = normalizeRelativePath(path.relative(context.modRoot, filePath));
      const key = toPathKey(relativePath);
      const tracked = manifestByTarget.get(key);
      if (tracked?.originalExists === false) continue;
      targets.set(key, relativePath);
    }
  } else if (stats?.isSymbolicLink()) {
    throw new YmbError('LayoutError', {
      absolutePath: absoluteTarget,
      reason: `File removal target \`${target}\` is a symbolic link or junction.`,
      suggestion: 'Remove links manually and target regular files or directories.',
    });
  }

  for (const entry of manifestByTarget.values()) {
    const key = toPathKey(entry.targetRelativePath);
    if (entry.originalExists && key.startsWith(prefix)) {
      targets.set(key, entry.targetRelativePath);
    }
  }
  for (const [key, exists] of virtualExistence) {
    if (!key.startsWith(prefix)) continue;
    const change = changes.get(key);
    if (exists && change) {
      const relativePath =
        change.kind === 'write'
          ? change.file.targetRelativePath
          : change.deletion.targetRelativePath;
      targets.set(key, relativePath);
    } else if (!exists) {
      targets.delete(key);
    }
  }

  // An empty result is not a failure here. The operation asks for these files to
  // be gone, and they are; the caller reports it and moves on.
  return [...targets.values()].sort((left, right) => left.localeCompare(right));
}

async function walkRegularFiles(
  directory: string,
  ownerRoot: string,
  application?: PatchApplication,
): Promise<string[]> {
  const files: string[] = [];
  const pending = [directory];
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    if (!current) break;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      ensure(!entry.isSymbolicLink(), 'LayoutError', {
        absolutePath,
        modId: application?.mod.config.id,
        modName: application?.mod.config.name,
        patchId: application?.patch.config.id,
        reason: 'File operations do not follow symbolic links or junctions.',
        suggestion: 'Use regular files and directories physically contained by the source root.',
      });
      await assertRealPathWithinRoot(absolutePath, ownerRoot, 'file operation root');
      if (entry.isDirectory()) {
        pending.push(absolutePath);
      } else {
        ensure(entry.isFile(), 'LayoutError', {
          absolutePath,
          reason: 'File operation encountered a non-regular filesystem entry.',
          suggestion: 'Remove special filesystem entries from the operated directory.',
        });
        files.push(absolutePath);
      }
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function resolveVirtualExistence(
  context: BuilderContext,
  targetRelativePath: string,
  manifestByTarget: ReadonlyMap<string, SyncManifestEntry>,
  virtualExistence: Map<string, boolean>,
): Promise<boolean> {
  const key = toPathKey(targetRelativePath);
  const cached = virtualExistence.get(key);
  if (cached !== undefined) return cached;
  const manifestEntry = manifestByTarget.get(key);
  const stats = await lstatOrUndefined(resolveModTargetPath(context.modRoot, targetRelativePath));
  ensure(!stats || stats.isFile(), 'LayoutError', {
    absolutePath: resolveModTargetPath(context.modRoot, targetRelativePath),
    reason: `File operation target \`${targetRelativePath}\` is not a regular file path.`,
    suggestion: 'Choose a file destination below GameData or CommonData.',
  });
  const exists = manifestEntry?.originalExists ?? Boolean(stats);
  virtualExistence.set(key, exists);
  return exists;
}

function resolveSourceRoot(
  context: BuilderContext,
  application: PatchApplication,
  root: FileSource['root'],
): string {
  switch (root) {
    case 'patch':
      return application.patch.absolutePath;
    case 'mod':
      return application.mod.configDirectoryPath;
    case 'game':
      return context.modRoot;
    case 'exampleAssets':
      return path.join(path.dirname(context.modRoot), 'ExampleAssets');
  }
}

function resolveWriteTarget(
  context: BuilderContext,
  destination: string,
  sourceRelativePath: string,
  sourceIsDirectory: boolean,
): string {
  const base = assertFileTargetPath(destination, context.modRoot);
  return sourceIsDirectory
    ? assertFileTargetPath(path.posix.join(base, sourceRelativePath), context.modRoot)
    : base;
}

function assertFileTargetPath(value: string, modRoot: string): string {
  return assertGameRelativePath(value, modRoot).replace(/\/+$/, '');
}

function assertExpectedFileCount(
  operation: FileOperation,
  actual: number,
  application: PatchApplication,
  operationIndex: number,
): void {
  if (!operation.expect) return;
  ensure(actual === operation.expect.files, 'ConflictError', {
    absolutePath: application.patch.configFilePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    operationIndex,
    reason: `File operation expected ${operation.expect.files} file(s), but matched ${actual}.`,
    suggestion:
      'Update `expect.files` only after verifying the source or target directory changed as intended.',
  });
}

function resolveFileOperation(
  operation: FileOperation,
  variables: Record<string, unknown>,
): FileOperation {
  if (operation.op === 'remove') {
    return {
      ...operation,
      target: String(resolveTemplateValue(operation.target, variables)),
    };
  }
  return {
    ...operation,
    source: {
      ...operation.source,
      path: String(resolveTemplateValue(operation.source.path, variables)),
    },
    destination: String(resolveTemplateValue(operation.destination, variables)),
  };
}

function assertLayeringAllowed(
  previous: PatchApplication | undefined,
  current: PatchApplication,
  targetRelativePath: string,
): void {
  if (!previous || isSamePatch(previous, current)) return;
  if (canLayer(previous, current)) return;
  throw new YmbError('ConflictError', {
    absolutePath: current.patch.configFilePath,
    modId: current.mod.config.id,
    modName: current.mod.config.name,
    patchId: current.patch.config.id,
    reason: `Multiple file-operation owners target \`${targetRelativePath}\`.`,
    suggestion:
      'Keep the operations in one patch, add an explicit patch dependency, or configure deliberate ordered mod layering.',
    details: [
      `Existing owner: ${previous.mod.config.id}:${previous.patch.config.id}`,
      `New owner: ${current.mod.config.id}:${current.patch.config.id}`,
    ],
  });
}

function isSamePatch(left: PatchApplication, right: PatchApplication): boolean {
  return (
    left.mod.config.id === right.mod.config.id && left.patch.config.id === right.patch.config.id
  );
}

function canLayer(previous: PatchApplication, current: PatchApplication): boolean {
  if (previous.mod.config.id === current.mod.config.id) {
    return current.patch.config.dependsOn.some(
      (dependency) =>
        dependency === previous.patch.config.id ||
        dependency === `${previous.mod.config.id}:${previous.patch.config.id}`,
    );
  }
  return (
    current.mod.config.allowWriteToModifiedFiles &&
    (current.mod.config.priority > previous.mod.config.priority ||
      current.mod.config.dependsOn.includes(previous.mod.config.id))
  );
}

async function lstatOrUndefined(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}
