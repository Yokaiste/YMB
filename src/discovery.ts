import path from 'node:path';
import { BUILDER_CONFIG } from './builder-config.ts';
import { loadModConfig } from './config.ts';
import { collectModLayouts } from './discovery/layout.ts';
import { discoverPatches } from './discovery/patches.ts';
import { ensure } from './errors.ts';
import { normalizeRelativePath } from './path-utils.ts';
import type { BuilderContext, DiscoveredMod } from './types.ts';

export async function discoverMods(context: BuilderContext): Promise<DiscoveredMod[]> {
  const modLayouts = await collectModLayouts(context.modsRoot);
  const discoveredMods: DiscoveredMod[] = [];
  const modIds = new Map<string, string>();

  for (const modLayout of modLayouts) {
    const modConfig = await loadModConfig(modLayout.modConfigPath);
    const existing = modIds.get(modConfig.id);

    ensure(!existing, 'ConfigError', {
      absolutePath: modLayout.modConfigPath,
      modId: modConfig.id,
      modName: modConfig.name,
      reason: `Source mod id \`${modConfig.id}\` is used more than once.`,
      suggestion: `Give each source mod a unique permanent \`id\` in \`${BUILDER_CONFIG.modConfigFileName}\`.`,
      details: existing ? [`First definition: ${existing}`] : undefined,
    });

    modIds.set(modConfig.id, modLayout.modConfigPath);

    const patches = await discoverPatches(
      modLayout.modAbsolutePath,
      modLayout.patchAbsolutePath,
      modConfig.id,
      modConfig.name,
    );

    discoveredMods.push({
      config: modConfig,
      absolutePath: modLayout.modAbsolutePath,
      configAbsolutePath: modLayout.configAbsolutePath,
      relativePathFromMods: normalizeRelativePath(
        path.relative(context.modsRoot, modLayout.modAbsolutePath),
      ),
      absoluteConfigPath: modLayout.modConfigPath,
      patches,
      replaceAbsolutePath: modLayout.replaceAbsolutePath,
    });
  }

  return discoveredMods.sort((left, right) => left.config.id.localeCompare(right.config.id));
}
