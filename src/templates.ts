import path from 'node:path';
import { resolveTemplateValue } from './template-resolution.ts';
import type { BuilderContext, DiscoveredMod, DiscoveredPatch } from './types.ts';

export function createTemplateVariables(
  context: BuilderContext,
  mod: Pick<DiscoveredMod, 'config' | 'readValues'>,
  patch?: Pick<DiscoveredPatch, 'config' | 'readValues'>,
): Record<string, unknown> {
  const rawVariables = {
    // Values read out of the game come first so a variable can be built from
    // one, and so an author who names a variable the same thing still wins.
    ...(mod.readValues ?? {}),
    ...(patch?.readValues ?? {}),
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
