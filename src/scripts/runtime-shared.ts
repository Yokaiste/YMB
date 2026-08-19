import { setTimeout as delay } from 'node:timers/promises';
import { ScriptToolError } from 'ymb/api';
import { YmbError } from '../errors.ts';
import type { ErrorCategory, ErrorContext, ScriptApplication } from '../types.ts';

export function formatUnknownRuntimeError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

export interface RuntimeErrorPayload {
  category?: ErrorCategory | undefined;
  context?: ErrorContext | undefined;
  message: string;
}

type RuntimeSuccessResponse<T extends object> = { ok: true } & T;
interface RuntimeFailureResponse {
  ok: false;
  error: RuntimeErrorPayload;
}

export type RuntimeResponse<T extends object> = RuntimeSuccessResponse<T> | RuntimeFailureResponse;

export function serializeRuntimeError(
  error: unknown,
  fallbackContext: ErrorContext,
): RuntimeErrorPayload {
  if (error instanceof YmbError) {
    return { category: error.category, context: error.context, message: error.message };
  }

  const message = formatUnknownRuntimeError(error);
  return {
    message,
    context: {
      ...fallbackContext,
      details: [...(fallbackContext.details ?? []), message],
    },
  };
}

export function createRuntimeResponseError(
  error: RuntimeErrorPayload,
  fallbackContext: ErrorContext,
): YmbError {
  if (error.category && error.context) {
    return new YmbError(error.category, error.context);
  }
  return new YmbError('ScriptError', {
    ...fallbackContext,
    details: [...(fallbackContext.details ?? []), error.message],
  });
}

export function isRuntimeResponse<T extends object>(
  message: unknown,
  isSuccessPayload: (candidate: Record<string, unknown>) => boolean,
): message is RuntimeResponse<T> {
  if (typeof message !== 'object' || message === null || !('ok' in message)) return false;

  const candidate = message as { error?: unknown; ok?: unknown };
  if (candidate.ok === true) {
    return isSuccessPayload(message as Record<string, unknown>);
  }
  if (candidate.ok !== false || typeof candidate.error !== 'object' || candidate.error === null) {
    return false;
  }
  return (
    'message' in candidate.error &&
    typeof (candidate.error as { message?: unknown }).message === 'string'
  );
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

export function setScriptTimeoutSecondsForTests(seconds?: number): void {
  scriptTimeoutSecondsOverride = seconds;
}

interface IpcChildErrorContext {
  absolutePath: string;
  modId: string;
  modName: string;
  patchId?: string | undefined;
  subjectLabel: string;
}

async function awaitChildExitWithTimeout(
  child: { exited: Promise<number>; kill(): void },
  errorContext: IpcChildErrorContext,
  timeoutSeconds: number,
): Promise<number> {
  const effectiveTimeoutSeconds = scriptTimeoutSecondsOverride ?? timeoutSeconds;
  const timeoutMs = effectiveTimeoutSeconds * 1000;
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
      reason: `${errorContext.subjectLabel} timed out after ${effectiveTimeoutSeconds}s and was terminated.`,
      suggestion:
        'Make sure the script terminates: remove infinite loops, unbounded waits, and network calls that never resolve.',
    });
  }

  return typeof exitCode === 'number' ? exitCode : child.exited;
}

async function awaitIpcChildResult<T>(
  child: {
    exited: Promise<number>;
    kill(): void;
    stderr: ReadableStream<Uint8Array> | null;
  },
  responsePromise: Promise<T>,
  errorContext: IpcChildErrorContext,
  timeoutSeconds: number,
): Promise<{ exitCode: number; response: T | undefined; stderrText: string }> {
  // Drain stderr immediately. Waiting until after exit can deadlock a verbose
  // child once the OS pipe buffer fills.
  const stderrPromise = child.stderr
    ? new Response(child.stderr).text().then((text) => text.trim())
    : Promise.resolve('');
  const exitCode = await awaitChildExitWithTimeout(child, errorContext, timeoutSeconds);
  const response = await Promise.race([
    responsePromise,
    delay(exitCode === 0 ? 250 : 50).then(() => undefined),
  ]);
  return { exitCode, response, stderrText: await stderrPromise };
}

/** Spawn a YMB IPC worker, send one request, and await its single reply. */
export async function runIpcWorker<TRequest extends object, TResponse>(options: {
  childPath: string;
  cwd: string;
  request: TRequest;
  isResponse: (message: unknown) => message is TResponse;
  errorContext: IpcChildErrorContext;
  timeoutSeconds: number;
}): Promise<{ exitCode: number; response: TResponse | undefined; stderrText: string }> {
  let resolveResponse: ((response: TResponse) => void) | undefined;
  const responsePromise = new Promise<TResponse>((resolve) => {
    resolveResponse = resolve;
  });
  const child = Bun.spawn([process.execPath, options.childPath], {
    cwd: options.cwd,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
    ipc(message) {
      if (options.isResponse(message)) {
        resolveResponse?.(message);
      }
    },
  });
  child.send(options.request);

  return await awaitIpcChildResult(
    child,
    responsePromise,
    options.errorContext,
    options.timeoutSeconds,
  );
}

/**
 * Later messages are ignored, and a failed reply still exits non-zero so the parent
 * reports the worker as failed instead of hanging.
 */
export function handleIpcRequestOnce<TRequest>(
  respond: (message: TRequest) => Promise<object>,
  serializeFailure: (message: TRequest, error: unknown) => object,
): void {
  let handledRequest = false;
  process.on('message', async (message: TRequest) => {
    if (handledRequest) {
      return;
    }
    handledRequest = true;

    let response: object;
    try {
      response = await respond(message);
    } catch (error) {
      process.exitCode = 1;
      await sendIpcResponse(serializeFailure(message, error)).catch(() => undefined);
      process.disconnect?.();
      return;
    }

    try {
      await sendIpcResponse(response);
      process.exitCode = 0;
    } catch {
      process.exitCode = 1;
    }
    process.disconnect?.();
  });
}

async function sendIpcResponse(message: object): Promise<void> {
  if (!process.send) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
