import type { WrittenBuildFile } from '../types.ts';
import {
  executeScriptInProcess,
  type ScriptRuntimeRequest,
  serializeScriptRuntimeError,
  storeScriptRuntimeOutputs,
} from './runtime.ts';
import { sendIpcResponse } from './runtime-shared.ts';

let handledRequest = false;

process.on('message', async (message: ScriptRuntimeRequest) => {
  if (handledRequest) {
    return;
  }
  handledRequest = true;

  const { plan, script, outputEntries, exchangeRoot } = message;
  const outputMap = new Map<string, WrittenBuildFile>(outputEntries);
  try {
    const outputs = await executeScriptInProcess(plan, script, outputMap);
    const storedOutputs = await storeScriptRuntimeOutputs(outputs, exchangeRoot);
    await sendIpcResponse({
      ok: true,
      outputs: storedOutputs,
    });
    process.disconnect?.();
    process.exitCode = 0;
  } catch (error) {
    await sendIpcResponse({
      ok: false,
      error: serializeScriptRuntimeError(script, error),
    } satisfies {
      ok: false;
      error: ReturnType<typeof serializeScriptRuntimeError>;
    });
    process.disconnect?.();
    process.exitCode = 1;
  }
});
