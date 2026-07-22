import type { CooperativeYieldController } from '../async.ts';
import { ensure } from '../errors.ts';
import type { DiscoveredMod, PatchApplication } from '../types.ts';

export async function resolveSelectedModsCooperative(
  initiallySelectedMods: DiscoveredMod[],
  discoveredMods: DiscoveredMod[],
  yieldController?: CooperativeYieldController,
): Promise<DiscoveredMod[]> {
  const discoveredById = new Map(discoveredMods.map((mod) => [mod.config.id, mod] as const));
  const selectedById = new Map(initiallySelectedMods.map((mod) => [mod.config.id, mod] as const));
  const pending = [...initiallySelectedMods];

  while (pending.length > 0) {
    await yieldController?.maybeYield();
    const current = pending.shift();
    if (!current) {
      continue;
    }

    for (const dependencyModId of current.config.dependsOn) {
      await yieldController?.maybeYield();
      const dependency = discoveredById.get(dependencyModId);
      ensure(dependency, 'ConfigError', {
        absolutePath: current.absoluteConfigPath,
        modId: current.config.id,
        modName: current.config.name,
        reason: `Missing mod dependency \`${dependencyModId}\`.`,
        suggestion: 'Fix the mod `dependsOn` list or add the missing source mod.',
      });
      ensure(dependency.config.enabled, 'ConfigError', {
        absolutePath: current.absoluteConfigPath,
        modId: current.config.id,
        modName: current.config.name,
        reason: `Mod dependency \`${dependencyModId}\` is disabled.`,
        suggestion:
          'Enable the dependency mod or remove it from `dependsOn`; YMB will not partially run a disabled source mod.',
        details: [dependency.absoluteConfigPath],
      });
      ensure(current.config.priority >= dependency.config.priority, 'ConfigError', {
        absolutePath: current.absoluteConfigPath,
        modId: current.config.id,
        modName: current.config.name,
        reason: `Mod \`${current.config.id}\` cannot have lower priority than mod dependency \`${dependencyModId}\`.`,
        suggestion:
          'Raise the dependent mod priority so it is equal to or higher than the mod it depends on.',
        details: [
          `Current mod priority: ${current.config.priority}`,
          `Dependency mod priority: ${dependency.config.priority}`,
        ],
      });
      if (!selectedById.has(dependencyModId)) {
        selectedById.set(dependencyModId, dependency);
        pending.push(dependency);
      }
    }
  }

  return topologicallyOrderMods([...selectedById.values()]);
}

export async function resolvePatchDependenciesCooperative(
  selectedPatches: PatchApplication[],
  discoveredMods: DiscoveredMod[],
  selectedMods: DiscoveredMod[],
  yieldController?: CooperativeYieldController,
): Promise<void> {
  const selectedKeys = new Set(
    selectedPatches.map((item) => getPatchKey(item.mod.config.id, item.patch.config.id)),
  );
  const selectedModsById = new Map(selectedMods.map((mod) => [mod.config.id, mod] as const));
  const indexByQualifiedKey = new Map<string, PatchApplication>();
  const indexByPatchId = new Map<string, PatchApplication[]>();

  for (const mod of discoveredMods) {
    await yieldController?.maybeYield();
    for (const patch of mod.patches) {
      await yieldController?.maybeYield();
      const application = { mod, patch };
      indexByQualifiedKey.set(getPatchKey(mod.config.id, patch.config.id), application);
      const byId = indexByPatchId.get(patch.config.id) ?? [];
      byId.push(application);
      indexByPatchId.set(patch.config.id, byId);
    }
  }

  let changed = true;
  while (changed) {
    await yieldController?.maybeYield();
    changed = false;

    for (const application of [...selectedPatches]) {
      await yieldController?.maybeYield();
      for (const dependencyReference of application.patch.config.dependsOn) {
        await yieldController?.maybeYield();
        const dependency = resolvePatchDependencyReference(
          dependencyReference,
          application,
          indexByQualifiedKey,
          indexByPatchId,
        );
        const dependencyKey = getPatchKey(dependency.mod.config.id, dependency.patch.config.id);
        ensureDependencyEnabled(application, dependency, dependencyReference);
        validateDependencyModPriority(application, dependency);
        if (selectedKeys.has(dependencyKey)) {
          continue;
        }

        selectedPatches.push(dependency);
        selectedKeys.add(dependencyKey);
        changed = true;
      }
    }
  }

  const selectedIndex = new Map(
    selectedPatches.map(
      (item) => [getPatchKey(item.mod.config.id, item.patch.config.id), item] as const,
    ),
  );
  const dependencyCount = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const item of selectedPatches) {
    await yieldController?.maybeYield();
    const patchKey = getPatchKey(item.mod.config.id, item.patch.config.id);
    const selectedDependencies = item.patch.config.dependsOn
      .map((dependencyReference) =>
        resolvePatchDependencyReference(
          dependencyReference,
          item,
          indexByQualifiedKey,
          indexByPatchId,
        ),
      )
      .filter((dependency) =>
        selectedIndex.has(getPatchKey(dependency.mod.config.id, dependency.patch.config.id)),
      );
    dependencyCount.set(patchKey, selectedDependencies.length);

    for (const dependency of selectedDependencies) {
      const dependencyKey = getPatchKey(dependency.mod.config.id, dependency.patch.config.id);
      const entries = dependents.get(dependencyKey) ?? [];
      entries.push(patchKey);
      dependents.set(dependencyKey, entries);
    }
  }

  const modOrder = new Map(selectedMods.map((mod, index) => [mod.config.id, index] as const));
  const compareApplications = (left: PatchApplication, right: PatchApplication) => {
    const leftModOrder = modOrder.get(left.mod.config.id) ?? Number.MAX_SAFE_INTEGER;
    const rightModOrder = modOrder.get(right.mod.config.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftModOrder !== rightModOrder) {
      return leftModOrder - rightModOrder;
    }

    const modDiff = left.mod.config.id.localeCompare(right.mod.config.id);
    return modDiff !== 0 ? modDiff : left.patch.config.id.localeCompare(right.patch.config.id);
  };

  const queue = selectedPatches
    .filter(
      (item) =>
        (dependencyCount.get(getPatchKey(item.mod.config.id, item.patch.config.id)) ?? 0) === 0,
    )
    .sort(compareApplications);
  const orderedPatches: PatchApplication[] = [];

  while (queue.length > 0) {
    await yieldController?.maybeYield();
    const current = queue.shift();
    if (!current) {
      continue;
    }

    orderedPatches.push(current);
    const currentKey = getPatchKey(current.mod.config.id, current.patch.config.id);
    for (const dependentKey of dependents.get(currentKey) ?? []) {
      const nextCount = (dependencyCount.get(dependentKey) ?? 0) - 1;
      dependencyCount.set(dependentKey, nextCount);
      if (nextCount === 0) {
        const dependent = selectedIndex.get(dependentKey);
        if (dependent) {
          queue.push(dependent);
          queue.sort(compareApplications);
        }
      }
    }
  }

  ensure(orderedPatches.length === selectedPatches.length, 'ConflictError', {
    absolutePath: selectedPatches[0]?.mod.absoluteConfigPath ?? '<selection>',
    reason: 'Patch dependency graph contains a cycle.',
    suggestion: 'Remove the circular chain from the patch `dependsOn` entries.',
  });

  selectedPatches.splice(0, selectedPatches.length, ...orderedPatches);

  for (const selectedPatch of selectedPatches) {
    await yieldController?.maybeYield();
    const selectedMod = selectedModsById.get(selectedPatch.mod.config.id);
    ensure(selectedMod, 'ConfigError', {
      absolutePath: selectedPatch.patch.absoluteConfigPath,
      modId: selectedPatch.mod.config.id,
      modName: selectedPatch.mod.config.name,
      patchId: selectedPatch.patch.config.id,
      reason: `Selected patch \`${selectedPatch.patch.config.id}\` belongs to an unselected mod.`,
      suggestion:
        'Ensure the owning mod is selected directly or through a mod/patch dependency chain.',
    });
  }
}

function ensureDependencyEnabled(
  owner: PatchApplication,
  dependency: PatchApplication,
  dependencyReference: string,
): void {
  ensure(dependency.mod.config.enabled && dependency.patch.config.enabled, 'ConfigError', {
    absolutePath: owner.patch.absoluteConfigPath,
    modId: owner.mod.config.id,
    modName: owner.mod.config.name,
    patchId: owner.patch.config.id,
    reason: `Patch dependency \`${dependencyReference}\` is disabled.`,
    suggestion:
      'Enable both the dependency source mod and patch, or remove the dependency reference.',
    details: [dependency.patch.absoluteConfigPath],
  });
}

function topologicallyOrderMods(selectedMods: DiscoveredMod[]): DiscoveredMod[] {
  const selectedById = new Map(selectedMods.map((mod) => [mod.config.id, mod] as const));
  const dependencyCount = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const mod of selectedMods) {
    const selectedDependencies = mod.config.dependsOn.filter((dependencyId) =>
      selectedById.has(dependencyId),
    );
    dependencyCount.set(mod.config.id, selectedDependencies.length);

    for (const dependencyId of selectedDependencies) {
      const entries = dependents.get(dependencyId) ?? [];
      entries.push(mod.config.id);
      dependents.set(dependencyId, entries);
    }
  }

  const queue = selectedMods
    .filter((mod) => (dependencyCount.get(mod.config.id) ?? 0) === 0)
    .sort(compareMods);
  const ordered: DiscoveredMod[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    ordered.push(current);
    for (const dependentId of dependents.get(current.config.id) ?? []) {
      const nextCount = (dependencyCount.get(dependentId) ?? 0) - 1;
      dependencyCount.set(dependentId, nextCount);
      if (nextCount === 0) {
        const dependent = selectedById.get(dependentId);
        if (dependent) {
          queue.push(dependent);
          queue.sort(compareMods);
        }
      }
    }
  }

  ensure(ordered.length === selectedMods.length, 'ConflictError', {
    absolutePath: selectedMods[0]?.absoluteConfigPath ?? '<selection>',
    reason: 'Mod dependency graph contains a cycle.',
    suggestion: 'Remove the circular chain from the mod `dependsOn` lists.',
  });

  return ordered;
}

function compareMods(left: DiscoveredMod, right: DiscoveredMod): number {
  if (left.config.priority !== right.config.priority) {
    return left.config.priority - right.config.priority;
  }

  return left.config.id.localeCompare(right.config.id);
}

function resolvePatchDependencyReference(
  dependencyReference: string,
  owner: PatchApplication,
  indexByQualifiedKey: Map<string, PatchApplication>,
  indexByPatchId: Map<string, PatchApplication[]>,
): PatchApplication {
  const qualifierIndex = dependencyReference.indexOf(':');
  if (qualifierIndex > 0) {
    const dependencyModId = dependencyReference.slice(0, qualifierIndex);
    const dependencyPatchId = dependencyReference.slice(qualifierIndex + 1);
    const dependency = indexByQualifiedKey.get(getPatchKey(dependencyModId, dependencyPatchId));
    ensure(dependency, 'ConfigError', {
      absolutePath: owner.patch.absoluteConfigPath,
      modId: owner.mod.config.id,
      modName: owner.mod.config.name,
      patchId: owner.patch.config.id,
      reason: `Missing dependency \`${dependencyReference}\`.`,
      suggestion: 'Fix the qualified `dependsOn` entry or add the missing patch config.',
    });
    return dependency;
  }

  const dependencyOptions = indexByPatchId.get(dependencyReference) ?? [];
  ensure(dependencyOptions.length > 0, 'ConfigError', {
    absolutePath: owner.patch.absoluteConfigPath,
    modId: owner.mod.config.id,
    modName: owner.mod.config.name,
    patchId: owner.patch.config.id,
    reason: `Missing dependency \`${dependencyReference}\`.`,
    suggestion: 'Fix the `dependsOn` list or add the missing patch config.',
  });
  ensure(dependencyOptions.length === 1, 'ConfigError', {
    absolutePath: owner.patch.absoluteConfigPath,
    modId: owner.mod.config.id,
    modName: owner.mod.config.name,
    patchId: owner.patch.config.id,
    reason: `Dependency \`${dependencyReference}\` matches multiple patches across source mods.`,
    suggestion:
      'Use the qualified `modId:patchId` form for cross-mod dependencies when patch ids are reused.',
    details: dependencyOptions.map((option) => option.patch.absoluteConfigPath),
  });
  const dependency = dependencyOptions[0];
  ensure(dependency, 'ConfigError', {
    absolutePath: owner.patch.absoluteConfigPath,
    modId: owner.mod.config.id,
    modName: owner.mod.config.name,
    patchId: owner.patch.config.id,
    reason: `Dependency \`${dependencyReference}\` could not be resolved.`,
    suggestion: 'Fix the `dependsOn` list or add the missing patch config.',
  });
  return dependency;
}

function validateDependencyModPriority(
  selected: PatchApplication,
  dependency: PatchApplication,
): void {
  ensure(selected.mod.config.priority >= dependency.mod.config.priority, 'ConfigError', {
    absolutePath: selected.patch.absoluteConfigPath,
    modId: selected.mod.config.id,
    modName: selected.mod.config.name,
    patchId: selected.patch.config.id,
    reason: `Patch \`${selected.patch.config.id}\` cannot depend on \`${dependency.patch.config.id}\` through a lower-priority source mod.`,
    suggestion:
      'Raise the dependent mod priority so it is equal to or higher than the dependency mod priority.',
    details: [
      `Current mod priority: ${selected.mod.config.priority}`,
      `Dependency mod priority: ${dependency.mod.config.priority}`,
    ],
  });
}

function getPatchKey(modId: string, patchId: string): string {
  return `${modId}:${patchId}`;
}
