import { toPathKey } from '../path-utils.ts';
import type { WrittenBuildFile } from '../types.ts';
import { readExchangedFiles } from './runtime-exchange.ts';
import { handleIpcRequestOnce } from './runtime-shared.ts';
import {
  executeScriptTestInProcess,
  type ScriptTestRuntimeRequest,
  serializeScriptTestRuntimeError,
} from './test-runtime.ts';

handleIpcRequestOnce<ScriptTestRuntimeRequest>(
  async ({ plan, script, testAbsolutePath, outputFiles, exchangeRoot }) => {
    const outputMap = new Map<string, WrittenBuildFile>(
      (await readExchangedFiles<WrittenBuildFile>(outputFiles, exchangeRoot)).map((file) => [
        toPathKey(file.targetRelativePath),
        file,
      ]),
    );
    const executed = await executeScriptTestInProcess(plan, script, testAbsolutePath, outputMap);
    return {
      ok: true,
      results: executed.results,
      observedTargetReads: executed.observedTargetReads,
      observedScriptFileReads: executed.observedScriptFileReads,
    };
  },
  ({ script, testAbsolutePath }, error) => ({
    ok: false,
    error: serializeScriptTestRuntimeError(script, testAbsolutePath, error),
  }),
);
