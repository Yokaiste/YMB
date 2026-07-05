import { afterEach, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { resolvePrioritizedModId } from '../src/patch-priority.ts';
import type {
  BuilderContext,
  DiscoveredMod,
  DiscoveredPatch,
  ModConfig,
  PatchConfig,
} from '../src/types.ts';

const stdinTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const stdoutTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

afterEach(() => {
  restoreDescriptor(process.stdin, 'isTTY', stdinTtyDescriptor);
  restoreDescriptor(process.stdout, 'isTTY', stdoutTtyDescriptor);
});

describe('patch priority prompts', () => {
  test('fails fast when patch priority selection is required in a non-interactive terminal', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });

    await expect(
      resolvePrioritizedModId(createContext(), 'GameData/Generated/Test.ndf', 'BaseText', [
        createContribution('alpha_pack', 'Alpha Pack', 'patch.alpha', 'AlphaText'),
        createContribution('bravo_pack', 'Bravo Pack', 'patch.bravo', 'BravoText'),
      ]),
    ).rejects.toThrow('requires an interactive terminal');
  });
});

function createContribution(
  modId: string,
  modName: string,
  patchId: string,
  previewContent: string,
) {
  return {
    application: createApplication(modId, modName, patchId),
    targetRelativePath: 'GameData/Generated/Test.ndf',
    hasScripts: false,
    previewContent,
  };
}

function createApplication(modId: string, modName: string, patchId: string) {
  const modConfig: ModConfig = {
    version: 1,
    id: modId,
    name: modName,
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
    targets: [{ file: 'GameData/Generated/Test.ndf', operations: [] }],
    scripts: [],
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

function restoreDescriptor(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
    return;
  }

  Reflect.deleteProperty(target, key);
}
