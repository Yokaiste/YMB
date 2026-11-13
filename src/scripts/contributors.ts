import type { BuildContributor, BuildPlan, WrittenBuildFile } from '../types.ts';

export function describeFileOwner(file: WrittenBuildFile): string {
  const contributors = file.contributors
    .map((item) => `${item.modId}${item.patchId ? `:${item.patchId}` : ''}`)
    .join(', ');
  return `${file.sourceType}:${file.targetRelativePath}:${contributors}`;
}

export function createScriptOutputId(scriptIndex: number, outputIndex: number): string {
  return `${scriptIndex}:${outputIndex}`;
}

export function describeScriptOwner(script: BuildPlan['selectedScripts'][number]): string {
  return script.patch ? `${script.mod.config.id}:${script.patch.config.id}` : script.mod.config.id;
}

export function toContributor(script: BuildPlan['selectedScripts'][number]): BuildContributor {
  return script.patch
    ? {
        modId: script.mod.config.id,
        modName: script.mod.config.name,
        patchId: script.patch.config.id,
      }
    : { modId: script.mod.config.id, modName: script.mod.config.name };
}

export function dedupeScriptContributors(contributors: BuildContributor[]): BuildContributor[] {
  const deduped = new Map<string, BuildContributor>();
  for (const contributor of contributors) {
    deduped.set(`${contributor.modId}:${contributor.patchId ?? ''}`, contributor);
  }
  return [...deduped.values()];
}
