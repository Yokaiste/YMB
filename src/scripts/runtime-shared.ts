import { setTimeout as delay } from 'node:timers/promises';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { YmbError } from '../errors.ts';
import type { ScriptApplication } from '../types.ts';
import { ScriptToolError } from './tool-error.ts';

export function formatUnknownRuntimeError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

export function createScriptExecutionError(
  script: ScriptApplication,
  error: unknown,
  defaults: {
    absolutePath: string;
    reason: string;
    suggestion: string;
    details?: string[] | undefined;
  },
): YmbError {
  if (error instanceof YmbError) {
    return error;
  }

  const toolOptions = error instanceof ScriptToolError ? error.options : undefined;
  return new YmbError('ScriptError', {
    absolutePath: toolOptions?.absolutePath ?? defaults.absolutePath,
    modId: script.mod.config.id,
    modName: script.mod.config.name,
    patchId: script.patch?.config.id,
    reason: toolOptions?.reason ?? defaults.reason,
    suggestion: toolOptions?.suggestion ?? defaults.suggestion,
    details: [
      ...(defaults.details ?? []),
      ...(toolOptions?.details ?? []),
      ...(toolOptions ? [] : [formatUnknownRuntimeError(error)]),
    ],
  });
}

let scriptTimeoutSecondsOverride: number | undefined;

export function setScriptTimeoutSecondsForTesting(seconds?: number): void {
  scriptTimeoutSecondsOverride = seconds;
}

export async function awaitChildExitWithTimeout(
  child: { exited: Promise<number>; kill(): void },
  errorContext: {
    absolutePath: string;
    modId: string;
    modName: string;
    patchId?: string | undefined;
    subjectLabel: string;
  },
): Promise<number> {
  const timeoutSeconds = scriptTimeoutSecondsOverride ?? BUILDER_CONFIG.scriptTimeoutSeconds;
  const timeoutMs = timeoutSeconds * 1000;
  const timeoutController = new AbortController();
  const exitCode = await Promise.race([
    child.exited.finally(() => timeoutController.abort()),
    delay(timeoutMs, 'timeout', { signal: timeoutController.signal }).catch(() => undefined),
  ]);

  if (exitCode === 'timeout') {
    child.kill();
    await child.exited.catch(() => undefined);
    throw new YmbError('ScriptError', {
      absolutePath: errorContext.absolutePath,
      modId: errorContext.modId,
      modName: errorContext.modName,
      patchId: errorContext.patchId,
      reason: `${errorContext.subjectLabel} timed out after ${timeoutSeconds}s and was terminated.`,
      suggestion:
        'Make sure the script terminates: remove infinite loops, unbounded waits, and network calls that never resolve.',
    });
  }

  return typeof exitCode === 'number' ? exitCode : child.exited;
}

export async function awaitIpcChildResult<T>(
  child: {
    exited: Promise<number>;
    kill(): void;
    stderr: ReadableStream<Uint8Array> | null;
  },
  responsePromise: Promise<T>,
  errorContext: Parameters<typeof awaitChildExitWithTimeout>[1],
): Promise<{ exitCode: number; response: T | undefined; stderrText: string }> {
  // Drain stderr immediately. Waiting until after exit can deadlock a verbose
  // child once the OS pipe buffer fills.
  const stderrPromise = child.stderr
    ? new Response(child.stderr).text().then((text) => text.trim())
    : Promise.resolve('');
  const exitCode = await awaitChildExitWithTimeout(child, errorContext);
  const response = await Promise.race([
    responsePromise,
    delay(exitCode === 0 ? 250 : 50).then(() => undefined),
  ]);
  return { exitCode, response, stderrText: await stderrPromise };
}

export async function sendIpcResponse(message: unknown): Promise<void> {
  if (!process.send) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const send = process.send as unknown as (
      payload: unknown,
      callback?: (error: Error | null) => void,
    ) => unknown;
    send(message, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
