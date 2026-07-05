import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashText } from '../engine/shared.ts';
import { YmbError } from '../errors.ts';
import type { BuildScriptModule, BuildScriptTestModule, ScriptApplication } from '../types.ts';

export async function importScriptModule(
  script: ScriptApplication,
  useCache: boolean,
): Promise<BuildScriptModule> {
  return await importRuntimeModule<BuildScriptModule>({
    absolutePath: script.absolutePath,
    useCache,
    errorContext: buildRuntimeModuleErrorContext(
      script.absolutePath,
      script.mod.config.id,
      script.mod.config.name,
      script.patch?.config.id,
      `Failed to import generation script \`${script.config.path}\`.`,
      'Fix the script syntax/runtime imports and try again.',
    ),
  });
}

export async function importScriptTestModule(args: {
  script: ScriptApplication;
  testAbsolutePath: string;
  useCache: boolean;
}): Promise<BuildScriptTestModule> {
  return await importRuntimeModule<BuildScriptTestModule>({
    absolutePath: args.testAbsolutePath,
    useCache: args.useCache,
    errorContext: buildRuntimeModuleErrorContext(
      args.testAbsolutePath,
      args.script.mod.config.id,
      args.script.mod.config.name,
      args.script.patch?.config.id,
      `Failed to import script test \`${path.basename(args.testAbsolutePath)}\`.`,
      'Fix the script test syntax/runtime imports and try again.',
      [`Script under test: ${args.script.absolutePath}`],
    ),
  });
}

async function importRuntimeModule<T>(args: {
  absolutePath: string;
  useCache: boolean;
  errorContext: {
    absolutePath: string;
    modId?: string;
    modName?: string;
    patchId?: string;
    reason: string;
    suggestion: string;
    details?: string[];
  };
}): Promise<T> {
  try {
    const scriptSource = await Bun.file(args.absolutePath).text();
    return await importRuntimeScript<T>(args.absolutePath, scriptSource, args.useCache);
  } catch (error) {
    throw new YmbError('ScriptError', {
      ...args.errorContext,
      details: [
        ...(args.errorContext.details ?? []),
        error instanceof Error ? error.message : String(error),
      ],
    });
  }
}

async function importRuntimeScript<T>(
  absolutePath: string,
  scriptSource: string,
  useCache: boolean,
): Promise<T> {
  const importUrl = pathToFileURL(absolutePath);
  importUrl.searchParams.set(
    'ymb-runtime',
    useCache ? hashText(`${absolutePath}\n${scriptSource}`) : `${Date.now()}`,
  );
  return (await import(importUrl.href)) as T;
}

function buildRuntimeModuleErrorContext(
  absolutePath: string,
  modId: string,
  modName: string,
  patchId: string | undefined,
  reason: string,
  suggestion: string,
  details?: string[],
): {
  absolutePath: string;
  modId: string;
  modName: string;
  patchId?: string;
  reason: string;
  suggestion: string;
  details?: string[];
} {
  return {
    absolutePath,
    modId,
    modName,
    ...(patchId ? { patchId } : {}),
    reason,
    suggestion,
    ...(details ? { details } : {}),
  };
}
