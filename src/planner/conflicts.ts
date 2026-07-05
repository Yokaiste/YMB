import { YmbError } from '../errors.ts';
import { createTemplateVariables } from '../templates.ts';
import type { BuilderContext, DiscoveredMod, PatchApplication, ReplaceFile } from '../types.ts';
import { resolveSelectedTargetRelativePath } from './selection.ts';

export function detectTargetConflicts(
  context: BuilderContext,
  selectedMods: DiscoveredMod[],
  selectedPatches: PatchApplication[],
  replaceFiles: ReplaceFile[],
): void {
  const selectedModsById = new Map(selectedMods.map((mod) => [mod.config.id, mod] as const));
  const patchOwners = new Map<string, string[]>();

  for (const application of selectedPatches) {
    const templateVariables = createTemplateVariables(context, application.mod, application.patch);
    for (const target of application.patch.config.targets) {
      const normalizedPath = resolveSelectedTargetRelativePath(
        context,
        application,
        target.file,
        templateVariables,
      );
      const owner = `${application.mod.config.id}:${application.patch.config.id}`;
      const owners = patchOwners.get(normalizedPath) ?? [];
      if (!owners.includes(owner)) {
        owners.push(owner);
      }
      patchOwners.set(normalizedPath, owners);
    }
  }

  const replaceOwners = new Map<string, string>();
  for (const replaceFile of replaceFiles) {
    const existingReplace = replaceOwners.get(replaceFile.targetRelativePath);
    if (!existingReplace) {
      replaceOwners.set(replaceFile.targetRelativePath, replaceFile.modId);
    } else if (
      existingReplace === replaceFile.modId ||
      hasDisallowedOrderedCollision(
        selectedModsById.get(existingReplace),
        selectedModsById.get(replaceFile.modId),
      )
    ) {
      throw new YmbError('ConflictError', {
        absolutePath: replaceFile.targetRelativePath,
        modId: replaceFile.modId,
        modName: replaceFile.modName,
        reason: `Two source mods replace the same output path \`${replaceFile.targetRelativePath}\`.`,
        suggestion:
          'Keep exactly one replacement owner for each target path, or set `allowWriteToModifiedFiles: true` on the ordered mods if the later mod is intentionally designed to layer over the earlier one.',
        details: [
          `Existing replace owner mod: ${existingReplace}`,
          `New replace owner mod: ${replaceFile.modId}`,
        ],
      });
    }

    const patchOwnersForTarget = patchOwners.get(replaceFile.targetRelativePath);
    if (
      patchOwnersForTarget?.some((patchOwner) => {
        const [patchOwnerModId] = patchOwner.split(':');
        if (patchOwnerModId === replaceFile.modId) {
          return true;
        }
        return hasDisallowedOrderedCollision(
          selectedModsById.get(patchOwnerModId ?? ''),
          selectedModsById.get(replaceFile.modId),
        );
      })
    ) {
      throw new YmbError('ConflictError', {
        absolutePath: replaceFile.targetRelativePath,
        modId: replaceFile.modId,
        modName: replaceFile.modName,
        reason: `Replace output collides with a generated patch target \`${replaceFile.targetRelativePath}\`.`,
        suggestion:
          'Move the replace file, stop patching the same output path in this build, or set `allowWriteToModifiedFiles: true` on the ordered mods if the later mod is intentionally designed to layer over the earlier one.',
        details: (patchOwnersForTarget ?? []).map((owner) => `Conflicting patch owner: ${owner}`),
      });
    }
  }
}

function hasDisallowedOrderedCollision(
  left: DiscoveredMod | undefined,
  right: DiscoveredMod | undefined,
): boolean {
  if (!left || !right || left.config.id === right.config.id) {
    return false;
  }

  return !canLayerOrderedMods(left, right);
}

function canLayerOrderedMods(left: DiscoveredMod, right: DiscoveredMod): boolean {
  if (!left.config.allowWriteToModifiedFiles || !right.config.allowWriteToModifiedFiles) {
    return false;
  }

  return (
    left.config.priority !== right.config.priority ||
    dependsOnMod(left, right.config.id) ||
    dependsOnMod(right, left.config.id)
  );
}

function dependsOnMod(mod: DiscoveredMod, dependencyModId: string): boolean {
  return mod.config.dependsOn.includes(dependencyModId);
}
