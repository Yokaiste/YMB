import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  dedupeScriptContributors,
  describeFileOwner,
  describeScriptOwner,
  toContributor,
} from '../src/scripts/contributors.ts';
import { resolveScriptBaseText } from '../src/scripts/text-state.ts';
import type {
  BuilderContext,
  BuildPlan,
  DiscoveredMod,
  DiscoveredPatch,
  ModConfig,
  PatchConfig,
  ScriptApplication,
  WrittenBuildFile,
} from '../src/types.ts';

describe('script helpers', () => {
  test('describes and dedupes script contributors', () => {
    const script = createScriptApplication();
    const file: WrittenBuildFile = {
      targetRelativePath: 'CommonData/Text/generated.ndf',
      sourceType: 'script',
      content: 'content',
      contributors: [
        { modId: 'sample_pack', modName: 'Sample Pack', patchId: 'patch.one' },
        { modId: 'sample_pack', modName: 'Sample Pack', patchId: 'patch.two' },
      ],
    };

    expect(describeScriptOwner(script)).toBe('sample_pack:patch.one');
    expect(toContributor(script)).toEqual({
      modId: 'sample_pack',
      modName: 'Sample Pack',
      patchId: 'patch.one',
    });
    expect(describeFileOwner(file)).toBe(
      'script:CommonData/Text/generated.ndf:sample_pack:patch.one, sample_pack:patch.two',
    );
    expect(
      dedupeScriptContributors([
        { modId: 'sample_pack', modName: 'Sample Pack', patchId: 'patch.one' },
        { modId: 'sample_pack', modName: 'Sample Pack', patchId: 'patch.one' },
        { modId: 'sample_pack', modName: 'Sample Pack', patchId: 'patch.two' },
      ]),
    ).toEqual([
      { modId: 'sample_pack', modName: 'Sample Pack', patchId: 'patch.one' },
      { modId: 'sample_pack', modName: 'Sample Pack', patchId: 'patch.two' },
    ]);
  });

  test('resolves script base text from generated cache, existing text outputs, filesystem, and missing targets', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ymb-script-helpers-'));
    const context = createContext(tempRoot);
    const plan = createPlan(context);
    const targetRelativePath = 'CommonData/Text/generated.ndf';

    try {
      await mkdir(path.join(context.commonDataRoot, 'Text'), { recursive: true });
      await Bun.write(path.join(context.commonDataRoot, 'Text', 'generated.ndf'), 'from-disk\n');

      const existingGenerated = new Map<string, string>([[targetRelativePath, 'from-generated\n']]);
      const replaceOutput: WrittenBuildFile = {
        targetRelativePath,
        sourceType: 'replace',
        content: 'from-replace\n',
        contributors: [],
      };

      expect(
        await resolveScriptBaseText(
          plan,
          targetRelativePath,
          existingGenerated,
          replaceOutput,
          new Map(),
        ),
      ).toBe('from-generated\n');

      expect(
        await resolveScriptBaseText(plan, targetRelativePath, new Map(), replaceOutput, new Map()),
      ).toBe('from-replace\n');

      expect(
        await resolveScriptBaseText(
          plan,
          targetRelativePath,
          new Map(),
          {
            targetRelativePath,
            sourceType: 'script',
            content: 'ignored-script-output\n',
            contributors: [],
          },
          new Map(),
        ),
      ).toBe('from-disk\n');

      expect(
        await resolveScriptBaseText(
          plan,
          'CommonData/Text/missing.ndf',
          new Map(),
          {
            targetRelativePath: 'CommonData/Text/missing.ndf',
            sourceType: 'script',
            content: 'ignored-script-output\n',
            contributors: [],
          },
          new Map(),
        ),
      ).toBe('');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

function createContext(modRoot: string): BuilderContext {
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

function createPlan(context: BuilderContext): BuildPlan {
  return {
    context,
    selection: {
      scope: 'prod',
      modFilters: [],
      patchFilters: [],
      dryRun: true,
      verbose: false,
      yes: false,
    },
    discoveredMods: [],
    selectedMods: [],
    selectedPatches: [],
    selectedReplaceFiles: [],
    selectedScripts: [],
    explanations: [],
    targetFiles: [],
  };
}

function createScriptApplication(): ScriptApplication {
  const modConfig: ModConfig = {
    version: 1,
    id: 'sample_pack',
    name: 'Sample Pack',
    dependsOn: [],
    priority: 0,
    allowWriteToModifiedFiles: false,
    enabled: true,
    scripts: [],
    tempPaths: [],
  };
  const patchConfig: PatchConfig = {
    version: 1,
    id: 'patch.one',
    name: 'Patch One',
    enabled: true,
    scope: 'prod',
    dependsOn: [],
    targets: [],
    scripts: [],
    tempPaths: [],
  };
  const mod: DiscoveredMod = {
    config: modConfig,
    absolutePath: path.resolve('mods', 'sample_pack'),
    configAbsolutePath: path.resolve('mods', 'sample_pack', 'config'),
    relativePathFromMods: 'sample_pack',
    absoluteConfigPath: path.resolve('mods', 'sample_pack', 'config', 'ymb.mod.yaml'),
    patches: [],
  };
  const patch: DiscoveredPatch = {
    config: patchConfig,
    absolutePath: path.resolve('mods', 'sample_pack', 'config', 'patch', 'patch.one'),
    relativePathInMod: 'config/patch/patch.one',
    absoluteConfigPath: path.resolve(
      'mods',
      'sample_pack',
      'config',
      'patch',
      'patch.one',
      'ymb.patch.yaml',
    ),
  };

  return {
    mod,
    patch,
    config: { path: 'generate.ts', enabled: true, tests: [] },
    absolutePath: path.resolve(
      'mods',
      'sample_pack',
      'config',
      'patch',
      'patch.one',
      'generate.ts',
    ),
    testAbsolutePaths: [],
  };
}
