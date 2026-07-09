import path from 'node:path';
import type { CooperativeYieldController } from '../async.ts';
import { BUILDER_CONFIG, BUILDER_TEMP_PREFIXES } from '../builder-config.ts';
import { listFilesRecursive, loadPatchConfig } from '../config.ts';
import { ensure } from '../errors.ts';
import { normalizeRelativePath } from '../path-utils.ts';
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

  const allFiles = await listFilesRecursive(patchRoot, {
    skipDirectoryNamesStartingWith: [...BUILDER_TEMP_PREFIXES],
    skipFileNamesStartingWith: [...BUILDER_TEMP_PREFIXES],
    includeBaseNames: new Set([BUILDER_CONFIG.patchConfigFileName.toLowerCase()]),
  });
  const patchConfigPaths = allFiles;

  const patches: DiscoveredPatch[] = [];
  const patchIds = new Map<string, string>();

  for (const patchConfigPath of patchConfigPaths) {
    await yieldController?.maybeYield();
    const patchAbsolutePath = path.dirname(patchConfigPath);
    const patchConfig = await loadPatchConfig(patchConfigPath);
    const existing = patchIds.get(patchConfig.id);

    ensure(!existing, 'ConfigError', {
      absolutePath: patchConfigPath,
      modId,
      modName,
      patchId: patchConfig.id,
      reason: `Patch id \`${patchConfig.id}\` is used more than once inside source mod \`${modId}\`.`,
      suggestion: `Give each patch a unique permanent \`id\` in \`${BUILDER_CONFIG.patchConfigFileName}\`.`,
      details: existing ? [`First definition: ${existing}`] : undefined,
    });

    patchIds.set(patchConfig.id, patchConfigPath);
    patches.push({
      config: patchConfig,
      absolutePath: patchAbsolutePath,
      relativePathInMod: normalizeRelativePath(path.relative(modRoot, patchAbsolutePath)),
      absoluteConfigPath: patchConfigPath,
    });
  }

  return patches;
}
