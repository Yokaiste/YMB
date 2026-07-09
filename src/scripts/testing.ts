import path from 'node:path';
import { ensure, YmbError } from '../errors.ts';
import type {
  BuildScriptTestContext,
  ScriptApplication,
  ScriptTestReport,
  ScriptTestResult,
} from '../types.ts';

export interface ExecutedScriptTestResult {
  script: ScriptApplication;
  testAbsolutePath: string;
  result: ScriptTestResult;
  cached?: boolean;
}

export function normalizeScriptTestReport(
  context: BuildScriptTestContext,
  report: unknown,
): ScriptTestResult[] {
  ensure(report && typeof report === 'object' && 'results' in report, 'ScriptError', {
    absolutePath: context.testAbsolutePath,
    modId: context.mod.config.id,
    modName: context.mod.config.name,
    patchId: context.patch?.config.id,
    reason: `Script test \`${path.basename(context.testAbsolutePath)}\` returned an unsupported format.`,
    suggestion:
      'Return `{ results: [ ... ] }` from the default export and use the YMB script-test result schema.',
    details: [`Script under test: ${context.script.absolutePath}`],
  });

  const candidate = report as Partial<ScriptTestReport>;
  ensure(Array.isArray(candidate.results), 'ScriptError', {
    absolutePath: context.testAbsolutePath,
    modId: context.mod.config.id,
    modName: context.mod.config.name,
    patchId: context.patch?.config.id,
    reason: `Script test \`${path.basename(context.testAbsolutePath)}\` must return a \`results\` array.`,
    suggestion:
      'Return `{ results: [ ... ] }` from the default export and use the YMB script-test result schema.',
    details: [`Script under test: ${context.script.absolutePath}`],
  });

  return candidate.results.map((result, index) =>
    normalizeScriptTestResult(context, result, index),
  );
}

export function assertScriptTestResultsPassed(
  context: BuildScriptTestContext,
  results: ScriptTestResult[],
): void {
  const failures = results.filter((result) => result.status === 'failed');
  if (failures.length === 0) {
    return;
  }

  if (failures.length === 1) {
    const failure = failures[0] as ScriptTestResult;
    throw new YmbError('ScriptError', {
      absolutePath: context.testAbsolutePath,
      modId: context.mod.config.id,
      modName: context.mod.config.name,
      patchId: context.patch?.config.id,
      reason:
        failure.reason ??
        `Script test \`${failure.name}\` failed in \`${path.basename(context.testAbsolutePath)}\`.`,
      suggestion:
        failure.suggestion ?? 'Fix the failing script test or the underlying generation script.',
      details: [
        `Test name: ${failure.name}`,
        `Script under test: ${context.script.absolutePath}`,
        ...(failure.details ?? []),
      ],
    });
  }

  throw new YmbError('ScriptError', {
    absolutePath: context.testAbsolutePath,
    modId: context.mod.config.id,
    modName: context.mod.config.name,
    patchId: context.patch?.config.id,
    reason: `Script test file \`${path.basename(context.testAbsolutePath)}\` reported multiple failures.`,
    suggestion: 'Fix the failing script tests or the underlying generation script.',
    details: [
      `Script under test: ${context.script.absolutePath}`,
      ...failures.flatMap((failure) => [
        `Failed test: ${failure.name}`,
        ...(failure.reason ? [`Reason: ${failure.reason}`] : []),
        ...(failure.suggestion ? [`Suggestion: ${failure.suggestion}`] : []),
        ...(failure.details ?? []),
      ]),
    ],
  });
}

export function formatScriptTestLabel(result: ExecutedScriptTestResult): string {
  return `${path.basename(result.testAbsolutePath)} :: ${result.result.name}`;
}

function normalizeScriptTestResult(
  context: BuildScriptTestContext,
  result: unknown,
  resultIndex: number,
): ScriptTestResult {
  ensure(result && typeof result === 'object', 'ScriptError', {
    absolutePath: context.testAbsolutePath,
    modId: context.mod.config.id,
    modName: context.mod.config.name,
    patchId: context.patch?.config.id,
    reason: `Script test result #${resultIndex + 1} in \`${path.basename(context.testAbsolutePath)}\` is not an object.`,
    suggestion: 'Return result objects with `name`, `status`, and optional YMB error fields.',
    details: [`Script under test: ${context.script.absolutePath}`],
  });

  const candidate = result as Partial<ScriptTestResult>;
  ensure(typeof candidate.name === 'string' && candidate.name.length > 0, 'ScriptError', {
    absolutePath: context.testAbsolutePath,
    modId: context.mod.config.id,
    modName: context.mod.config.name,
    patchId: context.patch?.config.id,
    reason: `Script test result #${resultIndex + 1} is missing a valid \`name\`.`,
    suggestion: 'Set a non-empty `name` on every YMB script-test result.',
    details: [`Script under test: ${context.script.absolutePath}`],
  });
  ensure(candidate.status === 'passed' || candidate.status === 'failed', 'ScriptError', {
    absolutePath: context.testAbsolutePath,
    modId: context.mod.config.id,
    modName: context.mod.config.name,
    patchId: context.patch?.config.id,
    reason: `Script test \`${candidate.name}\` has an unsupported \`status\`.`,
    suggestion: 'Use only `passed` or `failed` for YMB script-test results.',
    details: [`Script under test: ${context.script.absolutePath}`],
  });
  ensure(
    candidate.details === undefined ||
      (Array.isArray(candidate.details) &&
        candidate.details.every((detail) => typeof detail === 'string')),
    'ScriptError',
    {
      absolutePath: context.testAbsolutePath,
      modId: context.mod.config.id,
      modName: context.mod.config.name,
      patchId: context.patch?.config.id,
      reason: `Script test \`${candidate.name}\` has invalid \`details\`.`,
      suggestion: 'Use `details` as an array of strings when returning YMB script-test results.',
      details: [`Script under test: ${context.script.absolutePath}`],
    },
  );

  if (candidate.status === 'failed') {
    ensure(typeof candidate.reason === 'string' && candidate.reason.length > 0, 'ScriptError', {
      absolutePath: context.testAbsolutePath,
      modId: context.mod.config.id,
      modName: context.mod.config.name,
      patchId: context.patch?.config.id,
      reason: `Failed script test \`${candidate.name}\` is missing a YMB-standard \`reason\`.`,
      suggestion: 'Set a non-empty `reason` on failed YMB script-test results.',
      details: [`Script under test: ${context.script.absolutePath}`],
    });
    ensure(
      typeof candidate.suggestion === 'string' && candidate.suggestion.length > 0,
      'ScriptError',
      {
        absolutePath: context.testAbsolutePath,
        modId: context.mod.config.id,
        modName: context.mod.config.name,
        patchId: context.patch?.config.id,
        reason: `Failed script test \`${candidate.name}\` is missing a YMB-standard \`suggestion\`.`,
        suggestion: 'Set a non-empty `suggestion` on failed YMB script-test results.',
        details: [`Script under test: ${context.script.absolutePath}`],
      },
    );
  }

  return {
    name: candidate.name,
    status: candidate.status,
    ...(candidate.reason ? { reason: candidate.reason } : {}),
    ...(candidate.suggestion ? { suggestion: candidate.suggestion } : {}),
    ...(candidate.details ? { details: candidate.details } : {}),
  };
}
