import { fileURLToPath } from 'node:url';
import { ensure, YmbError } from '../errors.ts';
import type {
  ErrorCategory,
  ErrorContext,
  GeneratedScriptFile,
  ScriptApplication,
  ScriptRuntimePlan,
  WrittenBuildFile,
} from '../types.ts';
import { createScriptContext } from './runtime-context.ts';
import { importScriptModule } from './runtime-loader.ts';
import { normalizeScriptOutput } from './runtime-output.ts';
import {
  awaitIpcChildResult,
  createScriptExecutionError,
  formatUnknownRuntimeError,
} from './runtime-shared.ts';

const scriptRuntimeChildPath = fileURLToPath(new URL('./runtime-child.ts', import.meta.url));
const missingScriptSuggestion = 'Fix the relative script path or add the missing script file.';
const runtimeFailureSuggestion =
  'Fix the thrown error or the script input assumptions, then run the command again.';
const missingOutputsSuggestion = 'Fix the script so it returns outputs and exits cleanly.';

export interface ScriptRuntimeRequest {
  plan: ScriptRuntimePlan;
  script: ScriptApplication;
  outputEntries: Array<readonly [string, WrittenBuildFile]>;
}

export interface ScriptRuntimeErrorPayload {
  category?: ErrorCategory | undefined;
  context?: ErrorContext | undefined;
  message: string;
}

type ScriptRuntimeResponse =
  | {
      ok: true;
      outputs: GeneratedScriptFile[];
    }
  | {
      ok: false;
      error: ScriptRuntimeErrorPayload;
    };

export async function runScript(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  outputMap: Map<string, WrittenBuildFile>,
): Promise<GeneratedScriptFile[]> {
  await ensureScriptFileExists(script);
  return await runScriptInSubprocess(plan, script, outputMap);
}

export async function executeScriptInProcess(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  outputMap: Map<string, WrittenBuildFile>,
): Promise<GeneratedScriptFile[]> {
  await ensureScriptFileExists(script);
  const importedModule = await importScriptModule(script, plan.selection.useCache !== false);
  const execute = importedModule.default ?? importedModule.generate;
  ensure(typeof execute === 'function', 'ScriptError', {
    absolutePath: script.absolutePath,
    modId: script.mod.config.id,
    modName: script.mod.config.name,
    patchId: script.patch?.config.id,
    reason: 'Generation scripts must export a default function or named `generate` function.',
    suggestion: 'Export `default async function (context) { ... }` from the script module.',
  });

  const context = createScriptContext(plan, script, outputMap);

  let result: GeneratedScriptFile | GeneratedScriptFile[];
  try {
    result = await execute(context);
  } catch (error) {
    throw createScriptExecutionError(script, error, {
      absolutePath: script.absolutePath,
      reason: `Generation script \`${script.config.path}\` threw before returning outputs.`,
      suggestion: runtimeFailureSuggestion,
    });
  }

  const outputs = Array.isArray(result) ? result : [result];
  return outputs.map((output, index) => normalizeScriptOutput(script, output, index));
}

export function serializeScriptRuntimeError(
  script: ScriptApplication,
  error: unknown,
): ScriptRuntimeErrorPayload {
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
      absolutePath: script.absolutePath,
      modId: script.mod.config.id,
      modName: script.mod.config.name,
      patchId: script.patch?.config.id,
      reason: `Generation script \`${script.config.path}\` threw before returning outputs.`,
      suggestion: runtimeFailureSuggestion,
      details: [formatUnknownRuntimeError(error)],
    },
  };
}

async function ensureScriptFileExists(script: ScriptApplication): Promise<void> {
  ensure(await Bun.file(script.absolutePath).exists(), 'ScriptError', {
    absolutePath: script.absolutePath,
    modId: script.mod.config.id,
    modName: script.mod.config.name,
    patchId: script.patch?.config.id,
    reason: `Configured generation script \`${script.config.path}\` does not exist.`,
    suggestion: missingScriptSuggestion,
  });
}

async function runScriptInSubprocess(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  outputMap: Map<string, WrittenBuildFile>,
): Promise<GeneratedScriptFile[]> {
  let resolveResponse: ((response: ScriptRuntimeResponse) => void) | undefined;
  const responsePromise = new Promise<ScriptRuntimeResponse>((resolve) => {
    resolveResponse = resolve;
  });
  const child = Bun.spawn([process.execPath, scriptRuntimeChildPath], {
    cwd: plan.context.ymbRoot,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
    ipc(message) {
      if (isScriptRuntimeResponse(message)) {
        resolveResponse?.(message);
      }
    },
  });
  child.send({
    plan,
    script,
    outputEntries: [...outputMap.entries()],
  } satisfies ScriptRuntimeRequest);

  const {
    exitCode,
    response: resolvedResponse,
    stderrText,
  } = await awaitIpcChildResult(child, responsePromise, {
    absolutePath: script.absolutePath,
    modId: script.mod.config.id,
    modName: script.mod.config.name,
    patchId: script.patch?.config.id,
    subjectLabel: `Generation script \`${script.config.path}\``,
  });

  if (!resolvedResponse) {
    throw new YmbError('ScriptError', {
      absolutePath: script.absolutePath,
      modId: script.mod.config.id,
      modName: script.mod.config.name,
      patchId: script.patch?.config.id,
      reason: `Generation script \`${script.config.path}\` exited before returning outputs.`,
      suggestion: missingOutputsSuggestion,
      details: [`Exit code: ${exitCode}`, ...(stderrText.length > 0 ? [stderrText] : [])],
    });
  }

  if (resolvedResponse.ok) {
    return resolvedResponse.outputs;
  }

  const runtimeError = resolvedResponse.error;
  if (runtimeError.category && runtimeError.context) {
    throw new YmbError(runtimeError.category, runtimeError.context);
  }

  throw new YmbError('ScriptError', {
    absolutePath: script.absolutePath,
    modId: script.mod.config.id,
    modName: script.mod.config.name,
    patchId: script.patch?.config.id,
    reason: `Generation script \`${script.config.path}\` threw before returning outputs.`,
    suggestion: runtimeFailureSuggestion,
    details: [runtimeError.message],
  });
}

function isScriptRuntimeResponse(message: unknown): message is ScriptRuntimeResponse {
  if (typeof message !== 'object' || message === null || !('ok' in message)) {
    return false;
  }

  const candidate = message as Partial<ScriptRuntimeResponse>;
  if (candidate.ok === true) {
    return Array.isArray(candidate.outputs);
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
