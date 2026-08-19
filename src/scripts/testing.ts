import path from 'node:path';
import type { BuildScriptTestContext, ScriptTestReport, ScriptTestResult } from 'ymb/api';
import { ensure, YmbError } from '../errors.ts';
import { formatDetailLine } from '../report/detail.ts';
import type { ErrorContext, ScriptApplication } from '../types.ts';

export interface ExecutedScriptTestResult {
  script: ScriptApplication;
  testAbsolutePath: string;
  result: ScriptTestResult;
  cached?: boolean;
}

const REPORT_SHAPE_SUGGESTION =
  'Return `{ results: [ ... ] }` from the default export and use the YMB script-test result schema.';

/**
 * Every failure here points at the same test file and names the script it
 * protects, so the shared identity is built once instead of at each call.
 */
function testErrorContext(
  context: BuildScriptTestContext,
  reason: string,
  suggestion: string,
  extraDetails: string[] = [],
): ErrorContext {
  return {
    absolutePath: context.testAbsolutePath,
    modId: context.mod.id,
    modName: context.mod.name,
    patchId: context.patch?.id,
    reason,
    suggestion,
    details: [`Script under test: ${context.script.absolutePath}`, ...extraDetails],
  };
}

function testFileName(context: BuildScriptTestContext): string {
  return path.basename(context.testAbsolutePath);
}

export function normalizeScriptTestReport(
  context: BuildScriptTestContext,
  report: unknown,
): ScriptTestResult[] {
  ensure(
    report && typeof report === 'object' && 'results' in report,
    'ScriptError',
    testErrorContext(
      context,
      `Script test \`${testFileName(context)}\` returned an unsupported format.`,
      REPORT_SHAPE_SUGGESTION,
    ),
  );

  const candidate = report as Partial<ScriptTestReport>;
  ensure(
    Array.isArray(candidate.results),
    'ScriptError',
    testErrorContext(
      context,
      `Script test \`${testFileName(context)}\` must return a \`results\` array.`,
      REPORT_SHAPE_SUGGESTION,
    ),
  );

  return candidate.results.map((result, index) =>
    normalizeScriptTestResult(context, result, index),
  );
}

export function assertScriptTestResultsPassed(
  context: BuildScriptTestContext,
  results: ScriptTestResult[],
): void {
  const failures = results.filter((result) => result.status === 'failed');
  const [firstFailure] = failures;
  if (!firstFailure) {
    return;
  }

  if (failures.length === 1) {
    throw new YmbError(
      'ScriptError',
      testErrorContext(
        context,
        firstFailure.reason ??
          `Script test \`${firstFailure.name}\` failed in \`${testFileName(context)}\`.`,
        firstFailure.suggestion ??
          'Fix the failing script test or the underlying generation script.',
        [`Test name: ${firstFailure.name}`, ...(firstFailure.details ?? [])],
      ),
    );
  }

  throw new YmbError(
    'ScriptError',
    testErrorContext(
      context,
      `Script test file \`${testFileName(context)}\` reported multiple failures.`,
      'Fix the failing script tests or the underlying generation script.',
      failures.flatMap((failure) => [
        `Failed test: ${failure.name}`,
        ...(failure.reason ? [`Reason: ${failure.reason}`] : []),
        ...(failure.suggestion ? [`Suggestion: ${failure.suggestion}`] : []),
        ...(failure.details ?? []),
      ]),
    ),
  );
}

/** One detail line per reported test. `*` marks a result answered from cache. */
export function formatScriptTestLogLine(result: ExecutedScriptTestResult): string {
  return formatDetailLine(
    result.cached ? 'test ok*' : 'test ok',
    `${path.basename(result.testAbsolutePath)} :: ${result.result.name}`,
  );
}

function normalizeScriptTestResult(
  context: BuildScriptTestContext,
  result: unknown,
  resultIndex: number,
): ScriptTestResult {
  ensure(
    result && typeof result === 'object',
    'ScriptError',
    testErrorContext(
      context,
      `Script test result #${resultIndex + 1} in \`${testFileName(context)}\` is not an object.`,
      'Return result objects with `name`, `status`, and optional YMB error fields.',
    ),
  );

  const candidate = result as Partial<ScriptTestResult>;
  ensure(
    typeof candidate.name === 'string' && candidate.name.length > 0,
    'ScriptError',
    testErrorContext(
      context,
      `Script test result #${resultIndex + 1} is missing a valid \`name\`.`,
      'Set a non-empty `name` on every YMB script-test result.',
    ),
  );
  ensure(
    candidate.status === 'passed' || candidate.status === 'failed',
    'ScriptError',
    testErrorContext(
      context,
      `Script test \`${candidate.name}\` has an unsupported \`status\`.`,
      'Use only `passed` or `failed` for YMB script-test results.',
    ),
  );
  ensure(
    candidate.details === undefined ||
      (Array.isArray(candidate.details) &&
        candidate.details.every((detail) => typeof detail === 'string')),
    'ScriptError',
    testErrorContext(
      context,
      `Script test \`${candidate.name}\` has invalid \`details\`.`,
      'Use `details` as an array of strings when returning YMB script-test results.',
    ),
  );

  if (candidate.status === 'failed') {
    ensure(
      typeof candidate.reason === 'string' && candidate.reason.length > 0,
      'ScriptError',
      testErrorContext(
        context,
        `Failed script test \`${candidate.name}\` is missing a YMB-standard \`reason\`.`,
        'Set a non-empty `reason` on failed YMB script-test results.',
      ),
    );
    ensure(
      typeof candidate.suggestion === 'string' && candidate.suggestion.length > 0,
      'ScriptError',
      testErrorContext(
        context,
        `Failed script test \`${candidate.name}\` is missing a YMB-standard \`suggestion\`.`,
        'Set a non-empty `suggestion` on failed YMB script-test results.',
      ),
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
