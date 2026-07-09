import { hashBytes, hashText } from '../engine/shared.ts';
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
  observedReads: Map<string, ObservedTargetRead>;
}

export interface ObservedTargetRead {
  targetRelativePath: string;
  readKind: 'text' | 'binary';
  contentHash: string;
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
    const content =
      typeof generated.content === 'string'
        ? generated.content
        : Buffer.from(generated.content).toString('utf8');
    recordObservedRead(state, normalizedPath, 'text', hashText(content));
    return content;
  }

  const replaceFile = findReplaceFile(state.replaceFilesByTarget, normalizedPath);
  if (replaceFile) {
    const content = await readReplacePreviewText(replaceFile);
    recordObservedRead(state, normalizedPath, 'text', hashText(content));
    return content;
  }

  const { absolutePath } = await resolveTargetDiskFile(plan, script, normalizedPath);
  const content = await readTrackedText(plan.context, absolutePath);
  recordObservedRead(state, normalizedPath, 'text', hashText(content));
  return content;
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
    const content =
      typeof generated.content === 'string'
        ? textEncoder.encode(generated.content)
        : generated.content;
    recordObservedRead(state, normalizedPath, 'binary', hashBytes(content));
    return content;
  }

  const replaceFile = findReplaceFile(state.replaceFilesByTarget, normalizedPath);
  if (replaceFile) {
    const content = await readReplacePreviewBinary(replaceFile);
    recordObservedRead(state, normalizedPath, 'binary', hashBytes(content));
    return content;
  }

  const { file } = await resolveTargetDiskFile(plan, script, normalizedPath);
  const content = new Uint8Array(await file.arrayBuffer());
  recordObservedRead(state, normalizedPath, 'binary', hashBytes(content));
  return content;
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
    observedReads: new Map(),
  };
}

export function snapshotObservedTargetReads(state: TargetReaderState): ObservedTargetRead[] {
  return [...state.observedReads.values()].sort((left, right) => {
    if (left.targetRelativePath !== right.targetRelativePath) {
      return left.targetRelativePath.localeCompare(right.targetRelativePath);
    }
    return left.readKind.localeCompare(right.readKind);
  });
}

function recordObservedRead(
  state: TargetReaderState,
  targetRelativePath: string,
  readKind: ObservedTargetRead['readKind'],
  contentHash: string,
): void {
  state.observedReads.set(`${readKind}:${targetRelativePath}`, {
    targetRelativePath,
    readKind,
    contentHash,
  });
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
