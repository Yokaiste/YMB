import { resolveModTargetPath } from '../path-utils.ts';
import type { TextMergeContributor } from '../text-merge.ts';
import { readTrackedText } from '../tracked-targets.ts';
import type { BuildPlan, WrittenBuildFile } from '../types.ts';
import { describeFileOwner } from './contributors.ts';

export interface ScriptTextState {
  baseText: string;
  contributors: TextMergeContributor[];
  writtenFile: WrittenBuildFile;
}

export async function ensureTextState(
  plan: BuildPlan,
  existing: WrittenBuildFile,
  targetRelativePath: string,
  states: Map<string, ScriptTextState>,
  existingGeneratedTextByTarget: Map<string, string>,
  baseTextCache: Map<string, string>,
): Promise<ScriptTextState | undefined> {
  const existingState = states.get(targetRelativePath);
  if (existingState) {
    return existingState;
  }
  if (typeof existing.content !== 'string') {
    return undefined;
  }

  const baseText = await resolveScriptBaseText(
    plan,
    targetRelativePath,
    existingGeneratedTextByTarget,
    existing,
    baseTextCache,
  );
  const state: ScriptTextState = {
    baseText,
    contributors: [
      {
        id: `existing:${targetRelativePath}`,
        label: describeFileOwner(existing),
        content: existing.content,
      },
    ],
    writtenFile: existing,
  };
  states.set(targetRelativePath, state);
  return state;
}

export async function resolveScriptBaseText(
  plan: BuildPlan,
  targetRelativePath: string,
  existingGeneratedTextByTarget: Map<string, string>,
  currentFile: WrittenBuildFile,
  baseTextCache: Map<string, string>,
): Promise<string> {
  const cachedBaseText = baseTextCache.get(targetRelativePath);
  if (cachedBaseText !== undefined) {
    return cachedBaseText;
  }
  const existingGenerated = existingGeneratedTextByTarget.get(targetRelativePath);
  if (existingGenerated !== undefined) {
    baseTextCache.set(targetRelativePath, existingGenerated);
    return existingGenerated;
  }
  if (currentFile.sourceType !== 'script' && typeof currentFile.content === 'string') {
    baseTextCache.set(targetRelativePath, currentFile.content);
    return currentFile.content;
  }

  const absolutePath = resolveModTargetPath(plan.context.modRoot, targetRelativePath);
  const file = Bun.file(absolutePath);
  if (!(await file.exists())) {
    baseTextCache.set(targetRelativePath, '');
    return '';
  }
  const baseText = await readTrackedText(plan.context, absolutePath);
  baseTextCache.set(targetRelativePath, baseText);
  return baseText;
}
