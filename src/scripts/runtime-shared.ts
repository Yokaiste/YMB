import { setTimeout as delay } from 'node:timers/promises';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { YmbError } from '../errors.ts';

export function formatUnknownRuntimeError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
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
