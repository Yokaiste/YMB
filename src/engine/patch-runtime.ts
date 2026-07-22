import { availableParallelism } from 'node:os';
import { YmbError } from '../errors.ts';
import { resolveRuntimeEntrypoint } from '../runtime-entrypoint.ts';
import { awaitIpcChildResult, formatUnknownRuntimeError } from '../scripts/runtime-shared.ts';
import type { BuildPlan, ErrorCategory, ErrorContext, WrittenBuildFile } from '../types.ts';
import type { MaterializationMetrics, ResolvedPatchContribution } from './types.ts';

const patchRuntimeChildPath = resolveRuntimeEntrypoint(import.meta.url, 'patch-runtime-child');

export interface PatchRuntimeRequest {
  plan: BuildPlan;
  patchGroup: ResolvedPatchContribution[];
}

interface PatchRuntimeErrorPayload {
  category?: ErrorCategory | undefined;
  context?: ErrorContext | undefined;
  message: string;
}

export type PatchRuntimeResponse =
  | { ok: true; writtenFile: WrittenBuildFile; metrics: MaterializationMetrics }
  | { ok: false; error: PatchRuntimeErrorPayload };

export function resolvePatchWorkerCount(
  jobCount: number,
  parallelism = availableParallelism(),
): number {
  if (jobCount < 2) {
    return 1;
  }
  return Math.max(1, Math.min(16, jobCount, parallelism - 1));
}

export async function runPatchGroupInSubprocess(
  request: PatchRuntimeRequest,
): Promise<Extract<PatchRuntimeResponse, { ok: true }>> {
  const firstContribution = request.patchGroup[0];
  const targetRelativePath = firstContribution?.targetRelativePath ?? '<patch-group>';
  const mod = firstContribution?.application.mod;
  let resolveResponse: ((response: PatchRuntimeResponse) => void) | undefined;
  const responsePromise = new Promise<PatchRuntimeResponse>((resolve) => {
    resolveResponse = resolve;
  });
  const child = Bun.spawn([process.execPath, patchRuntimeChildPath], {
    cwd: request.plan.context.ymbRoot,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
    ipc(message) {
      if (isPatchRuntimeResponse(message)) {
        resolveResponse?.(message);
      }
    },
  });
  child.send(request);

  const { exitCode, response, stderrText } = await awaitIpcChildResult(child, responsePromise, {
    absolutePath: targetRelativePath,
    modId: mod?.config.id ?? '<unknown>',
    modName: mod?.config.name ?? '<unknown>',
    subjectLabel: `Patch worker for \`${targetRelativePath}\``,
  });

  if (response?.ok) {
    return response;
  }
  if (response && !response.ok && response.error.category && response.error.context) {
    throw new YmbError(response.error.category, response.error.context);
  }
  const childMessage = response && !response.ok ? response.error.message : undefined;
  throw new YmbError('IoError', {
    absolutePath: targetRelativePath,
    modId: mod?.config.id,
    modName: mod?.config.name,
    reason: `Patch worker exited before returning \`${targetRelativePath}\`.`,
    suggestion: 'Re-run the build. If it persists, inspect the patch target and worker error.',
    details: [
      `Exit code: ${exitCode}`,
      ...(childMessage ? [childMessage] : []),
      ...(stderrText ? [stderrText] : []),
    ],
  });
}

export function serializePatchRuntimeError(error: unknown): PatchRuntimeErrorPayload {
  if (error instanceof YmbError) {
    return { category: error.category, context: error.context, message: error.message };
  }
  return { message: formatUnknownRuntimeError(error) };
}

function isPatchRuntimeResponse(message: unknown): message is PatchRuntimeResponse {
  if (typeof message !== 'object' || message === null || !('ok' in message)) {
    return false;
  }
  const candidate = message as Partial<PatchRuntimeResponse>;
  return candidate.ok === true
    ? typeof candidate.writtenFile === 'object' && candidate.writtenFile !== null
    : candidate.ok === false &&
        typeof candidate.error === 'object' &&
        candidate.error !== null &&
        typeof candidate.error.message === 'string';
}
