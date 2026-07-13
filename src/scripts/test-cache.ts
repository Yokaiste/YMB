import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { CooperativeYieldController } from '../async.ts';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { hashBytes, hashText } from '../hash.ts';
import { writeFileAtomic } from '../path-utils.ts';
import type {
  ScriptApplication,
  ScriptRuntimePlan,
  ScriptTestResult,
  WrittenBuildFile,
} from '../types.ts';
import { collectScriptDependencySources } from './dependency-hash.ts';
import {
  createTargetReaderState,
  type ObservedTargetRead,
  readTargetBinary,
  readTargetText,
} from './target-readers.ts';

export const SCRIPT_TEST_CACHE_VERSION = 2;
const SCRIPT_TEST_CACHE_DIRECTORY_NAME = 'script-tests';

interface CachedScriptTestRun {
  version: number;
  results: ScriptTestResult[];
  observedTargetReads: ObservedTargetRead[];
}

export async function createScriptTestCacheKey(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  testAbsolutePath: string,
  yieldController?: CooperativeYieldController,
): Promise<string> {
  await yieldController?.maybeYield();
  const rootAbsolutePath = plan.context.ymbRoot;
  const [scriptDependencySources, testDependencySources, modConfigSource, patchConfigSource] =
    await Promise.all([
      loadDependencySources(script.absolutePath, rootAbsolutePath, yieldController),
      loadDependencySources(testAbsolutePath, rootAbsolutePath, yieldController),
      Bun.file(script.mod.absoluteConfigPath).text(),
      script.patch ? Bun.file(script.patch.absoluteConfigPath).text() : Promise.resolve(''),
    ]);
  await yieldController?.maybeYield();
  return hashText(
    JSON.stringify({
      version: SCRIPT_TEST_CACHE_VERSION,
      selection: {
        scope: plan.selection.scope,
        modFilters: plan.selection.modFilters,
        patchFilters: plan.selection.patchFilters,
        dryRun: plan.selection.dryRun,
        useCache: plan.selection.useCache,
      },
      modId: script.mod.config.id,
      patchId: script.patch?.config.id ?? null,
      scriptAbsolutePath: script.absolutePath,
      testAbsolutePath,
      scriptDependencySources,
      testDependencySources,
      modConfigHash: hashText(modConfigSource),
      patchConfigHash: hashText(patchConfigSource),
    }),
  );
}

function loadDependencySources(
  entryAbsolutePath: string,
  rootAbsolutePath: string,
  yieldController?: CooperativeYieldController,
) {
  return collectScriptDependencySources({
    entryAbsolutePaths: [entryAbsolutePath],
    rootAbsolutePath,
    ...(yieldController ? { yieldController } : {}),
  });
}

export async function loadCachedScriptTestRun(args: {
  plan: ScriptRuntimePlan;
  script: ScriptApplication;
  testAbsolutePath: string;
  outputMap: Map<string, WrittenBuildFile>;
  cacheKey: string;
  yieldController?: CooperativeYieldController;
}): Promise<CachedScriptTestRun | undefined> {
  try {
    await args.yieldController?.maybeYield();
    const cacheFile = Bun.file(resolveScriptTestCachePath(args.plan, args.cacheKey));
    if (!(await cacheFile.exists())) {
      return undefined;
    }
    await args.yieldController?.maybeYield();
    const cached = JSON.parse(await cacheFile.text()) as CachedScriptTestRun;
    if (
      cached.version !== SCRIPT_TEST_CACHE_VERSION ||
      !Array.isArray(cached.results) ||
      !Array.isArray(cached.observedTargetReads)
    ) {
      return undefined;
    }
    if (
      !(await observedTargetReadsMatchCurrentState(
        args.plan,
        args.script,
        args.outputMap,
        cached.observedTargetReads,
        args.yieldController,
      ))
    ) {
      return undefined;
    }
    return cached;
  } catch {
    return undefined;
  }
}

export async function saveCachedScriptTestRun(
  plan: ScriptRuntimePlan,
  cacheKey: string,
  run: CachedScriptTestRun,
  yieldController?: CooperativeYieldController,
): Promise<void> {
  try {
    await yieldController?.maybeYield();
    const cachePath = resolveScriptTestCachePath(plan, cacheKey);
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFileAtomic(cachePath, JSON.stringify(run));
  } catch {
    // Script-test cache failures should never block a build.
  }
}

function resolveScriptTestCachePath(plan: ScriptRuntimePlan, cacheKey: string): string {
  return path.join(
    plan.context.buildRoot,
    BUILDER_CONFIG.cacheDirectoryName,
    SCRIPT_TEST_CACHE_DIRECTORY_NAME,
    `${cacheKey}.json`,
  );
}

async function observedTargetReadsMatchCurrentState(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  outputMap: Map<string, WrittenBuildFile>,
  observedTargetReads: ObservedTargetRead[],
  yieldController?: CooperativeYieldController,
): Promise<boolean> {
  const targetReaderState = createTargetReaderState(plan.selectedReplaceFiles);
  for (const observedTargetRead of observedTargetReads) {
    await yieldController?.maybeYield();
    const currentHash =
      observedTargetRead.readKind === 'text'
        ? hashText(
            await readTargetText(
              plan,
              script,
              outputMap,
              targetReaderState,
              observedTargetRead.targetRelativePath,
            ),
          )
        : hashBytes(
            await readTargetBinary(
              plan,
              script,
              outputMap,
              targetReaderState,
              observedTargetRead.targetRelativePath,
            ),
          );
    if (currentHash !== observedTargetRead.contentHash) {
      return false;
    }
  }
  return true;
}
