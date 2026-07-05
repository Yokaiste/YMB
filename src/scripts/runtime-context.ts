import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { assertOwnedRelativePath } from '../path-utils.ts';
import { createTemplateVariables } from '../templates.ts';
import type {
  BuildScriptContext,
  BuildScriptTestContext,
  ScriptApplication,
  ScriptRuntimePlan,
  WrittenBuildFile,
} from '../types.ts';
import { createTargetReaderState, readTargetBinary, readTargetText } from './target-readers.ts';

export function createScriptContext(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  outputMap: Map<string, WrittenBuildFile>,
): BuildScriptContext {
  return createScriptScopedContext(plan, script, outputMap);
}

export function createScriptTestContext(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  outputMap: Map<string, WrittenBuildFile>,
  testAbsolutePath: string,
): BuildScriptTestContext {
  return {
    ...createScriptScopedContext(plan, script, outputMap, {
      ownedTextStore: new Map(),
      modTextStore: new Map(),
    }),
    script,
    testAbsolutePath,
  };
}

function createScriptScopedContext(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  outputMap: Map<string, WrittenBuildFile>,
  overrides: {
    ownedTextStore?: Map<string, string>;
    modTextStore?: Map<string, string>;
  } = {},
): BuildScriptContext {
  const ownerRoot = script.patch?.absolutePath ?? script.mod.configAbsolutePath;
  const modRoot = script.mod.configAbsolutePath;
  const templateVariables = createTemplateVariables(plan.context, script.mod, script.patch);
  const targetReaderState = createTargetReaderState(plan.selectedReplaceFiles);
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
  const ownedTextHelpers = createTextHelpers(resolveOwnedPath, overrides.ownedTextStore);
  const modTextHelpers = createTextHelpers(resolveModPath, overrides.modTextStore);

  return {
    builder: plan.context,
    selection: plan.selection,
    mod: script.mod,
    patch: script.patch,
    variables: templateVariables,
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

function createTextHelpers(
  resolveScopedPath: (relativePath: string) => string,
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
        if ((virtualStore.get(absolutePath) ?? '') === content) {
          return false;
        }
        virtualStore.set(absolutePath, content);
        return true;
      }
      const file = Bun.file(absolutePath);
      if ((await file.exists()) && (await file.text()) === content) {
        return false;
      }
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await Bun.write(absolutePath, content);
      return true;
    },
  };
}
