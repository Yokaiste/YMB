import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ensure, YmbError } from '../errors.ts';
import type {
  BuildScriptTestModule,
  ScriptApplication,
  ScriptRuntimePlan,
  ScriptTestResult,
  WrittenBuildFile,
} from '../types.ts';
import { createScriptTestContext } from './runtime-context.ts';
import { importScriptTestModule } from './runtime-loader.ts';
import { formatUnknownRuntimeError } from './runtime-shared.ts';
import { assertScriptTestResultsPassed, normalizeScriptTestReport } from './testing.ts';

const scriptTestRuntimeChildPath = fileURLToPath(
  new URL('./test-runtime-child.ts', import.meta.url),
);
const missingScriptTestSuggestion =
  'Fix the configured test path or add the missing companion test file.';
const scriptTestRuntimeFailureSuggestion =
  'Fix the thrown error in the test or generation script, then run the command again.';
const missingScriptTestResultsSuggestion = 'Fix the test so it returns results and exits cleanly.';

export interface ScriptTestRuntimeRequest {
  plan: ScriptRuntimePlan;
  script: ScriptApplication;
  testAbsolutePath: string;
  outputEntries: Array<readonly [string, WrittenBuildFile]>;
}

export interface ScriptTestRuntimeErrorPayload {
  category?: 'ScriptError' | undefined;
  context?:
    | {
        absolutePath: string;
        modId?: string | undefined;
        modName?: string | undefined;
        patchId?: string | undefined;
        operationIndex?: number | undefined;
        reason: string;
        suggestion: string;
        details?: string[] | undefined;
      }
    | undefined;
  message: string;
}

type ScriptTestRuntimeResponse =
  | {
      ok: true;
      results: ScriptTestResult[];
    }
  | {
      ok: false;
      error: ScriptTestRuntimeErrorPayload;
    };

export async function runScriptTests(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  outputMap: Map<string, WrittenBuildFile>,
): Promise<Array<{ testAbsolutePath: string; results: ScriptTestResult[] }>> {
  const executed: Array<{ testAbsolutePath: string; results: ScriptTestResult[] }> = [];
  for (const testAbsolutePath of script.testAbsolutePaths) {
    await ensureScriptTestFileExists(script, testAbsolutePath);
    executed.push({
      testAbsolutePath,
      results: await runScriptTestInSubprocess(plan, script, testAbsolutePath, outputMap),
    });
  }
  return executed;
}

export async function executeScriptTestInProcess(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  testAbsolutePath: string,
  outputMap: Map<string, WrittenBuildFile>,
): Promise<ScriptTestResult[]> {
  await ensureScriptTestFileExists(script, testAbsolutePath);
  const importedModule = await importScriptTestModule({
    script,
    testAbsolutePath,
    useCache: plan.selection.useCache !== false,
  });
  const execute = resolveTestExport(script, testAbsolutePath, importedModule);
  const context = createScriptTestContext(plan, script, outputMap, testAbsolutePath);

  let report: unknown;
  try {
    report = await execute(context);
  } catch (error) {
    throw new YmbError('ScriptError', {
      absolutePath: testAbsolutePath,
      modId: script.mod.config.id,
      modName: script.mod.config.name,
      patchId: script.patch?.config.id,
      reason: `Script test \`${describeScriptTestPath(script, testAbsolutePath)}\` threw before returning results.`,
      suggestion: scriptTestRuntimeFailureSuggestion,
      details: [`Script under test: ${script.config.path}`, formatUnknownRuntimeError(error)],
    });
  }

  const results = normalizeScriptTestReport(context, report);
  assertScriptTestResultsPassed(context, results);
  return results;
}

export function serializeScriptTestRuntimeError(
  script: ScriptApplication,
  testAbsolutePath: string,
  error: unknown,
): ScriptTestRuntimeErrorPayload {
  if (error instanceof YmbError) {
    return {
      category: 'ScriptError',
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

async function runScriptTestInSubprocess(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  testAbsolutePath: string,
  outputMap: Map<string, WrittenBuildFile>,
): Promise<ScriptTestResult[]> {
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

  const exitCode = await child.exited;
  const resolvedResponse = await Promise.race([
    responsePromise,
    delay(exitCode === 0 ? 250 : 50).then(() => undefined),
  ]);
  const stderrText = child.stderr ? (await new Response(child.stderr).text()).trim() : '';

  if (!resolvedResponse) {
    throw new YmbError('ScriptError', {
      absolutePath: testAbsolutePath,
      modId: script.mod.config.id,
      modName: script.mod.config.name,
      patchId: script.patch?.config.id,
      reason: `Script test \`${describeScriptTestPath(script, testAbsolutePath)}\` exited before returning results.`,
      suggestion: missingScriptTestResultsSuggestion,
      details: [
        `Script under test: ${script.config.path}`,
        `Exit code: ${exitCode}`,
        ...(stderrText.length > 0 ? [stderrText] : []),
      ],
    });
  }

  if (resolvedResponse.ok) {
    return resolvedResponse.results;
  }

  if (resolvedResponse.error.category && resolvedResponse.error.context) {
    throw new YmbError(resolvedResponse.error.category, resolvedResponse.error.context);
  }

  throw new YmbError('ScriptError', {
    absolutePath: testAbsolutePath,
    modId: script.mod.config.id,
    modName: script.mod.config.name,
    patchId: script.patch?.config.id,
    reason: `Script test \`${describeScriptTestPath(script, testAbsolutePath)}\` threw before returning results.`,
    suggestion: scriptTestRuntimeFailureSuggestion,
    details: [`Script under test: ${script.config.path}`, resolvedResponse.error.message],
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

function isScriptTestRuntimeResponse(message: unknown): message is ScriptTestRuntimeResponse {
  if (typeof message !== 'object' || message === null || !('ok' in message)) {
    return false;
  }

  const candidate = message as Partial<ScriptTestRuntimeResponse>;
  if (candidate.ok === true) {
    return Array.isArray(candidate.results);
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
