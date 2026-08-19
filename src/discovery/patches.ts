import path from 'node:path';
import type { CooperativeYieldController } from '../async.ts';
import { BUILDER_CONFIG, BUILDER_TEMP_PREFIXES } from '../builder-config.ts';
import { listFilesRecursive } from '../config/layout.ts';
import { loadPatchConfig } from '../config/load.ts';
import { createErrorCollector, ensure } from '../errors.ts';
import { normalizeRelativePath } from '../path-utils.ts';
import { claimSelectionIdentity } from '../selection-filter.ts';
import type { DiscoveredPatch } from '../types.ts';

export async function discoverPatches(
  modRoot: string,
  patchRoot: string | undefined,
  modId: string,
  modName: string,
  yieldController?: CooperativeYieldController,
): Promise<DiscoveredPatch[]> {
  if (!patchRoot) {
    return [];
  }

  const patchConfigPaths = await listFilesRecursive(patchRoot, {
    skipDirectoryNamesStartingWith: [...BUILDER_TEMP_PREFIXES],
    skipFileNamesStartingWith: [...BUILDER_TEMP_PREFIXES],
    includeBaseNames: new Set([BUILDER_CONFIG.patchConfigFileName.toLowerCase()]),
  });

  const patches: DiscoveredPatch[] = [];
  const patchIds = new Map<string, string>();
  // Patch configs are independent files, so one bad one must not hide the rest.
  const failures = createErrorCollector();

  for (const patchConfigPath of patchConfigPaths) {
    await yieldController?.maybeYield();
    await failures.collect(async () => {
      const patchAbsolutePath = path.dirname(patchConfigPath);
      const patchConfig = await loadPatchConfig(patchConfigPath);
      const existing = claimSelectionIdentity(patchIds, patchConfig.id, patchConfigPath);

      ensure(!existing, 'ConfigError', {
        absolutePath: patchConfigPath,
        modId,
        modName,
        patchId: patchConfig.id,
        reason: `Patch id \`${patchConfig.id}\` is used more than once inside source mod \`${modId}\`.`,
        suggestion: `Give each patch a unique permanent \`id\` in \`${BUILDER_CONFIG.patchConfigFileName}\`.`,
        details: existing ? [`First definition: ${existing}`] : undefined,
      });

      patches.push({
        config: patchConfig,
        absolutePath: patchAbsolutePath,
        relativePathInMod: normalizeRelativePath(path.relative(modRoot, patchAbsolutePath)),
        configFilePath: patchConfigPath,
      });
    });
  }

  failures.throwIfFailed();
  return patches;
}
