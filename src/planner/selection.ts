import path from 'node:path';
import type { CooperativeYieldController } from '../async.ts';
import { BUILDER_TEMP_PREFIXES } from '../builder-config.ts';
import { isScopeIncluded, listFilesRecursive } from '../config.ts';
import { ensure } from '../errors.ts';
import { assertOwnedRelativePath, normalizeRelativePath, toPathKey } from '../path-utils.ts';
import { createTemplateVariables, resolveTemplateValue } from '../templates.ts';
import type {
  BuilderContext,
  DiscoveredMod,
  PatchApplication,
  ReplaceFile,
  ScriptApplication,
  SelectedPatchReason,
  SelectionInput,
} from '../types.ts';

export async function selectPatchesCooperative(
  discoveredMods: DiscoveredMod[],
  selection: SelectionInput,
  allowedModIds = new Set(discoveredMods.map((mod) => mod.config.id)),
  yieldController?: CooperativeYieldController,
): Promise<{
  explanations: SelectedPatchReason[];
  selectedPatches: PatchApplication[];
}> {
  const explanations: SelectedPatchReason[] = [];
  const selectedPatches: PatchApplication[] = [];
  const patchIds = new Map<string, string>();

  for (const mod of discoveredMods) {
    await yieldController?.maybeYield();
    const modEnabled = mod.config.enabled;
    const modMatchesFilter =
      selection.modFilters.length === 0 ||
      selection.modFilters.some(
        (filter) =>
          filter === mod.config.id ||
          filter.localeCompare(mod.config.name, undefined, { sensitivity: 'accent' }) === 0,
      );

    for (const patch of mod.patches) {
      await yieldController?.maybeYield();
      const reasons: string[] = [];
      const patchEnabled = patch.config.enabled;
      const scopeAllowed = isScopeIncluded(selection.scope, patch.config.scope);
      const explicitlySelectedPatch =
        selection.patchFilters.length === 0 || selection.patchFilters.includes(patch.config.id);

      if (!modEnabled) {
        reasons.push(`source mod ${mod.config.id} is disabled`);
      }
      if (!allowedModIds.has(mod.config.id)) {
        reasons.push('excluded by mod dependency selection');
      }
      if (!modMatchesFilter && !allowedModIds.has(mod.config.id)) {
        reasons.push('excluded by --mod');
      }
      if (!patchEnabled) {
        reasons.push(`patch ${patch.config.id} is disabled`);
      }
      if (!scopeAllowed) {
        reasons.push(`scope ${selection.scope} does not include patch scope ${patch.config.scope}`);
      }
      if (!explicitlySelectedPatch) {
        reasons.push('excluded by --patch');
      }

      const included = reasons.length === 0;
      explanations.push({
        patchId: patch.config.id,
        included,
        reasons: included ? ['included by the current scope and filters'] : reasons,
      });

      if (!included) {
        continue;
      }

      const duplicateOwner = patchIds.get(patch.config.id);
      ensure(!duplicateOwner, 'ConflictError', {
        absolutePath: patch.absoluteConfigPath,
        modId: mod.config.id,
        modName: mod.config.name,
        patchId: patch.config.id,
        reason: `Patch id \`${patch.config.id}\` would be selected more than once.`,
        suggestion: 'Use globally unique patch ids for any combination you may build together.',
        details: duplicateOwner ? [duplicateOwner] : undefined,
      });

      patchIds.set(patch.config.id, patch.absoluteConfigPath);
      selectedPatches.push({ mod, patch });
    }
  }

  return { explanations, selectedPatches };
}

export function collectSelectedMods(
  selectedMods: DiscoveredMod[],
  selectedPatches: PatchApplication[],
): DiscoveredMod[] {
  const orderedSelectedMods: DiscoveredMod[] = [];
  const selectedModIds = new Set<string>();

  for (const mod of selectedMods) {
    if (selectedModIds.has(mod.config.id)) {
      continue;
    }
    selectedModIds.add(mod.config.id);
    orderedSelectedMods.push(mod);
  }

  for (const selectedPatch of selectedPatches) {
    if (selectedModIds.has(selectedPatch.mod.config.id)) {
      continue;
    }
    selectedModIds.add(selectedPatch.mod.config.id);
    orderedSelectedMods.push(selectedPatch.mod);
  }

  return orderedSelectedMods;
}

export function collectInitiallySelectedMods(
  discoveredMods: DiscoveredMod[],
  selection: SelectionInput,
): DiscoveredMod[] {
  return discoveredMods.filter((mod) => isModSelectable(mod, selection));
}

export async function collectReplaceFiles(
  context: BuilderContext,
  selectedMods: DiscoveredMod[],
  yieldController?: CooperativeYieldController,
): Promise<ReplaceFile[]> {
  const replaceFiles: ReplaceFile[] = [];

  for (const mod of selectedMods) {
    await yieldController?.maybeYield();
    if (!mod.replaceAbsolutePath) {
      continue;
    }

    const templateVariables = createTemplateVariables(context, mod);
    const absoluteFiles = await listFilesRecursive(mod.replaceAbsolutePath, {
      skipDirectoryNamesStartingWith: [...BUILDER_TEMP_PREFIXES],
      skipFileNamesStartingWith: [...BUILDER_TEMP_PREFIXES],
    });
    for (const absoluteFile of absoluteFiles) {
      await yieldController?.maybeYield();
      const sourceRelativePath = normalizeRelativePath(
        path.relative(mod.replaceAbsolutePath, absoluteFile),
      );
      const targetRelativePath = normalizeRelativePath(
        String(resolveTemplateValue(sourceRelativePath, templateVariables)),
      );
      replaceFiles.push({
        sourceAbsolutePath: absoluteFile,
        targetRelativePath,
        modId: mod.config.id,
        modName: mod.config.name,
        priority: mod.config.priority,
        allowWriteToModifiedFiles: mod.config.allowWriteToModifiedFiles,
        templateVariables,
      });
    }
  }

  replaceFiles.sort((left, right) =>
    left.targetRelativePath.localeCompare(right.targetRelativePath),
  );
  return replaceFiles;
}

export async function collectSelectedScriptsCooperative(
  context: BuilderContext,
  selectedMods: DiscoveredMod[],
  selectedPatches: PatchApplication[],
  yieldController?: CooperativeYieldController,
): Promise<ScriptApplication[]> {
  const scripts: ScriptApplication[] = [];

  for (const mod of selectedMods) {
    await yieldController?.maybeYield();
    const templateVariables = createTemplateVariables(context, mod);
    for (const config of mod.config.scripts) {
      await yieldController?.maybeYield();
      if (!config.enabled) {
        continue;
      }

      scripts.push({
        mod,
        config,
        absolutePath: path.join(
          mod.configAbsolutePath,
          ...assertOwnedRelativePath(
            String(resolveTemplateValue(config.path, templateVariables)),
            mod.configAbsolutePath,
            'source mod config root',
          ).split('/'),
        ),
        testAbsolutePaths: config.tests.map((testPath) =>
          path.join(
            mod.configAbsolutePath,
            ...assertOwnedRelativePath(
              String(resolveTemplateValue(testPath, templateVariables)),
              mod.configAbsolutePath,
              'source mod config root',
            ).split('/'),
          ),
        ),
      });
    }
  }

  for (const selected of selectedPatches) {
    await yieldController?.maybeYield();
    for (const config of selected.patch.config.scripts) {
      await yieldController?.maybeYield();
      if (!config.enabled) {
        continue;
      }

      const templateVariables = createTemplateVariables(context, selected.mod, selected.patch);

      scripts.push({
        mod: selected.mod,
        patch: selected.patch,
        config,
        absolutePath: path.join(
          selected.patch.absolutePath,
          ...assertOwnedRelativePath(
            String(resolveTemplateValue(config.path, templateVariables)),
            selected.patch.absolutePath,
            'patch root',
          ).split('/'),
        ),
        testAbsolutePaths: config.tests.map((testPath) =>
          path.join(
            selected.patch.absolutePath,
            ...assertOwnedRelativePath(
              String(resolveTemplateValue(testPath, templateVariables)),
              selected.patch.absolutePath,
              'patch root',
            ).split('/'),
          ),
        ),
      });
    }
  }

  return scripts;
}

export async function collectTargetFilesCooperative(
  context: BuilderContext,
  selectedPatches: PatchApplication[],
  selectedReplaceFiles: ReplaceFile[],
  yieldController?: CooperativeYieldController,
): Promise<string[]> {
  const targetFiles = new Map<string, string>();

  for (const selectedPatch of selectedPatches) {
    await yieldController?.maybeYield();
    const templateVariables = createTemplateVariables(
      context,
      selectedPatch.mod,
      selectedPatch.patch,
    );
    for (const target of selectedPatch.patch.config.targets) {
      await yieldController?.maybeYield();
      const targetRelativePath = resolveTargetRelativePath(target.file, templateVariables);
      targetFiles.set(toPathKey(targetRelativePath), targetRelativePath);
    }
  }

  for (const replaceFile of selectedReplaceFiles) {
    await yieldController?.maybeYield();
    targetFiles.set(toPathKey(replaceFile.targetRelativePath), replaceFile.targetRelativePath);
  }

  return [...targetFiles.values()].sort((left, right) => left.localeCompare(right));
}

export function resolveSelectedTargetRelativePath(
  context: BuilderContext,
  selected: PatchApplication,
  targetFile: string,
  templateVariables = createTemplateVariables(context, selected.mod, selected.patch),
): string {
  return resolveTargetRelativePath(targetFile, templateVariables);
}

function resolveTargetRelativePath(
  targetFile: string,
  templateVariables: Record<string, unknown>,
): string {
  return normalizeRelativePath(String(resolveTemplateValue(targetFile, templateVariables)));
}

function isModSelectable(mod: DiscoveredMod, selection: SelectionInput): boolean {
  return (
    mod.config.enabled &&
    (selection.modFilters.length === 0 ||
      selection.modFilters.some(
        (filter) =>
          filter === mod.config.id ||
          filter.localeCompare(mod.config.name, undefined, { sensitivity: 'accent' }) === 0,
      ))
  );
}
