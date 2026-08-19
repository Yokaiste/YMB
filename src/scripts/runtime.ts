import type { GeneratedScriptFile } from 'ymb/api';
import { ensure, YmbError } from '../errors.ts';
import { resolveRuntimeEntrypoint } from '../runtime-entrypoint.ts';
import type { ScriptApplication, ScriptRuntimePlan, WrittenBuildFile } from '../types.ts';
import { createScriptExecutionContext } from './runtime-context.ts';
import type { Exchanged } from './runtime-exchange.ts';
import {
  createExchangeRoot,
  readExchangedFiles,
  removeExchangeRoot,
  writeExchangedFiles,
} from './runtime-exchange.ts';
import { importScriptModule } from './runtime-loader.ts';
import { normalizeScriptOutput } from './runtime-output.ts';
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

const scriptRuntimeChildPath = resolveRuntimeEntrypoint(import.meta.url, 'runtime-child');
const missingScriptSuggestion = 'Fix the relative script path or add the missing script file.';
const runtimeFailureSuggestion =
  'Fix the thrown error or the script input assumptions, then run the command again.';
const missingOutputsSuggestion = 'Fix the script so it returns outputs and exits cleanly.';

export interface ScriptRuntimeRequest {
  plan: ScriptRuntimePlan;
  script: ScriptApplication;
  outputFiles: Exchanged<WrittenBuildFile>[];
  exchangeRoot: string;
}

interface ScriptRuntimeSuccessPayload {
  outputs: Exchanged<GeneratedScriptFile>[];
  observedTargetReads: ObservedTargetRead[];
}

type ScriptRuntimeResponse = RuntimeResponse<ScriptRuntimeSuccessPayload>;

interface ScriptExecutionResult {
  outputs: GeneratedScriptFile[];
  observedTargetReads: ObservedTargetRead[];
}

export async function runScript(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  outputMap: Map<string, WrittenBuildFile>,
): Promise<ScriptExecutionResult> {
  await ensureScriptFileExists(script);
  return await runScriptInSubprocess(plan, script, outputMap);
}

export async function executeScriptInProcess(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  outputMap: Map<string, WrittenBuildFile>,
): Promise<ScriptExecutionResult> {
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

  const { context, getObservedTargetReads } = createScriptExecutionContext(plan, script, outputMap);

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
  return {
    outputs: outputs.map((output, index) => normalizeScriptOutput(script, output, index)),
    observedTargetReads: getObservedTargetReads(),
  };
}

export function serializeScriptRuntimeError(
  script: ScriptApplication,
  error: unknown,
): RuntimeErrorPayload {
  return serializeRuntimeError(error, {
    absolutePath: script.absolutePath,
    modId: script.mod.config.id,
    modName: script.mod.config.name,
    patchId: script.patch?.config.id,
    reason: `Generation script \`${script.config.path}\` threw before returning outputs.`,
    suggestion: runtimeFailureSuggestion,
  });
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
): Promise<ScriptExecutionResult> {
  const exchangeRoot = await createExchangeRoot();
  try {
    const {
      exitCode,
      response: resolvedResponse,
      stderrText,
    } = await runIpcWorker<ScriptRuntimeRequest, ScriptRuntimeResponse>({
      childPath: scriptRuntimeChildPath,
      cwd: plan.context.ymbRoot,
      request: {
        plan,
        script,
        outputFiles: await writeExchangedFiles([...outputMap.values()], exchangeRoot, 'input'),
        exchangeRoot,
      },
      isResponse: isScriptRuntimeResponse,
      errorContext: {
        absolutePath: script.absolutePath,
        modId: script.mod.config.id,
        modName: script.mod.config.name,
        patchId: script.patch?.config.id,
        subjectLabel: `Generation script \`${script.config.path}\``,
      },
      timeoutSeconds: plan.context.builderConfig.settings.scriptTimeoutSeconds,
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
      return {
        outputs: await readExchangedFiles<GeneratedScriptFile>(
          resolvedResponse.outputs,
          exchangeRoot,
        ),
        observedTargetReads: resolvedResponse.observedTargetReads,
      };
    }

    throw createRuntimeResponseError(resolvedResponse.error, {
      absolutePath: script.absolutePath,
      modId: script.mod.config.id,
      modName: script.mod.config.name,
      patchId: script.patch?.config.id,
      reason: `Generation script \`${script.config.path}\` threw before returning outputs.`,
      suggestion: runtimeFailureSuggestion,
    });
  } finally {
    await removeExchangeRoot(exchangeRoot);
  }
}

function isScriptRuntimeResponse(message: unknown): message is ScriptRuntimeResponse {
  return isRuntimeResponse<ScriptRuntimeSuccessPayload>(message, (candidate) =>
    Boolean(Array.isArray(candidate.outputs) && Array.isArray(candidate.observedTargetReads)),
  );
}
