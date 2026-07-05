import type { ScriptTestResult, WrittenBuildFile } from '../types.ts';
import { sendIpcResponse } from './runtime-shared.ts';
import {
  executeScriptTestInProcess,
  type ScriptTestRuntimeRequest,
  serializeScriptTestRuntimeError,
} from './test-runtime.ts';

let handledRequest = false;

process.on('message', async (message: ScriptTestRuntimeRequest) => {
  if (handledRequest) {
    return;
  }
  handledRequest = true;

  const { plan, script, testAbsolutePath, outputEntries } = message;
  const outputMap = new Map<string, WrittenBuildFile>(outputEntries);
  try {
    const results = await executeScriptTestInProcess(plan, script, testAbsolutePath, outputMap);
    await sendIpcResponse({
      ok: true,
      results,
    } satisfies { ok: true; results: ScriptTestResult[] });
    process.disconnect?.();
    process.exitCode = 0;
  } catch (error) {
    await sendIpcResponse({
      ok: false,
      error: serializeScriptTestRuntimeError(script, testAbsolutePath, error),
    } satisfies {
      ok: false;
      error: ReturnType<typeof serializeScriptTestRuntimeError>;
    });
    process.disconnect?.();
    process.exitCode = 1;
  }
});
