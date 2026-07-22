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
} from '../api.ts';
import {
  assertOwnedRelativePath,
  assertRealPathWithinRoot,
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

export function createScriptContext(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  outputMap: Map<string, WrittenBuildFile>,
): BuildScriptContext {
  return createScriptScopedContext(plan, script, outputMap);
}

export function createScriptTestExecutionContext(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  outputMap: Map<string, WrittenBuildFile>,
  testAbsolutePath: string,
): { context: BuildScriptTestContext; getObservedTargetReads(): ObservedTargetRead[] } {
  const targetReaderState = createTargetReaderState(plan.selectedReplaceFiles);
  return {
    context: {
      ...createScriptScopedContext(plan, script, outputMap, targetReaderState, {
        ownedTextStore: new Map(),
        modTextStore: new Map(),
      }),
      script: toScriptInfo(script),
      testAbsolutePath,
    },
    getObservedTargetReads: () => snapshotObservedTargetReads(targetReaderState),
  };
}

function createScriptScopedContext(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  outputMap: Map<string, WrittenBuildFile>,
  targetReaderState = createTargetReaderState(plan.selectedReplaceFiles),
  overrides: {
    ownedTextStore?: Map<string, string>;
    modTextStore?: Map<string, string>;
  } = {},
): BuildScriptContext {
  const ownerRoot = script.patch?.absolutePath ?? script.mod.configAbsolutePath;
  const modRoot = script.mod.configAbsolutePath;
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
  const ownedTextHelpers = createTextHelpers(resolveOwnedPath, ownerRoot, overrides.ownedTextStore);
  const modTextHelpers = createTextHelpers(resolveModPath, modRoot, overrides.modTextStore);

  return {
    builder: toBuilderInfo(plan.context),
    selection: toSelectionInfo(plan.selection),
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
        await Promise.all(
          relativePaths.map(async (relativePath) => [
            relativePath,
            await readTargetText(plan, script, outputMap, targetReaderState, relativePath),
          ]),
        ),
      ),
    readBinaryTarget: async (relativePath: string) =>
      readTargetBinary(plan, script, outputMap, targetReaderState, relativePath),
  };
}

function toBuilderInfo(context: BuilderContext): BuildScriptBuilderInfo {
  return Object.freeze({ ...context });
}

function toSelectionInfo(selection: SelectionInput): BuildScriptSelectionInfo {
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
    configPath: mod.absoluteConfigPath,
  });
}

function toPatchInfo(patch: DiscoveredPatch): BuildScriptPatchInfo {
  return Object.freeze({
    id: patch.config.id,
    name: patch.config.name,
    description: patch.config.description,
    rootPath: patch.absolutePath,
    configPath: patch.absoluteConfigPath,
  });
}

function toScriptInfo(script: ScriptApplication): BuildScriptApplicationInfo {
  return Object.freeze({
    path: script.config.path,
    absolutePath: script.absolutePath,
    testPaths: Object.freeze([...script.config.tests]),
  });
}

function createTextHelpers(
  resolveScopedPath: (relativePath: string) => string,
  scopeRoot: string,
  virtualStore?: Map<string, string>,
): {
  readTextIfExists(relativePath: string): Promise<string>;
  writeTextIfChanged(relativePath: string, content: string): Promise<boolean>;
} {
  return {
    readTextIfExists: async (relativePath: string) => {
      const absolutePath = resolveScopedPath(relativePath);
      if (virtualStore?.has(absolutePath)) {
        return virtualStore.get(absolutePath) ?? '';
      }
      const file = Bun.file(absolutePath);
      return (await file.exists()) ? file.text() : '';
    },
    writeTextIfChanged: async (relativePath: string, content: string) => {
      const absolutePath = resolveScopedPath(relativePath);
      if (virtualStore) {
        if (virtualStore.has(absolutePath) && virtualStore.get(absolutePath) === content) {
          return false;
        }
        virtualStore.set(absolutePath, content);
        return true;
      }
      const file = Bun.file(absolutePath);
      if ((await file.exists()) && (await file.text()) === content) {
        return false;
      }
      await assertRealPathWithinRoot(absolutePath, scopeRoot, 'owner root');
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFileAtomic(absolutePath, content);
      return true;
    },
  };
}
