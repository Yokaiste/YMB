import { writeExchangedFiles } from '../scripts/runtime-exchange.ts';
import { handleIpcRequestOnce } from '../scripts/runtime-shared.ts';
import { materializePatchGroupOutput } from './materialize.ts';
import { createMaterializationMetrics } from './metrics.ts';
import { type PatchRuntimeRequest, serializePatchRuntimeError } from './patch-runtime.ts';

handleIpcRequestOnce<PatchRuntimeRequest>(
  async ({ plan, patchGroup, exchangeRoot }) => {
    const metrics = createMaterializationMetrics();
    const writtenFile = await materializePatchGroupOutput(plan, patchGroup, new Map(), metrics);
    const [exchangedFile] = await writeExchangedFiles([writtenFile], exchangeRoot, 'output');
    return { ok: true, writtenFile: exchangedFile, metrics };
  },
  (_request, error) => ({ ok: false, error: serializePatchRuntimeError(error) }),
);
