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
      const customization = context.builderConfig.mods?.[modConfig.id];
      modConfig.enabled = customization?.enabled ?? modConfig.enabled;
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

      for (const patchId of Object.keys(customization?.patches ?? {})) {
        ensure(
          patches.some((patch) => patch.config.id === patchId),
          'ConfigError',
          {
            absolutePath: context.builderConfigPath,
            modId: modConfig.id,
            patchId,
            reason: `Customization names an unknown patch: ${patchId}.`,
            suggestion:
              'Use the permanent patch id from its ymb.patch.yaml, or remove the override.',
          },
        );
      }
      const modReadValues = await resolveReadValues(
        modConfig.enabled ? modConfig.readValues : undefined,
        context,
        {
          absolutePath: modLayout.configFilePath,
          modId: modConfig.id,
          modName: modConfig.name,
        },
      );
      for (const patch of patches) {
        patch.config.enabled =
          customization?.patches?.[patch.config.id]?.enabled ?? patch.config.enabled;
        patch.readValues = await resolveReadValues(
          modConfig.enabled && patch.config.enabled ? patch.config.readValues : undefined,
          context,
          {
            absolutePath: patch.configFilePath,
            modId: modConfig.id,
            modName: modConfig.name,
            patchId: patch.config.id,
          },
        );
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
  for (const modId of Object.keys(context.builderConfig.mods ?? {})) {
    ensure(
      discoveredMods.some((mod) => mod.config.id === modId),
      'ConfigError',
      {
        absolutePath: context.builderConfigPath,
        modId,
        reason: `Customization names an unknown mod: ${modId}.`,
        suggestion:
          'Use the permanent id from its ymb.mod.yaml, or remove the override for the missing mod.',
      },
    );
  }
  return discoveredMods.sort((left, right) => left.config.id.localeCompare(right.config.id));
}
