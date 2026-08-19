import type { CooperativeYieldController } from '../async.ts';
import { YmbError } from '../errors.ts';
import { toPathKey } from '../path-utils.ts';
import { createTemplateVariables } from '../templates.ts';
import type {
  BuilderContext,
  DiscoveredMod,
  FileDeletion,
  PatchApplication,
  ReplaceFile,
} from '../types.ts';
import { resolveSelectedTargetRelativePath } from './selection.ts';

export async function detectTargetConflictsCooperative(
  context: BuilderContext,
  selectedMods: DiscoveredMod[],
  selectedPatches: PatchApplication[],
  replaceFiles: ReplaceFile[],
  fileDeletions: FileDeletion[],
  yieldController?: CooperativeYieldController,
): Promise<void> {
  const selectedModsById = new Map(selectedMods.map((mod) => [mod.config.id, mod] as const));
  // Keyed case-insensitively like every path map here, but the authored spelling
  // is kept beside it: an error naming a path the reader has to go and find must
  // print the path as it is written, not as it was folded for comparison.
  const patchOwners = new Map<string, PatchTargetOwners>();

  for (const application of selectedPatches) {
    await yieldController?.maybeYield();
    const templateVariables = createTemplateVariables(context, application.mod, application.patch);
    for (const target of application.patch.config.targets) {
      await yieldController?.maybeYield();
      const normalizedPath = resolveSelectedTargetRelativePath(
        context,
        application,
        target.file,
        templateVariables,
      );
      const owner = `${application.mod.config.id}:${application.patch.config.id}`;
      const targetKey = toPathKey(normalizedPath);
      const entry = patchOwners.get(targetKey) ?? { path: normalizedPath, owners: [] };
      if (!entry.owners.includes(owner)) {
        entry.owners.push(owner);
      }
      patchOwners.set(targetKey, entry);
    }
  }

  // The first mod to claim a target stays its owner, so a third mod must be ordered
  // above the original writer rather than above whoever was processed most recently.
  const replaceOwners = new Map<string, string>();
  for (const replaceFile of replaceFiles) {
    await yieldController?.maybeYield();
    const targetKey = toPathKey(replaceFile.targetRelativePath);
    const existingReplace = replaceOwners.get(targetKey);
    if (!existingReplace) {
      replaceOwners.set(targetKey, replaceFile.modId);
    } else if (existingReplace === replaceFile.modId) {
      // One mod reaching the same target twice is a mistake inside that mod, not
      // a clash between mods, and layering rules cannot resolve it.
      throw new YmbError('ConflictError', {
        absolutePath: replaceFile.targetRelativePath,
        modId: replaceFile.modId,
        modName: replaceFile.modName,
        reason: `Source mod \`${replaceFile.modId}\` writes the same output path \`${replaceFile.targetRelativePath}\` more than once.`,
        suggestion:
          'Keep one writer for each target path. Check the mod `replace` folder and every patch `files` operation for duplicates, including paths that differ only by letter case.',
        details: [`Output path: ${replaceFile.targetRelativePath}`],
      });
    } else if (
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
          'Keep exactly one replacement owner for each target path, or set `allowWriteToModifiedFiles: true` on the later mod if it is intentionally designed to layer over the earlier one.',
        details: [
          `Existing replace owner mod: ${existingReplace}`,
          `New replace owner mod: ${replaceFile.modId}`,
        ],
      });
    }

    const patchOwnersForTarget = patchOwners.get(targetKey)?.owners;
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
          'Move the replace file, stop patching the same output path in this build, or set `allowWriteToModifiedFiles: true` on the later mod if it is intentionally designed to layer over the earlier one.',
        details: (patchOwnersForTarget ?? []).map((owner) => `Conflicting patch owner: ${owner}`),
      });
    }
  }

  for (const deletion of fileDeletions) {
    await yieldController?.maybeYield();
    const targetKey = toPathKey(deletion.targetRelativePath);
    const replaceOwner = replaceOwners.get(targetKey);
    if (replaceOwner) {
      throw new YmbError('ConflictError', {
        absolutePath: deletion.targetRelativePath,
        modId: deletion.modId,
        modName: deletion.modName,
        patchId: deletion.patchId,
        reason: `File deletion collides with a written output at \`${deletion.targetRelativePath}\`.`,
        suggestion: 'Keep either the deletion or the written output, not both.',
        details: [`Written output owner mod: ${replaceOwner}`],
      });
    }

    const patchOwnersForTarget = patchOwners.get(targetKey)?.owners;
    if (patchOwnersForTarget?.length) {
      throw new YmbError('ConflictError', {
        absolutePath: deletion.targetRelativePath,
        modId: deletion.modId,
        modName: deletion.modName,
        patchId: deletion.patchId,
        reason: `File deletion collides with a generated patch target \`${deletion.targetRelativePath}\`.`,
        suggestion: 'Stop patching the file or remove the deletion operation.',
        details: patchOwnersForTarget.map((owner) => `Conflicting patch owner: ${owner}`),
      });
    }
  }

  assertNoHierarchicalTargetCollisions(patchOwners, replaceFiles, fileDeletions);
}

interface PatchTargetOwners {
  path: string;
  owners: string[];
}

function assertNoHierarchicalTargetCollisions(
  patchOwners: ReadonlyMap<string, PatchTargetOwners>,
  replaceFiles: ReplaceFile[],
  fileDeletions: FileDeletion[],
): void {
  const targets = new Map<string, { path: string; owner: string }>();
  for (const [targetKey, entry] of patchOwners) {
    targets.set(targetKey, {
      path: entry.path,
      owner: entry.owners.join(', '),
    });
  }
  for (const file of replaceFiles) {
    targets.set(toPathKey(file.targetRelativePath), {
      path: file.targetRelativePath,
      owner: file.patchId ? `${file.modId}:${file.patchId}` : file.modId,
    });
  }
  for (const deletion of fileDeletions) {
    targets.set(toPathKey(deletion.targetRelativePath), {
      path: deletion.targetRelativePath,
      owner: `${deletion.modId}:${deletion.patchId}`,
    });
  }

  for (const target of targets.values()) {
    const segments = toPathKey(target.path).split('/');
    for (let length = 1; length < segments.length; length += 1) {
      const ancestor = targets.get(segments.slice(0, length).join('/'));
      if (!ancestor) continue;
      throw new YmbError('ConflictError', {
        absolutePath: target.path,
        reason: `Output path \`${ancestor.path}\` cannot also be the parent directory of \`${target.path}\`.`,
        suggestion: 'Move one output so every planned file has a distinct directory path.',
        details: [`Ancestor owner: ${ancestor.owner}`, `Descendant owner: ${target.owner}`],
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

/** The earlier mod writes over untouched game files either way, so it declares nothing. */
function canLayerOrderedMods(left: DiscoveredMod, right: DiscoveredMod): boolean {
  return resolveLaterMod(left, right)?.config.allowWriteToModifiedFiles ?? false;
}

function resolveLaterMod(left: DiscoveredMod, right: DiscoveredMod): DiscoveredMod | undefined {
  if (left.config.priority !== right.config.priority) {
    return left.config.priority > right.config.priority ? left : right;
  }
  if (dependsOnMod(left, right.config.id)) {
    return left;
  }
  if (dependsOnMod(right, left.config.id)) {
    return right;
  }
  return undefined;
}

function dependsOnMod(mod: DiscoveredMod, dependencyModId: string): boolean {
  return mod.config.dependsOn.includes(dependencyModId);
}
