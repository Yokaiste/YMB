import { toPathKey } from '../path-utils.ts';
import type { WrittenBuildFile } from '../types.ts';
import {
  executeScriptInProcess,
  type ScriptRuntimeRequest,
  serializeScriptRuntimeError,
} from './runtime.ts';
import { readExchangedFiles, writeExchangedFiles } from './runtime-exchange.ts';
import { handleIpcRequestOnce } from './runtime-shared.ts';

handleIpcRequestOnce<ScriptRuntimeRequest>(
  async ({ plan, script, outputFiles, exchangeRoot }) => {
    const outputMap = new Map<string, WrittenBuildFile>(
      (await readExchangedFiles<WrittenBuildFile>(outputFiles, exchangeRoot)).map((file) => [
        toPathKey(file.targetRelativePath),
        file,
      ]),
    );
    const execution = await executeScriptInProcess(plan, script, outputMap);
    return {
      ok: true,
      outputs: await writeExchangedFiles(execution.outputs, exchangeRoot, 'output'),
      observedTargetReads: execution.observedTargetReads,
    };
  },
  ({ script }, error) => ({ ok: false, error: serializeScriptRuntimeError(script, error) }),
);
