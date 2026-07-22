import { sendIpcResponse } from '../scripts/runtime-shared.ts';
import { materializePatchGroupOutput } from './materialize.ts';
import { type PatchRuntimeRequest, serializePatchRuntimeError } from './patch-runtime.ts';
import type { MaterializationMetrics } from './types.ts';

let handledRequest = false;

process.on('message', async (message: PatchRuntimeRequest) => {
  if (handledRequest) return;
  handledRequest = true;

  const metrics: MaterializationMetrics = {
    patchCacheHits: 0,
    patchCacheMisses: 0,
    patchCacheBypassed: 0,
    mergedCacheHits: 0,
    mergedCacheMisses: 0,
  };
  try {
    const writtenFile = await materializePatchGroupOutput(
      message.plan,
      message.patchGroup,
      new Map(),
      metrics,
    );
    await sendIpcResponse({ ok: true, writtenFile, metrics });
    process.disconnect?.();
    process.exitCode = 0;
  } catch (error) {
    await sendIpcResponse({ ok: false, error: serializePatchRuntimeError(error) });
    process.disconnect?.();
    process.exitCode = 1;
  }
});
