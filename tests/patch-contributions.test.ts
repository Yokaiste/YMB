import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  comparePatchContributions,
  dedupeContributors,
  groupPatchContributions,
} from '../src/engine/patch-contributions.ts';
import { resolvePatchWorkerCount } from '../src/engine/patch-runtime.ts';
import type {
  BuilderContext,
  BuildPlan,
  DiscoveredMod,
  DiscoveredPatch,
  ModConfig,
  PatchApplication,
  PatchConfig,
} from '../src/types.ts';

describe('patch contribution helpers', () => {
  test('groups selected patch targets by normalized target path in sorted order', () => {
    const plan = createPlan([
      createApplication('mod_b', 'patch.second', ['GameData\\Generated\\B.ndf']),
      createApplication('mod_a', 'patch.first', [
        'CommonData/Text/A.ndf',
        'GameData/Generated/B.ndf',
      ]),
    ]);

    const grouped = groupPatchContributions(plan);

    expect([...grouped.keys()]).toEqual(['commondata/text/a.ndf', 'gamedata/generated/b.ndf']);
    expect(grouped.get('gamedata/generated/b.ndf')?.map((item) => item.patchOrder)).toEqual([0, 1]);
  });

  test('keeps dependency order authoritative while prioritized mods still run last', () => {
    const prioritized = createResolvedContribution('mod_b', 'patch.prioritized', true, 1);
    const regular = createResolvedContribution('mod_a', 'patch.regular', false, 0);
    const regularScript = createResolvedContribution('mod_a', 'patch.regular-script', true, 0);
    const sameModEarlier = createResolvedContribution('mod_a', 'patch.earlier', true, 0);
    const sameModLater = createResolvedContribution('mod_a', 'patch.later', true, 2);

    expect(comparePatchContributions(prioritized, regular, undefined)).toBeGreaterThan(0);
    expect(comparePatchContributions(regularScript, prioritized, 'mod_b')).toBeLessThan(0);
    expect(comparePatchContributions(sameModEarlier, sameModLater, undefined)).toBeLessThan(0);
  });

  test('dedupes contributors by mod and patch id', () => {
    const repeated = createResolvedContribution('mod_a', 'patch.same', false, 0);
    const repeatedAgain = createResolvedContribution('mod_a', 'patch.same', true, 1);
    const distinct = createResolvedContribution('mod_a', 'patch.other', false, 2);

    expect(dedupeContributors([repeated, repeatedAgain, distinct])).toEqual([
      { modId: 'mod_a', modName: 'MOD_A', patchId: 'patch.same' },
      { modId: 'mod_a', modName: 'MOD_A', patchId: 'patch.other' },
    ]);
  });

  test('bounds patch workers by jobs, available CPUs, and the memory-safe ceiling', () => {
    expect(resolvePatchWorkerCount(0, 32)).toBe(1);
    expect(resolvePatchWorkerCount(2, 32)).toBe(2);
    expect(resolvePatchWorkerCount(28, 32)).toBe(16);
    expect(resolvePatchWorkerCount(28, 8)).toBe(7);
    expect(resolvePatchWorkerCount(28, 1)).toBe(1);
  });
});

function createPlan(selectedPatches: PatchApplication[]): BuildPlan {
  return {
    context: createContext(),
    selection: {
      scope: 'prod',
      modFilters: [],
      patchFilters: [],
      dryRun: true,
      verbose: false,
      yes: false,
    },
    discoveredMods: [],
    selectedMods: selectedPatches.map((item) => item.mod),
    selectedPatches,
    selectedReplaceFiles: [],
    selectedScripts: [],
    explanations: [],
    targetFiles: [],
  };
}

function createResolvedContribution(
  modId: string,
  patchId: string,
  hasScripts: boolean,
  patchOrder: number,
) {
  const application = createApplication(
    modId,
    patchId,
    ['GameData/Generated/Test.ndf'],
    hasScripts,
  );
  const target = application.patch.config.targets[0];
  if (!target) {
    throw new Error('Expected at least one target');
  }
  return {
    application,
    target,
    targetRelativePath: 'GameData/Generated/Test.ndf',
    hasScripts,
    patchOrder,
  };
}

function createApplication(
  modId: string,
  patchId: string,
  targetFiles: string[],
  hasScripts = false,
): PatchApplication {
  const modConfig: ModConfig = {
    version: 1,
    id: modId,
    name: modId.toUpperCase(),
    dependsOn: [],
    priority: 0,
    allowWriteToModifiedFiles: false,
    enabled: true,
    scripts: [],
    tempPaths: [],
  };
  const patchConfig: PatchConfig = {
    version: 1,
    id: patchId,
    name: patchId,
    enabled: true,
    scope: 'prod',
    dependsOn: [],
    targets: targetFiles.map((file) => ({ file, operations: [] })),
    scripts: hasScripts ? [{ path: 'generate.ts', enabled: true, tests: [] }] : [],
    tempPaths: [],
  };
  const mod: DiscoveredMod = {
    config: modConfig,
    absolutePath: path.resolve('mods', modId),
    configAbsolutePath: path.resolve('mods', modId, 'config'),
    relativePathFromMods: modId,
    absoluteConfigPath: path.resolve('mods', modId, 'config', 'ymb.mod.yaml'),
    patches: [],
  };
  const patch: DiscoveredPatch = {
    config: patchConfig,
    absolutePath: path.resolve('mods', modId, 'config', 'patch', patchId),
    relativePathInMod: `config/patch/${patchId}`,
    absoluteConfigPath: path.resolve('mods', modId, 'config', 'patch', patchId, 'ymb.patch.yaml'),
  };

  return { mod, patch };
}

function createContext(): BuilderContext {
  const modRoot = path.resolve('mod-root');
  return {
    ymbRoot: path.join(modRoot, 'YMB'),
    modRoot,
    modsRoot: path.join(modRoot, 'YMB', 'mods'),
    gameDataRoot: path.join(modRoot, 'GameData'),
    commonDataRoot: path.join(modRoot, 'CommonData'),
    buildRoot: path.join(modRoot, 'YMB', '.ymb-build'),
    stateRoot: path.join(modRoot, 'YMB', '.ymb-state'),
  };
}
