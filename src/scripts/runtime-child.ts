import type { GeneratedScriptFile, WrittenBuildFile } from '../types.ts';
import {
  executeScriptInProcess,
  type ScriptRuntimeRequest,
  serializeScriptRuntimeError,
} from './runtime.ts';
import { sendIpcResponse } from './runtime-shared.ts';

let handledRequest = false;

process.on('message', async (message: ScriptRuntimeRequest) => {
  if (handledRequest) {
    return;
  }
  handledRequest = true;

  const { plan, script, outputEntries } = message;
  const outputMap = new Map<string, WrittenBuildFile>(outputEntries);
  try {
    const outputs = await executeScriptInProcess(plan, script, outputMap);
    await sendIpcResponse({
      ok: true,
      outputs,
    } satisfies { ok: true; outputs: GeneratedScriptFile[] });
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
