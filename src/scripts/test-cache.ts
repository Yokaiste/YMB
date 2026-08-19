import path from 'node:path';
import type { ScriptTestResult } from 'ymb/api';
import type { CooperativeYieldController } from '../async.ts';
import { getCacheSalt, readCacheEntry, writeCacheEntryAtomic } from '../engine/cache-store.ts';
import { hashBytes, hashText } from '../hash.ts';
import { assertOwnedRelativePath, assertRealPathWithinRoot } from '../path-utils.ts';
import { createTemplateVariables } from '../templates.ts';
import type { ScriptApplication, ScriptRuntimePlan, WrittenBuildFile } from '../types.ts';
import { collectScriptDependencySources } from './dependency-hash.ts';
import {
  type ObservedScriptFileRead,
  toBuildScriptBuilderInfo,
  toBuildScriptSelectionInfo,
} from './runtime-context.ts';
import {
  createTargetReaderState,
  type ObservedTargetRead,
  readTargetBinary,
  readTargetText,
} from './target-readers.ts';

export const SCRIPT_TEST_CACHE_VERSION = 4;
const SCRIPT_TEST_CACHE_DIRECTORY_NAME = 'script-tests';
/** The prune each command runs deletes anything that is not a cache envelope. */
const SCRIPT_TEST_CACHE_KIND = 'script-test';

interface CachedScriptTestRun {
  version: number;
  results: ScriptTestResult[];
  observedTargetReads: ObservedTargetRead[];
  observedScriptFileReads: ObservedScriptFileRead[];
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
      Bun.file(script.mod.configFilePath).text(),
      script.patch ? Bun.file(script.patch.configFilePath).text() : Promise.resolve(''),
    ]);
  await yieldController?.maybeYield();
  return hashText(
    JSON.stringify({
      version: SCRIPT_TEST_CACHE_VERSION,
      // The builder's own sources decide what a test result means, and they are
      // not among the inputs hashed below.
      salt: getCacheSalt(),
      builder: toBuildScriptBuilderInfo(plan.context),
      builderConfig: plan.context.builderConfig,
      selection: toBuildScriptSelectionInfo(plan.selection),
      variables: createTemplateVariables(plan.context, script.mod, script.patch),
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
    const entry = await readCacheEntry(
      resolveScriptTestCachePath(args.plan, args.cacheKey),
      SCRIPT_TEST_CACHE_KIND,
    );
    if (!entry) {
      return undefined;
    }
    await args.yieldController?.maybeYield();
    const cached = parseCachedScriptTestRun(JSON.parse(entry.content));
    if (!cached || cached.version !== SCRIPT_TEST_CACHE_VERSION) {
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
    if (
      !(await observedScriptFileReadsMatchCurrentState(args.script, cached.observedScriptFileReads))
    ) {
      return undefined;
    }
    return cached;
  } catch {
    return undefined;
  }
}

function parseCachedScriptTestRun(value: unknown): CachedScriptTestRun | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.version !== 'number' ||
    !Array.isArray(candidate.results) ||
    !candidate.results.every(isCachedScriptTestResult) ||
    !Array.isArray(candidate.observedTargetReads) ||
    !candidate.observedTargetReads.every(isObservedTargetRead) ||
    !Array.isArray(candidate.observedScriptFileReads) ||
    !candidate.observedScriptFileReads.every(isObservedScriptFileRead)
  ) {
    return undefined;
  }
  return {
    version: candidate.version,
    results: candidate.results,
    observedTargetReads: candidate.observedTargetReads,
    observedScriptFileReads: candidate.observedScriptFileReads,
  };
}

function isObservedScriptFileRead(value: unknown): value is ObservedScriptFileRead {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.scope === 'owner' || candidate.scope === 'mod') &&
    typeof candidate.relativePath === 'string' &&
    typeof candidate.exists === 'boolean' &&
    typeof candidate.contentHash === 'string'
  );
}

function isCachedScriptTestResult(value: unknown): value is ScriptTestResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === 'string' &&
    (candidate.status === 'passed' || candidate.status === 'failed') &&
    (candidate.reason === undefined || typeof candidate.reason === 'string') &&
    (candidate.suggestion === undefined || typeof candidate.suggestion === 'string') &&
    (candidate.details === undefined ||
      (Array.isArray(candidate.details) &&
        candidate.details.every((detail) => typeof detail === 'string')))
  );
}

function isObservedTargetRead(value: unknown): value is ObservedTargetRead {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.targetRelativePath === 'string' &&
    (candidate.readKind === 'text' || candidate.readKind === 'binary') &&
    typeof candidate.contentHash === 'string'
  );
}

export async function saveCachedScriptTestRun(
  plan: ScriptRuntimePlan,
  cacheKey: string,
  run: CachedScriptTestRun,
  yieldController?: CooperativeYieldController,
): Promise<void> {
  await yieldController?.maybeYield();
  // `writeCacheEntryAtomic` creates the folder and swallows its own failures:
  // a cache miss is a slow build, never a broken one.
  await writeCacheEntryAtomic(
    resolveScriptTestCachePath(plan, cacheKey),
    SCRIPT_TEST_CACHE_KIND,
    JSON.stringify(run),
  );
}

function resolveScriptTestCachePath(plan: ScriptRuntimePlan, cacheKey: string): string {
  return path.join(
    plan.context.buildCacheRoot,
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

async function observedScriptFileReadsMatchCurrentState(
  script: ScriptApplication,
  observedReads: ObservedScriptFileRead[],
): Promise<boolean> {
  for (const observedRead of observedReads) {
    const root =
      observedRead.scope === 'owner'
        ? (script.patch?.absolutePath ?? script.mod.configDirectoryPath)
        : script.mod.configDirectoryPath;
    const normalizedPath = assertOwnedRelativePath(
      observedRead.relativePath,
      root,
      `${observedRead.scope} script root`,
    );
    const absolutePath = path.join(root, ...normalizedPath.split('/'));
    await assertRealPathWithinRoot(absolutePath, root, `${observedRead.scope} script root`);
    const file = Bun.file(absolutePath);
    const exists = await file.exists();
    const content = exists ? await file.text() : '';
    if (exists !== observedRead.exists || hashText(content) !== observedRead.contentHash) {
      return false;
    }
  }
  return true;
}
