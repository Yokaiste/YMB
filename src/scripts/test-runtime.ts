import path from 'node:path';
import type { BuildScriptTestContext, BuildScriptTestModule, ScriptTestResult } from '../api.ts';
import { ensure, YmbError } from '../errors.ts';
import { resolveRuntimeEntrypoint } from '../runtime-entrypoint.ts';
import type {
  ErrorCategory,
  ErrorContext,
  ScriptApplication,
  ScriptRuntimePlan,
  WrittenBuildFile,
} from '../types.ts';
import { createScriptTestExecutionContext } from './runtime-context.ts';
import { importScriptTestModule } from './runtime-loader.ts';
import {
  awaitIpcChildResult,
  createScriptExecutionError,
  formatUnknownRuntimeError,
} from './runtime-shared.ts';
import { assertScriptTestResultsPassed, normalizeScriptTestReport } from './testing.ts';

const scriptTestRuntimeChildPath = resolveRuntimeEntrypoint(import.meta.url, 'test-runtime-child');

const missingScriptTestSuggestion =
  'Fix the configured test path or add the missing companion test file.';
const scriptTestRuntimeFailureSuggestion =
  'Fix the thrown error in the test or generation script, then run the command again.';

interface ExecutedScriptTestRun {
  context: BuildScriptTestContext;
  results: ScriptTestResult[];
  observedTargetReads: ReturnType<
    ReturnType<typeof createScriptTestExecutionContext>['getObservedTargetReads']
  >;
}

export interface ScriptTestRuntimeRequest {
  plan: ScriptRuntimePlan;
  script: ScriptApplication;
  testAbsolutePath: string;
  outputEntries: Array<readonly [string, WrittenBuildFile]>;
}

interface ScriptTestRuntimeErrorPayload {
  category?: ErrorCategory | undefined;
  context?: ErrorContext | undefined;
  message: string;
}

type ScriptTestRuntimeResponse =
  | {
      ok: true;
      results: ScriptTestResult[];
      observedTargetReads: ExecutedScriptTestRun['observedTargetReads'];
    }
  | {
      ok: false;
      error: ScriptTestRuntimeErrorPayload;
    };

export async function executeScriptTest(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  testAbsolutePath: string,
  outputMap: Map<string, WrittenBuildFile>,
): Promise<ExecutedScriptTestRun> {
  await ensureScriptTestFileExists(script, testAbsolutePath);
  return runScriptTestInSubprocess(plan, script, testAbsolutePath, outputMap);
}

export async function executeScriptTestInProcess(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  testAbsolutePath: string,
  outputMap: Map<string, WrittenBuildFile>,
): Promise<ExecutedScriptTestRun> {
  await ensureScriptTestFileExists(script, testAbsolutePath);
  const importedModule = await importScriptTestModule({
    script,
    testAbsolutePath,
    useCache: plan.selection.useCache !== false,
  });
  const execute = resolveTestExport(script, testAbsolutePath, importedModule);
  const { context, getObservedTargetReads } = createScriptTestExecutionContext(
    plan,
    script,
    outputMap,
    testAbsolutePath,
  );

  let report: unknown;
  try {
    report = await execute(context);
  } catch (error) {
    throw createScriptExecutionError(script, error, {
      absolutePath: testAbsolutePath,
      reason: `Script test \`${describeScriptTestPath(script, testAbsolutePath)}\` threw before returning results.`,
      suggestion: scriptTestRuntimeFailureSuggestion,
      details: [`Script under test: ${script.config.path}`],
    });
  }

  const results = normalizeScriptTestReport(context, report);
  assertScriptTestResultsPassed(context, results);
  return {
    context,
    results,
    observedTargetReads: getObservedTargetReads(),
  };
}

export function serializeScriptTestRuntimeError(
  script: ScriptApplication,
  testAbsolutePath: string,
  error: unknown,
): ScriptTestRuntimeErrorPayload {
  if (error instanceof YmbError) {
    return {
      category: error.category,
      context: error.context,
      message: error.message,
    };
  }

  return {
    message: formatUnknownRuntimeError(error),
    context: {
      absolutePath: testAbsolutePath,
      modId: script.mod.config.id,
      modName: script.mod.config.name,
      patchId: script.patch?.config.id,
      reason: `Script test \`${describeScriptTestPath(script, testAbsolutePath)}\` threw before returning results.`,
      suggestion: scriptTestRuntimeFailureSuggestion,
      details: [`Script under test: ${script.config.path}`, formatUnknownRuntimeError(error)],
    },
  };
}

async function ensureScriptTestFileExists(
  script: ScriptApplication,
  testAbsolutePath: string,
): Promise<void> {
  ensure(await Bun.file(testAbsolutePath).exists(), 'ScriptError', {
    absolutePath: testAbsolutePath,
    modId: script.mod.config.id,
    modName: script.mod.config.name,
    patchId: script.patch?.config.id,
    reason: `Configured script test \`${describeScriptTestPath(script, testAbsolutePath)}\` does not exist.`,
    suggestion: missingScriptTestSuggestion,
    details: [`Script under test: ${script.config.path}`],
  });
}

function resolveTestExport(
  script: ScriptApplication,
  testAbsolutePath: string,
  importedModule: BuildScriptTestModule,
): NonNullable<BuildScriptTestModule['default']> {
  const execute = importedModule.default;
  ensure(typeof execute === 'function', 'ScriptError', {
    absolutePath: testAbsolutePath,
    modId: script.mod.config.id,
    modName: script.mod.config.name,
    patchId: script.patch?.config.id,
    reason: `Script test \`${describeScriptTestPath(script, testAbsolutePath)}\` must export a default function.`,
    suggestion:
      'Export `default async function (context) { return { results: [...] }; }` from the test module.',
    details: [`Script under test: ${script.config.path}`],
  });
  return execute;
}

function describeScriptTestPath(script: ScriptApplication, testAbsolutePath: string): string {
  const relativePath = path
    .relative(script.mod.absolutePath, testAbsolutePath)
    .replaceAll('\\', '/');
  return relativePath.length > 0 ? relativePath : path.basename(testAbsolutePath);
}

async function runScriptTestInSubprocess(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  testAbsolutePath: string,
  outputMap: Map<string, WrittenBuildFile>,
): Promise<ExecutedScriptTestRun> {
  let resolveResponse: ((response: ScriptTestRuntimeResponse) => void) | undefined;
  const responsePromise = new Promise<ScriptTestRuntimeResponse>((resolve) => {
    resolveResponse = resolve;
  });
  const child = Bun.spawn([process.execPath, scriptTestRuntimeChildPath], {
    cwd: plan.context.ymbRoot,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
    ipc(message) {
      if (isScriptTestRuntimeResponse(message)) {
        resolveResponse?.(message);
      }
    },
  });
  child.send({
    plan,
    script,
    testAbsolutePath,
    outputEntries: [...outputMap.entries()],
  } satisfies ScriptTestRuntimeRequest);

  const {
    exitCode,
    response: resolvedResponse,
    stderrText,
  } = await awaitIpcChildResult(child, responsePromise, {
    absolutePath: testAbsolutePath,
    modId: script.mod.config.id,
    modName: script.mod.config.name,
    patchId: script.patch?.config.id,
    subjectLabel: `Script test \`${describeScriptTestPath(script, testAbsolutePath)}\``,
  });

  if (!resolvedResponse) {
    throw new YmbError('ScriptError', {
      absolutePath: testAbsolutePath,
      modId: script.mod.config.id,
      modName: script.mod.config.name,
      patchId: script.patch?.config.id,
      reason: `Script test \`${describeScriptTestPath(script, testAbsolutePath)}\` exited before returning results.`,
      suggestion: scriptTestRuntimeFailureSuggestion,
      details: [
        `Script under test: ${script.config.path}`,
        `Exit code: ${exitCode}`,
        ...(stderrText.length > 0 ? [stderrText] : []),
      ],
    });
  }

  if (resolvedResponse.ok) {
    const { context } = createScriptTestExecutionContext(plan, script, outputMap, testAbsolutePath);
    return {
      context,
      results: resolvedResponse.results,
      observedTargetReads: resolvedResponse.observedTargetReads,
    };
  }

  const runtimeError = resolvedResponse.error;
  if (runtimeError.category && runtimeError.context) {
    throw new YmbError(runtimeError.category, runtimeError.context);
  }

  throw new YmbError('ScriptError', {
    absolutePath: testAbsolutePath,
    modId: script.mod.config.id,
    modName: script.mod.config.name,
    patchId: script.patch?.config.id,
    reason: `Script test \`${describeScriptTestPath(script, testAbsolutePath)}\` threw before returning results.`,
    suggestion: scriptTestRuntimeFailureSuggestion,
    details: [`Script under test: ${script.config.path}`, runtimeError.message],
  });
}

function isScriptTestRuntimeResponse(message: unknown): message is ScriptTestRuntimeResponse {
  if (typeof message !== 'object' || message === null || !('ok' in message)) {
    return false;
  }

  const candidate = message as Partial<ScriptTestRuntimeResponse>;
  if (candidate.ok === true) {
    return Array.isArray(candidate.results) && Array.isArray(candidate.observedTargetReads);
  }

  if (candidate.ok === false) {
    return (
      typeof candidate.error === 'object' &&
      candidate.error !== null &&
      typeof candidate.error.message === 'string'
    );
  }

  return false;
}
