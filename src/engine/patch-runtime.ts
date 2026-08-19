import { availableParallelism } from 'node:os';
import { YmbError } from '../errors.ts';
import { resolveRuntimeEntrypoint } from '../runtime-entrypoint.ts';
import type { Exchanged } from '../scripts/runtime-exchange.ts';
import {
  createExchangeRoot,
  readExchangedFiles,
  removeExchangeRoot,
} from '../scripts/runtime-exchange.ts';
import { formatUnknownRuntimeError, runIpcWorker } from '../scripts/runtime-shared.ts';
import type { BuildPlan, ErrorCategory, ErrorContext, WrittenBuildFile } from '../types.ts';
import type { MaterializationMetrics, ResolvedPatchContribution } from './types.ts';

const patchRuntimeChildPath = resolveRuntimeEntrypoint(import.meta.url, 'patch-runtime-child');

export interface PatchRuntimeRequest {
  plan: BuildPlan;
  patchGroup: ResolvedPatchContribution[];
  exchangeRoot: string;
}

interface PatchRuntimeErrorPayload {
  category?: ErrorCategory | undefined;
  context?: ErrorContext | undefined;
  message: string;
}

type PatchRuntimeResponse =
  | { ok: true; writtenFile: Exchanged<WrittenBuildFile>; metrics: MaterializationMetrics }
  | { ok: false; error: PatchRuntimeErrorPayload };

interface PatchRuntimeResult {
  writtenFile: WrittenBuildFile;
  metrics: MaterializationMetrics;
}

export function resolvePatchWorkerCount(
  jobCount: number,
  parallelism = availableParallelism(),
): number {
  if (jobCount < 2) {
    return 1;
  }
  return Math.max(1, Math.min(16, jobCount, parallelism - 1));
}

export async function runPatchGroupInSubprocess(request: {
  plan: BuildPlan;
  patchGroup: ResolvedPatchContribution[];
}): Promise<PatchRuntimeResult> {
  const firstContribution = request.patchGroup[0];
  const targetRelativePath = firstContribution?.targetRelativePath ?? '<patch-group>';
  const mod = firstContribution?.application.mod;
  // Sixteen workers each return a whole patched NDF, and the largest game target
  // is 58 MB. Passing those through IPC multiplied the parent's peak by the
  // worker count for the length of the phase.
  const exchangeRoot = await createExchangeRoot();
  try {
    const { exitCode, response, stderrText } = await runIpcWorker<
      PatchRuntimeRequest,
      PatchRuntimeResponse
    >({
      childPath: patchRuntimeChildPath,
      cwd: request.plan.context.ymbRoot,
      request: { ...request, exchangeRoot },
      isResponse: isPatchRuntimeResponse,
      errorContext: {
        absolutePath: targetRelativePath,
        modId: mod?.config.id ?? '<unknown>',
        modName: mod?.config.name ?? '<unknown>',
        subjectLabel: `Patch worker for \`${targetRelativePath}\``,
      },
      timeoutSeconds: request.plan.context.builderConfig.settings.scriptTimeoutSeconds,
    });

    if (response?.ok) {
      const [writtenFile] = await readExchangedFiles<WrittenBuildFile>(
        [response.writtenFile],
        exchangeRoot,
      );
      if (writtenFile) {
        return { writtenFile, metrics: response.metrics };
      }
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
  } finally {
    await removeExchangeRoot(exchangeRoot);
  }
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
