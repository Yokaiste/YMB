import type { CooperativeYieldController } from '../async.ts';
import { YmbError } from '../errors.ts';
import { pathExists, resolveModTargetPath } from '../path-utils.ts';
import { createTemplateVariables } from '../templates.ts';
import type { BuilderContext, PatchApplication, SelectionInput, SkippedPatch } from '../types.ts';
import { resolveSelectedTargetRelativePath } from './selection.ts';

/** Failures that mean "the game data this feature is built on is not here". */
const MISSING_GAME_DATA_CATEGORIES = new Set(['IoError', 'SelectorError']);

function patchKey(selected: PatchApplication): string {
  return `${selected.mod.config.id}:${selected.patch.config.id}`;
}

/**
 * A feature whose prerequisite could not be built cannot be built either. Dependents
 * are reported as skipped in their own right, naming what they waited on. Runs after
 * dependency resolution, which would otherwise put the prerequisites straight back.
 */
export function dropPatchesAndDependents(
  selectedPatches: readonly PatchApplication[],
  removed: readonly SkippedPatch[],
): { selectedPatches: PatchApplication[]; skippedPatches: SkippedPatch[] } {
  if (removed.length === 0) {
    return { selectedPatches: [...selectedPatches], skippedPatches: [] };
  }

  const skippedPatches = [...removed];
  const droppedKeys = new Set(removed.map((skipped) => `${skipped.modId}:${skipped.patchId}`));
  // Both forms a config may use to name a dependency.
  const droppedReferences = new Set(
    removed.flatMap((skipped) => [skipped.patchId, `${skipped.modId}:${skipped.patchId}`]),
  );

  let keptPatches = selectedPatches.filter((selected) => !droppedKeys.has(patchKey(selected)));
  // Dropping one feature can strand the one built on top of it, so this repeats
  // until nothing new falls out.
  for (;;) {
    const stranded = keptPatches.filter((selected) =>
      selected.patch.config.dependsOn.some((reference) => droppedReferences.has(reference)),
    );
    if (stranded.length === 0) break;
    for (const selected of stranded) {
      const missing = selected.patch.config.dependsOn.filter((reference) =>
        droppedReferences.has(reference),
      );
      droppedKeys.add(patchKey(selected));
      droppedReferences.add(selected.patch.config.id);
      droppedReferences.add(patchKey(selected));
      skippedPatches.push({
        modId: selected.mod.config.id,
        modName: selected.mod.config.name,
        patchId: selected.patch.config.id,
        reason: `depends on skipped ${missing.join(', ')}`,
      });
    }
    keptPatches = keptPatches.filter((selected) => !droppedKeys.has(patchKey(selected)));
  }

  return { selectedPatches: keptPatches, skippedPatches: sortSkippedPatches(skippedPatches) };
}

/**
 * Some game files ship only with some WARNO versions or DLC. The whole patch goes
 * rather than the individual target: a feature adding a unit in one file and its
 * texture in another is not something to half-apply. Only an absent path is forgiven
 * -- a malformed path or an unreadable file still fails.
 */
export async function dropOptionalPatchesMissingTargets(
  context: BuilderContext,
  selection: SelectionInput,
  selectedPatches: PatchApplication[],
  yieldController?: CooperativeYieldController,
): Promise<{ selectedPatches: PatchApplication[]; skippedPatches: SkippedPatch[] }> {
  if (selection.requireAll || !selectedPatches.some((selected) => selected.patch.config.optional)) {
    return { selectedPatches, skippedPatches: [] };
  }

  const skippedPatches: SkippedPatch[] = [];
  const keptPatches: PatchApplication[] = [];

  for (const selected of selectedPatches) {
    await yieldController?.maybeYield();
    if (!selected.patch.config.optional) {
      keptPatches.push(selected);
      continue;
    }

    const variables = createTemplateVariables(context, selected.mod, selected.patch);
    let missingTarget: string | undefined;
    for (const target of selected.patch.config.targets) {
      await yieldController?.maybeYield();
      const targetRelativePath = resolveSelectedTargetRelativePath(
        context,
        selected,
        target.file,
        variables,
      );
      if (!(await pathExists(resolveModTargetPath(context.modRoot, targetRelativePath)))) {
        missingTarget = targetRelativePath;
        break;
      }
    }

    if (missingTarget === undefined) {
      keptPatches.push(selected);
      continue;
    }
    skippedPatches.push({
      modId: selected.mod.config.id,
      modName: selected.mod.config.name,
      patchId: selected.patch.config.id,
      reason: `no \`${missingTarget}\` in this install`,
    });
  }

  return { selectedPatches: keptPatches, skippedPatches: sortSkippedPatches(skippedPatches) };
}

/**
 * A selector matching nothing can only be found by trying, so the run tries and this
 * reads the failures back: a failure meaning "the data is not there" costs its
 * optional patch, and everything else still fails the run.
 */
export function collectDroppableOptionalPatches(
  selectedPatches: readonly PatchApplication[],
  selection: SelectionInput,
  failures: readonly YmbError[],
): SkippedPatch[] {
  if (selection.requireAll) {
    return [];
  }

  const optionalByKey = new Map<string, PatchApplication>(
    selectedPatches
      .filter((selected) => selected.patch.config.optional)
      .map((selected) => [`${selected.mod.config.id}:${selected.patch.config.id}`, selected]),
  );
  if (optionalByKey.size === 0) {
    return [];
  }

  const dropped = new Map<string, SkippedPatch>();
  for (const failure of failures) {
    if (!MISSING_GAME_DATA_CATEGORIES.has(failure.category)) continue;
    const { modId, patchId } = failure.context;
    if (modId === undefined || patchId === undefined) continue;
    const key = `${modId}:${patchId}`;
    const selected = optionalByKey.get(key);
    if (!selected || dropped.has(key)) continue;
    dropped.set(key, {
      modId: selected.mod.config.id,
      modName: selected.mod.config.name,
      patchId: selected.patch.config.id,
      reason: failure.context.reason,
    });
  }

  return sortSkippedPatches([...dropped.values()]);
}

/** Failures that are not YMB results are bugs, and never drop anything. */
export function listYmbFailures(error: unknown): YmbError[] {
  if (error instanceof YmbError) return [error];
  const grouped = error as { errors?: unknown };
  if (!Array.isArray(grouped.errors)) return [];
  return grouped.errors.filter((item): item is YmbError => item instanceof YmbError);
}

function sortSkippedPatches(skipped: SkippedPatch[]): SkippedPatch[] {
  return skipped.sort(
    (left, right) =>
      left.modId.localeCompare(right.modId) || left.patchId.localeCompare(right.patchId),
  );
}
