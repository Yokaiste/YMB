import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDefaultBuilderProjectConfig } from '../src/builder-config.ts';
import { collectCleanupTargets } from '../src/temp-artifacts.ts';
import type {
  BuilderContext,
  DiscoveredMod,
  DiscoveredPatch,
  PatchApplication,
  TempArtifactConfig,
} from '../src/types.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Cleanup decides what it may delete by merging every source that names a path,
 * and a path another source marked as holding undo data must survive that merge.
 * WARNO is a Windows game, so two spellings that differ only in case are one
 * file - and keying them apart splits the merge and deletes the file anyway.
 */
describe('collecting cleanup targets', () => {
  test('treats one path spelled two ways as one, keeping the unsafe flag', async () => {
    const { context, mod } = await createWorkspace([
      { path: '.ymb-store.json', unsafeToRemove: true },
    ]);
    const patch = createPatch(mod, [{ path: '.YMB-Store.json', unsafeToRemove: false }]);

    const targets = await collectCleanupTargets({
      context,
      selectedMods: [mod],
      selectedPatches: [patch],
    });

    const storeTargets = targets.filter((target) =>
      target.absolutePath.toLowerCase().endsWith('.ymb-store.json'),
    );
    expect(storeTargets).toHaveLength(1);
    expect(storeTargets[0]?.unsafeToRemove).toBe(true);
  });

  test('still keeps genuinely different paths apart', async () => {
    const { context, mod } = await createWorkspace([
      { path: '.ymb-store.json', unsafeToRemove: true },
      { path: '.ymb-scratch.json', unsafeToRemove: false },
    ]);

    const targets = await collectCleanupTargets({
      context,
      selectedMods: [mod],
      selectedPatches: [],
    });

    expect(targets.filter((target) => target.absolutePath.endsWith('.json'))).toHaveLength(2);
  });
});

async function createWorkspace(
  tempPaths: TempArtifactConfig[],
): Promise<{ context: BuilderContext; mod: DiscoveredMod }> {
  const rootPath = await mkdtemp(path.join(tmpdir(), 'ymb-temp-artifacts-'));
  tempRoots.push(rootPath);
  const ymbRoot = path.join(rootPath, 'YMB');
  const configDirectoryPath = path.join(ymbRoot, 'mods', 'sample-pack', 'config');
  await mkdir(configDirectoryPath, { recursive: true });

  const builderConfig = createDefaultBuilderProjectConfig();
  const buildRoot = path.join(ymbRoot, builderConfig.paths.workRoot);
  const context: BuilderContext = {
    ymbRoot,
    builderConfigPath: path.join(ymbRoot, 'ymb.config.yaml'),
    builderConfig,
    modRoot: rootPath,
    modsRoot: path.join(ymbRoot, builderConfig.paths.sourceMods),
    gameDataRoot: path.join(rootPath, 'GameData'),
    commonDataRoot: path.join(rootPath, 'CommonData'),
    buildRoot,
    buildOutputRoot: path.join(buildRoot, 'output'),
    buildCacheRoot: path.join(buildRoot, 'cache'),
    conflictPreviewRoot: path.join(buildRoot, 'conflicts'),
    stateRoot: path.join(ymbRoot, builderConfig.paths.recoveryRoot),
    operationLockRoot: path.join(ymbRoot, builderConfig.paths.operationLockRoot),
    stateTransactionRoot: path.join(ymbRoot, builderConfig.paths.stateTransactionRoot),
  };

  const mod: DiscoveredMod = {
    config: {
      version: 1,
      id: 'sample_pack',
      name: 'Sample Pack',
      dependsOn: [],
      priority: 0,
      allowWriteToModifiedFiles: false,
      enabled: true,
      scripts: [],
      tempPaths,
    },
    absolutePath: path.dirname(configDirectoryPath),
    configDirectoryPath,
    relativePathFromMods: 'sample-pack',
    configFilePath: path.join(configDirectoryPath, 'ymb.mod.yaml'),
    patches: [],
  };
  return { context, mod };
}

function createPatch(mod: DiscoveredMod, tempPaths: TempArtifactConfig[]): PatchApplication {
  const patch: DiscoveredPatch = {
    config: {
      version: 1,
      id: 'sample.armor',
      name: 'Sample Armor',
      enabled: true,
      scope: 'prod',
      dependsOn: [],
      files: [],
      targets: [],
      optional: false,
      scripts: [],
      tempPaths,
    },
    // The patch writes its temp paths into the mod's config root, which is how
    // one file ends up named by both owners.
    absolutePath: mod.configDirectoryPath,
    relativePathInMod: 'config',
    configFilePath: path.join(mod.configDirectoryPath, 'ymb.patch.yaml'),
  };
  return { mod, patch };
}
