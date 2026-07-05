import path from 'node:path';
import { resolveTemplateValue } from './template-resolution.ts';
import type { BuilderContext, DiscoveredMod, DiscoveredPatch } from './types.ts';

export function createTemplateVariables(
  context: BuilderContext,
  mod: Pick<DiscoveredMod, 'config'>,
  patch?: Pick<DiscoveredPatch, 'config'>,
): Record<string, unknown> {
  const rawVariables = {
    ...(mod.config.variables ?? {}),
    ...(patch?.config.variables ?? {}),
    modRootName: path.basename(context.modRoot),
    modId: mod.config.id,
    modName: mod.config.name,
    modDescription: mod.config.description ?? '',
    patchId: patch?.config.id ?? '',
    patchName: patch?.config.name ?? '',
    patchDescription: patch?.config.description ?? '',
  };

  return Object.fromEntries(
    Object.entries(rawVariables).map(([key, value]) => [
      key,
      resolveTemplateValue(value, rawVariables),
    ]),
  );
}
export { resolveTemplateValue } from './template-resolution.ts';
