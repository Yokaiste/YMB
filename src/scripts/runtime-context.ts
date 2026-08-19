import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  BuildScriptApplicationInfo,
  BuildScriptBuilderInfo,
  BuildScriptContext,
  BuildScriptModInfo,
  BuildScriptPatchInfo,
  BuildScriptSelectionInfo,
  BuildScriptTestContext,
} from 'ymb/api';
import { mapConcurrent } from '../async.ts';
import { hashText } from '../hash.ts';
import {
  assertOwnedRelativePath,
  assertRealPathWithinRoot,
  normalizeRelativePath,
  toPathKey,
  writeFileAtomic,
} from '../path-utils.ts';
import { createTemplateVariables } from '../templates.ts';
import type {
  BuilderContext,
  DiscoveredMod,
  DiscoveredPatch,
  ScriptApplication,
  ScriptRuntimePlan,
  SelectionInput,
  WrittenBuildFile,
} from '../types.ts';
import {
  createTargetReaderState,
  type ObservedTargetRead,
  readTargetBinary,
  readTargetText,
  snapshotObservedTargetReads,
} from './target-readers.ts';
import { createScriptTools } from './tools.ts';

export function createScriptExecutionContext(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  outputMap: Map<string, WrittenBuildFile>,
): { context: BuildScriptContext; getObservedTargetReads(): ObservedTargetRead[] } {
  const targetReaderState = createTargetReaderState(plan.selectedReplaceFiles);
  return {
    context: createScriptScopedContext(plan, script, outputMap, targetReaderState),
    getObservedTargetReads: () => snapshotObservedTargetReads(targetReaderState),
  };
}

export function createScriptTestExecutionContext(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  outputMap: Map<string, WrittenBuildFile>,
  testAbsolutePath: string,
): {
  context: BuildScriptTestContext;
  getObservedTargetReads(): ObservedTargetRead[];
  getObservedScriptFileReads(): ObservedScriptFileRead[];
} {
  const targetReaderState = createTargetReaderState(plan.selectedReplaceFiles);
  const observedScriptFileReads = new Map<string, ObservedScriptFileRead>();
  return {
    context: {
      ...createScriptScopedContext(plan, script, outputMap, targetReaderState, {
        ownedTextStore: new Map(),
        modTextStore: new Map(),
        recordScriptFileRead(read) {
          observedScriptFileReads.set(`${read.scope}:${toPathKey(read.relativePath)}`, read);
        },
      }),
      script: toScriptInfo(script),
      testAbsolutePath,
    },
    getObservedTargetReads: () => snapshotObservedTargetReads(targetReaderState),
    getObservedScriptFileReads: () =>
      [...observedScriptFileReads.values()].sort(
        (left, right) =>
          left.scope.localeCompare(right.scope) ||
          left.relativePath.localeCompare(right.relativePath),
      ),
  };
}

export interface ObservedScriptFileRead {
  scope: 'owner' | 'mod';
  relativePath: string;
  exists: boolean;
  contentHash: string;
}

function createScriptScopedContext(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  outputMap: Map<string, WrittenBuildFile>,
  targetReaderState = createTargetReaderState(plan.selectedReplaceFiles),
  overrides: {
    ownedTextStore?: Map<string, string>;
    modTextStore?: Map<string, string>;
    recordScriptFileRead?: ((read: ObservedScriptFileRead) => void) | undefined;
  } = {},
): BuildScriptContext {
  const ownerRoot = script.patch?.absolutePath ?? script.mod.configDirectoryPath;
  const modRoot = script.mod.configDirectoryPath;
  const templateVariables = createTemplateVariables(plan.context, script.mod, script.patch);
  const tools = createScriptTools(plan, script);
  const resolveOwnedPath = (relativePath: string): string =>
    path.join(
      ownerRoot,
      ...assertOwnedRelativePath(
        relativePath,
        ownerRoot,
        script.patch ? 'patch root' : 'source mod config root',
      ).split('/'),
    );
  const resolveModPath = (relativePath: string): string =>
    path.join(
      modRoot,
      ...assertOwnedRelativePath(relativePath, modRoot, 'source mod config root').split('/'),
    );
  const ownedTextHelpers = createTextHelpers(
    resolveOwnedPath,
    ownerRoot,
    'owner',
    overrides.ownedTextStore,
    overrides.recordScriptFileRead,
  );
  const modTextHelpers = createTextHelpers(
    resolveModPath,
    modRoot,
    'mod',
    overrides.modTextStore,
    overrides.recordScriptFileRead,
  );

  return {
    builder: toBuildScriptBuilderInfo(plan.context),
    selection: toBuildScriptSelectionInfo(plan.selection),
    mod: toModInfo(script.mod),
    patch: script.patch ? toPatchInfo(script.patch) : undefined,
    variables: Object.freeze({ ...templateVariables }),
    tools,
    resolvePath: resolveOwnedPath,
    resolveModPath,
    readOwnedTextIfExists: ownedTextHelpers.readTextIfExists,
    writeOwnedTextIfChanged: ownedTextHelpers.writeTextIfChanged,
    readModTextIfExists: modTextHelpers.readTextIfExists,
    writeModTextIfChanged: modTextHelpers.writeTextIfChanged,
    readTarget: async (relativePath: string) =>
      readTargetText(plan, script, outputMap, targetReaderState, relativePath),
    readTargets: async (relativePaths: string[]) =>
      Object.fromEntries(
        await mapConcurrent(
          relativePaths,
          plan.context.builderConfig.settings.scriptTargetReadConcurrency,
          async (relativePath) => [
            relativePath,
            await readTargetText(plan, script, outputMap, targetReaderState, relativePath),
          ],
        ),
      ),
    readBinaryTarget: async (relativePath: string) =>
      readTargetBinary(plan, script, outputMap, targetReaderState, relativePath),
  };
}

export function toBuildScriptBuilderInfo(context: BuilderContext): BuildScriptBuilderInfo {
  return Object.freeze({
    ymbRoot: context.ymbRoot,
    builderConfigPath: context.builderConfigPath,
    modRoot: context.modRoot,
    modsRoot: context.modsRoot,
    gameDataRoot: context.gameDataRoot,
    commonDataRoot: context.commonDataRoot,
    buildRoot: context.buildRoot,
    buildOutputRoot: context.buildOutputRoot,
    buildCacheRoot: context.buildCacheRoot,
    conflictPreviewRoot: context.conflictPreviewRoot,
    stateRoot: context.stateRoot,
    operationLockRoot: context.operationLockRoot,
    stateTransactionRoot: context.stateTransactionRoot,
  });
}

export function toBuildScriptSelectionInfo(selection: SelectionInput): BuildScriptSelectionInfo {
  return Object.freeze({
    scope: selection.scope,
    modFilters: Object.freeze([...selection.modFilters]),
    patchFilters: Object.freeze([...selection.patchFilters]),
    dryRun: selection.dryRun,
    verbose: selection.verbose,
    useCache: selection.useCache !== false,
  });
}

function toModInfo(mod: DiscoveredMod): BuildScriptModInfo {
  return Object.freeze({
    id: mod.config.id,
    name: mod.config.name,
    description: mod.config.description,
    rootPath: mod.absolutePath,
    configPath: mod.configFilePath,
  });
}

function toPatchInfo(patch: DiscoveredPatch): BuildScriptPatchInfo {
  return Object.freeze({
    id: patch.config.id,
    name: patch.config.name,
    description: patch.config.description,
    rootPath: patch.absolutePath,
    configPath: patch.configFilePath,
  });
}

function toScriptInfo(script: ScriptApplication): BuildScriptApplicationInfo {
  return Object.freeze({
    path: script.config.path,
    absolutePath: script.absolutePath,
    testPaths: Object.freeze(script.config.tests.map((test) => test.path)),
  });
}

function createTextHelpers(
  resolveScopedPath: (relativePath: string) => string,
  scopeRoot: string,
  scope: ObservedScriptFileRead['scope'],
  virtualStore?: Map<string, string>,
  recordScriptFileRead?: ((read: ObservedScriptFileRead) => void) | undefined,
): {
  readTextIfExists(relativePath: string): Promise<string>;
  writeTextIfChanged(relativePath: string, content: string): Promise<boolean>;
} {
  const readCurrentText = async (
    absolutePath: string,
  ): Promise<{ exists: boolean; content: string }> => {
    const file = Bun.file(absolutePath);
    const exists = await file.exists();
    return { exists, content: exists ? await file.text() : '' };
  };
  const recordRead = (
    absolutePath: string,
    current: { exists: boolean; content: string },
  ): void => {
    recordScriptFileRead?.({
      scope,
      relativePath: normalizeRelativePath(path.relative(scopeRoot, absolutePath)),
      exists: current.exists,
      contentHash: hashText(current.content),
    });
  };

  return {
    readTextIfExists: async (relativePath: string) => {
      const absolutePath = resolveScopedPath(relativePath);
      const virtualKey = toPathKey(absolutePath);
      if (virtualStore?.has(virtualKey)) {
        return virtualStore.get(virtualKey) ?? '';
      }
      await assertRealPathWithinRoot(absolutePath, scopeRoot, `${scope} script root`);
      const current = await readCurrentText(absolutePath);
      recordRead(absolutePath, current);
      return current.content;
    },
    writeTextIfChanged: async (relativePath: string, content: string) => {
      const absolutePath = resolveScopedPath(relativePath);
      const virtualKey = toPathKey(absolutePath);
      if (virtualStore) {
        if (virtualStore.has(virtualKey)) {
          if (virtualStore.get(virtualKey) === content) return false;
          virtualStore.set(virtualKey, content);
          return true;
        }

        await assertRealPathWithinRoot(absolutePath, scopeRoot, `${scope} script root`);
        const current = await readCurrentText(absolutePath);
        recordRead(absolutePath, current);
        if (current.exists && current.content === content) {
          return false;
        }
        virtualStore.set(virtualKey, content);
        return true;
      }

      await assertRealPathWithinRoot(absolutePath, scopeRoot, `${scope} script root`);
      const current = await readCurrentText(absolutePath);
      if (current.exists && current.content === content) {
        return false;
      }
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFileAtomic(absolutePath, content);
      return true;
    },
  };
}
