import path from 'node:path';
import type { BuildScriptTestContext, BuildScriptTestModule, ScriptTestResult } from 'ymb/api';
import { ensure, YmbError } from '../errors.ts';
import { resolveRuntimeEntrypoint } from '../runtime-entrypoint.ts';
import type {
  ErrorContext,
  ScriptApplication,
  ScriptRuntimePlan,
  WrittenBuildFile,
} from '../types.ts';
import {
  createScriptTestExecutionContext,
  type ObservedScriptFileRead,
} from './runtime-context.ts';
import type { Exchanged } from './runtime-exchange.ts';
import { createExchangeRoot, removeExchangeRoot, writeExchangedFiles } from './runtime-exchange.ts';
import { importScriptTestModule } from './runtime-loader.ts';
import {
  createRuntimeResponseError,
  createScriptExecutionError,
  isRuntimeResponse,
  type RuntimeErrorPayload,
  type RuntimeResponse,
  runIpcWorker,
  serializeRuntimeError,
} from './runtime-shared.ts';
import type { ObservedTargetRead } from './target-readers.ts';
import { assertScriptTestResultsPassed, normalizeScriptTestReport } from './testing.ts';

const scriptTestRuntimeChildPath = resolveRuntimeEntrypoint(import.meta.url, 'test-runtime-child');

const missingScriptTestSuggestion =
  'Fix the configured test path or add the missing companion test file.';
const scriptTestRuntimeFailureSuggestion =
  'Fix the thrown error in the test or generation script, then run the command again.';

interface ScriptTestRunOutcome {
  results: ScriptTestResult[];
  observedTargetReads: ObservedTargetRead[];
  observedScriptFileReads: ObservedScriptFileRead[];
}

/** The in-process runner also hands back the context it built, for direct callers and tests. */
interface InProcessScriptTestRun extends ScriptTestRunOutcome {
  context: BuildScriptTestContext;
}

export interface ScriptTestRuntimeRequest {
  plan: ScriptRuntimePlan;
  script: ScriptApplication;
  testAbsolutePath: string;
  outputFiles: Exchanged<WrittenBuildFile>[];
  exchangeRoot: string;
}

interface ScriptTestRuntimeSuccessPayload {
  results: ScriptTestResult[];
  observedTargetReads: ObservedTargetRead[];
  observedScriptFileReads: ObservedScriptFileRead[];
}

type ScriptTestRuntimeResponse = RuntimeResponse<ScriptTestRuntimeSuccessPayload>;

export async function executeScriptTest(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  testAbsolutePath: string,
  outputMap: Map<string, WrittenBuildFile>,
): Promise<ScriptTestRunOutcome> {
  await ensureScriptTestFileExists(script, testAbsolutePath);
  return runScriptTestInSubprocess(plan, script, testAbsolutePath, outputMap);
}

export async function executeScriptTestInProcess(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  testAbsolutePath: string,
  outputMap: Map<string, WrittenBuildFile>,
): Promise<InProcessScriptTestRun> {
  await ensureScriptTestFileExists(script, testAbsolutePath);
  const importedModule = await importScriptTestModule({
    script,
    testAbsolutePath,
    useCache: plan.selection.useCache !== false,
  });
  const execute = resolveTestExport(script, testAbsolutePath, importedModule);
  const { context, getObservedTargetReads, getObservedScriptFileReads } =
    createScriptTestExecutionContext(plan, script, outputMap, testAbsolutePath);

  let report: unknown;
  try {
    report = await execute(context);
  } catch (error) {
    throw createScriptExecutionError(
      script,
      error,
      createScriptTestRuntimeFailureContext(script, testAbsolutePath),
    );
  }

  const results = normalizeScriptTestReport(context, report);
  assertScriptTestResultsPassed(context, results);
  return {
    context,
    results,
    observedTargetReads: getObservedTargetReads(),
    observedScriptFileReads: getObservedScriptFileReads(),
  };
}

export function serializeScriptTestRuntimeError(
  script: ScriptApplication,
  testAbsolutePath: string,
  error: unknown,
): RuntimeErrorPayload {
  return serializeRuntimeError(
    error,
    createScriptTestRuntimeFailureContext(script, testAbsolutePath),
  );
}

async function ensureScriptTestFileExists(
  script: ScriptApplication,
  testAbsolutePath: string,
): Promise<void> {
  ensure(
    await Bun.file(testAbsolutePath).exists(),
    'ScriptError',
    createScriptTestErrorContext(
      script,
      testAbsolutePath,
      `Configured script test \`${describeScriptTestPath(script, testAbsolutePath)}\` does not exist.`,
      missingScriptTestSuggestion,
    ),
  );
}

function resolveTestExport(
  script: ScriptApplication,
  testAbsolutePath: string,
  importedModule: BuildScriptTestModule,
): NonNullable<BuildScriptTestModule['default']> {
  const execute = importedModule.default;
  ensure(
    typeof execute === 'function',
    'ScriptError',
    createScriptTestErrorContext(
      script,
      testAbsolutePath,
      `Script test \`${describeScriptTestPath(script, testAbsolutePath)}\` must export a default function.`,
      'Export `default async function (context) { return { results: [...] }; }` from the test module.',
    ),
  );
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
): Promise<ScriptTestRunOutcome> {
  const exchangeRoot = await createExchangeRoot();
  try {
    const {
      exitCode,
      response: resolvedResponse,
      stderrText,
    } = await runIpcWorker<ScriptTestRuntimeRequest, ScriptTestRuntimeResponse>({
      childPath: scriptTestRuntimeChildPath,
      cwd: plan.context.ymbRoot,
      request: {
        plan,
        script,
        testAbsolutePath,
        outputFiles: await writeExchangedFiles([...outputMap.values()], exchangeRoot, 'input'),
        exchangeRoot,
      },
      isResponse: isScriptTestRuntimeResponse,
      errorContext: {
        absolutePath: testAbsolutePath,
        modId: script.mod.config.id,
        modName: script.mod.config.name,
        patchId: script.patch?.config.id,
        subjectLabel: `Script test \`${describeScriptTestPath(script, testAbsolutePath)}\``,
      },
      timeoutSeconds: plan.context.builderConfig.settings.scriptTimeoutSeconds,
    });

    if (!resolvedResponse) {
      throw new YmbError(
        'ScriptError',
        createScriptTestErrorContext(
          script,
          testAbsolutePath,
          `Script test \`${describeScriptTestPath(script, testAbsolutePath)}\` exited before returning results.`,
          scriptTestRuntimeFailureSuggestion,
          [`Exit code: ${exitCode}`, ...(stderrText.length > 0 ? [stderrText] : [])],
        ),
      );
    }

    if (resolvedResponse.ok) {
      return {
        results: resolvedResponse.results,
        observedTargetReads: resolvedResponse.observedTargetReads,
        observedScriptFileReads: resolvedResponse.observedScriptFileReads,
      };
    }

    throw createRuntimeResponseError(
      resolvedResponse.error,
      createScriptTestRuntimeFailureContext(script, testAbsolutePath),
    );
  } finally {
    await removeExchangeRoot(exchangeRoot);
  }
}

function createScriptTestRuntimeFailureContext(
  script: ScriptApplication,
  testAbsolutePath: string,
): ErrorContext {
  return createScriptTestErrorContext(
    script,
    testAbsolutePath,
    `Script test \`${describeScriptTestPath(script, testAbsolutePath)}\` threw before returning results.`,
    scriptTestRuntimeFailureSuggestion,
  );
}

function createScriptTestErrorContext(
  script: ScriptApplication,
  testAbsolutePath: string,
  reason: string,
  suggestion: string,
  additionalDetails: string[] = [],
): ErrorContext {
  return {
    absolutePath: testAbsolutePath,
    modId: script.mod.config.id,
    modName: script.mod.config.name,
    patchId: script.patch?.config.id,
    reason,
    suggestion,
    details: [`Script under test: ${script.config.path}`, ...additionalDetails],
  };
}

function isScriptTestRuntimeResponse(message: unknown): message is ScriptTestRuntimeResponse {
  return isRuntimeResponse<ScriptTestRuntimeSuccessPayload>(message, (candidate) => {
    return (
      Array.isArray(candidate.results) &&
      Array.isArray(candidate.observedTargetReads) &&
      Array.isArray(candidate.observedScriptFileReads)
    );
  });
}
