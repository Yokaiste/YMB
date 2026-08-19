import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BuildScriptModule, BuildScriptTestModule } from 'ymb/api';
import { YmbError } from '../errors.ts';
import { hashText } from '../hash.ts';
import type { ErrorContext, ScriptApplication } from '../types.ts';

export async function importScriptModule(
  script: ScriptApplication,
  useCache: boolean,
): Promise<BuildScriptModule> {
  return await importRuntimeModule<BuildScriptModule>(script.absolutePath, useCache, {
    absolutePath: script.absolutePath,
    modId: script.mod.config.id,
    modName: script.mod.config.name,
    patchId: script.patch?.config.id,
    reason: `Failed to import generation script \`${script.config.path}\`.`,
    suggestion: 'Fix the script syntax/runtime imports and try again.',
  });
}

export async function importScriptTestModule(args: {
  script: ScriptApplication;
  testAbsolutePath: string;
  useCache: boolean;
}): Promise<BuildScriptTestModule> {
  return await importRuntimeModule<BuildScriptTestModule>(args.testAbsolutePath, args.useCache, {
    absolutePath: args.testAbsolutePath,
    modId: args.script.mod.config.id,
    modName: args.script.mod.config.name,
    patchId: args.script.patch?.config.id,
    reason: `Failed to import script test \`${path.basename(args.testAbsolutePath)}\`.`,
    suggestion: 'Fix the script test syntax/runtime imports and try again.',
    details: [`Script under test: ${args.script.absolutePath}`],
  });
}

async function importRuntimeModule<T>(
  absolutePath: string,
  useCache: boolean,
  errorContext: ErrorContext,
): Promise<T> {
  try {
    const scriptSource = await Bun.file(absolutePath).text();
    return await importRuntimeScript<T>(absolutePath, scriptSource, useCache);
  } catch (error) {
    throw new YmbError('ScriptError', {
      ...errorContext,
      details: [
        ...(errorContext.details ?? []),
        error instanceof Error ? error.message : String(error),
      ],
    });
  }
}

// A timestamp repeats within the same millisecond, which would silently hand back
// the cached module the caller just asked to bypass. A counter cannot collide.
let cacheBustCounter = 0;

async function importRuntimeScript<T>(
  absolutePath: string,
  scriptSource: string,
  useCache: boolean,
): Promise<T> {
  const importUrl = pathToFileURL(absolutePath);
  if (useCache) {
    importUrl.searchParams.set('ymb-runtime', hashText(`${absolutePath}\n${scriptSource}`));
  } else {
    cacheBustCounter += 1;
    importUrl.searchParams.set('ymb-runtime', `${Date.now()}-${cacheBustCounter}`);
  }
  return (await import(importUrl.href)) as T;
}
