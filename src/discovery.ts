import path from 'node:path';
import type { CooperativeYieldController } from './async.ts';
import { BUILDER_CONFIG } from './builder-config.ts';
import { loadModConfig } from './config/load.ts';
import { resolveReadValues } from './config/read-values.ts';
import { collectModLayouts } from './discovery/layout.ts';
import { discoverPatches } from './discovery/patches.ts';
import { createErrorCollector, ensure } from './errors.ts';
import { normalizeRelativePath } from './path-utils.ts';
import { claimSelectionIdentity } from './selection-filter.ts';
import type { BuilderContext, DiscoveredMod } from './types.ts';

export async function discoverMods(
  context: BuilderContext,
  yieldController?: CooperativeYieldController,
): Promise<DiscoveredMod[]> {
  const modLayouts = await collectModLayouts(context.modsRoot);
  const discoveredMods: DiscoveredMod[] = [];
  const modIds = new Map<string, string>();
  // A broken config in one mod says nothing about the next one, and a modder
  // with several checked out should see every problem at once.
  const failures = createErrorCollector();

  for (const modLayout of modLayouts) {
    await yieldController?.maybeYield();
    await failures.collect(async () => {
      const modConfig = await loadModConfig(modLayout.configFilePath);
      const existing = claimSelectionIdentity(modIds, modConfig.id, modLayout.configFilePath);

      ensure(!existing, 'ConfigError', {
        absolutePath: modLayout.configFilePath,
        modId: modConfig.id,
        modName: modConfig.name,
        reason: `Source mod id \`${modConfig.id}\` is used more than once.`,
        suggestion: `Give each source mod a unique permanent \`id\` in \`${BUILDER_CONFIG.modConfigFileName}\`.`,
        details: existing ? [`First definition: ${existing}`] : undefined,
      });

      const patches = await discoverPatches(
        modLayout.modAbsolutePath,
        modLayout.patchAbsolutePath,
        modConfig.id,
        modConfig.name,
        yieldController,
      );

      const modReadValues = await resolveReadValues(modConfig.readValues, context, {
        absolutePath: modLayout.configFilePath,
        modId: modConfig.id,
        modName: modConfig.name,
      });
      for (const patch of patches) {
        patch.readValues = await resolveReadValues(patch.config.readValues, context, {
          absolutePath: patch.configFilePath,
          modId: modConfig.id,
          modName: modConfig.name,
          patchId: patch.config.id,
        });
      }

      discoveredMods.push({
        config: modConfig,
        readValues: modReadValues,
        absolutePath: modLayout.modAbsolutePath,
        configDirectoryPath: modLayout.configDirectoryPath,
        relativePathFromMods: normalizeRelativePath(
          path.relative(context.modsRoot, modLayout.modAbsolutePath),
        ),
        configFilePath: modLayout.configFilePath,
        patches,
        replaceAbsolutePath: modLayout.replaceAbsolutePath,
      });
    });
  }

  failures.throwIfFailed();
  return discoveredMods.sort((left, right) => left.config.id.localeCompare(right.config.id));
}
