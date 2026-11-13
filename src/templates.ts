import path from 'node:path';
import { resolveTemplateValue } from './template-resolution.ts';
import type { BuilderContext, DiscoveredMod, DiscoveredPatch } from './types.ts';

export function createTemplateVariables(
  context: BuilderContext,
  mod: Pick<DiscoveredMod, 'config' | 'readValues'>,
  patch?: Pick<DiscoveredPatch, 'config' | 'readValues'>,
): Record<string, unknown> {
  const customization = context.builderConfig.mods?.[mod.config.id];
  const rawVariables = {
    // Values read out of the game come first so a variable can be built from
    // one, and so an author who names a variable the same thing still wins.
    ...(mod.readValues ?? {}),
    ...(patch?.readValues ?? {}),
    ...mergeVariables(
      mod.config.variables,
      patch?.config.variables,
      context.builderConfig.variables,
      customization?.variables,
      patch ? customization?.patches?.[patch.config.id]?.variables : undefined,
    ),
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

// Merge objects; replace lists and scalars. Authored inputs are never mutated.
function mergeVariables(
  ...layers: Array<Record<string, unknown> | undefined>
): Record<string, unknown> {
  const result = Object.create(null) as Record<string, unknown>;
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer ?? {})) {
      const previous = result[key];
      result[key] = isRecord(previous) && isRecord(value) ? mergeVariables(previous, value) : value;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export { resolveTemplateValue } from './template-resolution.ts';
