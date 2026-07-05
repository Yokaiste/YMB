import { ensure } from '../errors.ts';
import { normalizeRelativePath, resolveModTargetPath } from '../path-utils.ts';
import { resolveTemplateValue } from '../templates.ts';
import { readTrackedText } from '../tracked-targets.ts';
import type {
  ReplaceFile,
  ScriptApplication,
  ScriptRuntimePlan,
  WrittenBuildFile,
} from '../types.ts';

const textEncoder = new TextEncoder();

interface TargetReaderState {
  replaceFilesByTarget: Map<string, ReplaceFile>;
}

export async function readTargetText(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  outputMap: Map<string, WrittenBuildFile>,
  state: TargetReaderState,
  relativePath: string,
): Promise<string> {
  const normalizedPath = normalizeRelativePath(relativePath);
  const generated = outputMap.get(normalizedPath);
  if (generated) {
    return typeof generated.content === 'string'
      ? generated.content
      : Buffer.from(generated.content).toString('utf8');
  }

  const replaceFile = findReplaceFile(state.replaceFilesByTarget, normalizedPath);
  if (replaceFile) {
    return await readReplacePreviewText(replaceFile);
  }

  const { absolutePath } = await resolveTargetDiskFile(plan, script, normalizedPath);
  return await readTrackedText(plan.context, absolutePath);
}

export async function readTargetBinary(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  outputMap: Map<string, WrittenBuildFile>,
  state: TargetReaderState,
  relativePath: string,
): Promise<Uint8Array> {
  const normalizedPath = normalizeRelativePath(relativePath);
  const generated = outputMap.get(normalizedPath);
  if (generated) {
    return typeof generated.content === 'string'
      ? textEncoder.encode(generated.content)
      : generated.content;
  }

  const replaceFile = findReplaceFile(state.replaceFilesByTarget, normalizedPath);
  if (replaceFile) {
    return await readReplacePreviewBinary(replaceFile);
  }

  const { file } = await resolveTargetDiskFile(plan, script, normalizedPath);

  return new Uint8Array(await file.arrayBuffer());
}

function findReplaceFile(
  replaceFilesByTarget: Map<string, ReplaceFile>,
  relativePath: string,
): ReplaceFile | undefined {
  return replaceFilesByTarget.get(normalizeRelativePath(relativePath));
}

export function createTargetReaderState(replaceFiles: ReplaceFile[]): TargetReaderState {
  return {
    replaceFilesByTarget: new Map(
      replaceFiles.map((file) => [normalizeRelativePath(file.targetRelativePath), file] as const),
    ),
  };
}

async function readReplacePreviewText(replaceFile: ReplaceFile): Promise<string> {
  const file = Bun.file(replaceFile.sourceAbsolutePath);
  const resolved = resolveTemplateValue(await file.text(), replaceFile.templateVariables);
  return typeof resolved === 'string' ? resolved : String(resolved ?? '');
}

async function readReplacePreviewBinary(replaceFile: ReplaceFile): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(replaceFile.sourceAbsolutePath).arrayBuffer());
}

async function resolveTargetDiskFile(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
  normalizedPath: string,
): Promise<{ absolutePath: string; file: Bun.BunFile }> {
  const absolutePath = resolveModTargetPath(plan.context.modRoot, normalizedPath);
  const file = Bun.file(absolutePath);
  ensure(await file.exists(), 'IoError', {
    absolutePath,
    modId: script.mod.config.id,
    modName: script.mod.config.name,
    patchId: script.patch?.config.id,
    reason: `Script input \`${normalizedPath}\` does not exist.`,
    suggestion: 'Fix the script input path or generate the dependency target before reading it.',
  });
  return { absolutePath, file };
}
