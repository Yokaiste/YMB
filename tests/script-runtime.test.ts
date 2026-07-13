import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BUILDER_CONFIG } from '../src/builder-config.ts';
import { executeScriptInProcess, runScript } from '../src/scripts/runtime.ts';
import { normalizeScriptOutput } from '../src/scripts/runtime-output.ts';
import { setScriptTimeoutSecondsForTesting } from '../src/scripts/runtime-shared.ts';
import type {
  BuilderContext,
  DiscoveredMod,
  DiscoveredPatch,
  ModConfig,
  PatchConfig,
  ScriptApplication,
  ScriptRuntimePlan,
} from '../src/types.ts';

describe('script runtime output', () => {
  test('normalizes Windows target separators to game-relative slashes', () => {
    const script = createScriptApplication();

    expect(
      normalizeScriptOutput(
        script,
        {
          targetRelativePath: 'GameData\\Generated\\Gameplay\\Summary.ndf',
          content: 'content',
        },
        0,
      ),
    ).toEqual({
      targetRelativePath: 'GameData/Generated/Gameplay/Summary.ndf',
      content: 'content',
    });
  });

  test('rejects outputs with unsupported content', () => {
    const script = createScriptApplication();

    expect(() =>
      normalizeScriptOutput(
        script,
        {
          targetRelativePath: 'GameData/Generated/Gameplay/Summary.ndf',
          content: 123 as unknown as string,
        },
        0,
      ),
    ).toThrow('unsupported content');
  });

  test('executes scripts through the original source path without leaving runtime temp files behind', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ymb-runtime-import-'));
    const { context, script } = createTempScriptFixture(tempRoot);

    try {
      await mkdir(path.dirname(script.absolutePath), { recursive: true });
      await mkdir(context.ymbRoot, { recursive: true });
      await Bun.write(
        path.join(path.dirname(script.absolutePath), 'helper.ts'),
        "export const suffix = 'relative-import-ok';\n",
      );
      await Bun.write(
        script.absolutePath,
        "import { suffix } from './helper.ts';\nexport default async function generate() {\n  return {\n    targetRelativePath: 'CommonData/Text/generated.ndf',\n    content: `Generated ${suffix}`,\n  };\n}\n",
      );

      const outputs = await executeScriptInProcess(
        createScriptRuntimePlan(context),
        script,
        new Map(),
      );
      const scriptDirectoryEntries = await readdir(path.dirname(script.absolutePath), {
        encoding: 'utf8',
      });

      expect(outputs).toEqual([
        {
          targetRelativePath: 'CommonData/Text/generated.ndf',
          content: 'Generated relative-import-ok',
        },
      ]);
      expect(
        scriptDirectoryEntries.some((entry) => entry.startsWith(BUILDER_CONFIG.runtimeTempPrefix)),
      ).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('provides builder tools to scripts through context.tools.ndf', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ymb-runtime-tools-'));
    const { context, script } = createTempScriptFixture(tempRoot);

    try {
      await mkdir(path.dirname(script.absolutePath), { recursive: true });
      await Bun.write(
        script.absolutePath,
        [
          'export default async function generate(context) {',
          '  const text = [',
          "    'export Descriptor_Unit_Test is TEntityDescriptor',",
          "    '(' ,",
          "    '    ModulesDescriptors = [',",
          "    '      TTypeUnitModuleDescriptor',",
          "    '      (',",
          '    "          MotherCountry = \'US\'",',
          "    '          Value = 1',",
          "    '      ),',",
          "    '      TModuleBar',",
          "    '      (',",
          "    '          Value = 2',",
          "    '      )',",
          "    '    ]',",
          "    ')',",
          "  ].join('\\n');",
          '  const block = context.tools.ndf.findNamedBlock(text, "Descriptor_Unit_Test");',
          '  const modulesField = context.tools.ndf.findField(block?.text ?? "", "ModulesDescriptors");',
          '  const motherCountryField = context.tools.ndf.findFieldDeep(block?.text ?? "", "MotherCountry");',
          '  const entries = context.tools.ndf.findCollectionEntries(modulesField?.valueText ?? "");',
          '  context.tools.ndf.assertValid(text, "runtime-tools.ndf");',
          '  return {',
          "    targetRelativePath: 'CommonData/Text/generated.ndf',",
          '    content: JSON.stringify({',
          '      entryTypes: entries.map((entry) => entry.typeName),',
          '      motherCountry: motherCountryField?.valueText,',
          '      selectedValue: context.tools.ndf.readPath(block?.text ?? "", ["ModulesDescriptors", "[Value=2]", "Value"]),',
          '    }),',
          '  };',
          '}',
          '',
        ].join('\n'),
      );

      const outputs = await executeScriptInProcess(
        createScriptRuntimePlan(context),
        script,
        new Map(),
      );

      expect(outputs).toEqual([
        {
          targetRelativePath: 'CommonData/Text/generated.ndf',
          content: JSON.stringify({
            entryTypes: ['TTypeUnitModuleDescriptor', 'TModuleBar'],
            motherCountry: "'US'",
            selectedValue: '2',
          }),
        },
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('provides assertions, strict values, and integrity-checked JSON caching', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ymb-runtime-api-'));
    const { context, script } = createTempScriptFixture(tempRoot);

    try {
      await mkdir(path.dirname(script.absolutePath), { recursive: true });
      await Bun.write(
        script.absolutePath,
        [
          'export default async function generate(context) {',
          "  context.tools.assert.ok(context.tools.apiVersion === 3, { reason: 'Wrong API version.', suggestion: 'Update the script.' });",
          "  const value = context.tools.values.positiveInteger('7', 'test.value');",
          "  const key = await context.tools.cache.createKey({ purpose: 'runtime-test' });",
          "  const cached = await context.tools.cache.readJson('runtime-test', key, (candidate) => candidate?.value === 7);",
          "  await context.tools.cache.writeJson('runtime-test', key, { value });",
          '  return {',
          "    targetRelativePath: 'CommonData/Text/generated.ndf',",
          "    content: `${value}:${cached ? 'hit' : 'miss'}` ,",
          '  };',
          '}',
          '',
        ].join('\n'),
      );

      const plan = createScriptRuntimePlan(context);
      const first = await executeScriptInProcess(plan, script, new Map());
      const second = await executeScriptInProcess(plan, script, new Map());

      expect(first[0]?.content).toBe('7:miss');
      expect(second[0]?.content).toBe('7:hit');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('reports builder assertion failures with mod-script guidance', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ymb-runtime-assert-'));
    const { context, script } = createTempScriptFixture(tempRoot);

    try {
      await mkdir(path.dirname(script.absolutePath), { recursive: true });
      await Bun.write(
        script.absolutePath,
        [
          'export default function generate(context) {',
          "  context.tools.assert.ok(false, { reason: 'Required input is missing.', suggestion: 'Restore the required input.' });",
          '}',
          '',
        ].join('\n'),
      );

      await expect(
        executeScriptInProcess(createScriptRuntimePlan(context), script, new Map()),
      ).rejects.toThrow('Required input is missing.');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('aggregates grouped self-check failures', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ymb-runtime-checks-'));
    const { context, script } = createTempScriptFixture(tempRoot);

    try {
      await mkdir(path.dirname(script.absolutePath), { recursive: true });
      await Bun.write(
        script.absolutePath,
        [
          'export default async function generate(context) {',
          '  await context.tools.assert.all([',
          "    { name: 'first', run: () => context.tools.assert.ok(false, { reason: 'First failed.', suggestion: 'Fix first.' }) },",
          "    { name: 'second', run: () => { throw new Error('Second failed.'); } },",
          '  ]);',
          '}',
          '',
        ].join('\n'),
      );

      await expect(
        executeScriptInProcess(createScriptRuntimePlan(context), script, new Map()),
      ).rejects.toThrow('2 script self-checks failed.');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects non-JSON cache values instead of silently dropping them', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ymb-runtime-cache-value-'));
    const { context, script } = createTempScriptFixture(tempRoot);

    try {
      await mkdir(path.dirname(script.absolutePath), { recursive: true });
      await Bun.write(
        script.absolutePath,
        [
          'export default async function generate(context) {',
          '  const value = {};',
          '  value.self = value;',
          "  await context.tools.cache.writeJson('runtime-test', 'cyclic', value);",
          '}',
          '',
        ].join('\n'),
      );

      await expect(
        executeScriptInProcess(createScriptRuntimePlan(context), script, new Map()),
      ).rejects.toThrow('Script cache value is not JSON-serializable.');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('script runtime subprocess', () => {
  test('kills a hanging generation script and reports a timeout error', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ymb-runtime-timeout-'));
    const { context, script } = createTempScriptFixture(tempRoot);

    try {
      await mkdir(path.dirname(script.absolutePath), { recursive: true });
      await mkdir(context.ymbRoot, { recursive: true });
      await Bun.write(
        script.absolutePath,
        'export default async function generate() {\n  await new Promise(() => {});\n}\n',
      );

      setScriptTimeoutSecondsForTesting(1);
      const attempt = runScript(createScriptRuntimePlan(context), script, new Map());
      await expect(attempt).rejects.toThrow('timed out after 1s and was terminated');
    } finally {
      setScriptTimeoutSecondsForTesting(undefined);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

function createScriptApplication(): ScriptApplication {
  return createScriptApplicationAtRoot(path.resolve());
}

function createTempScriptFixture(tempRoot: string): {
  context: BuilderContext;
  script: ScriptApplication;
} {
  return {
    context: createContext(tempRoot),
    script: createScriptApplicationAtRoot(tempRoot),
  };
}

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

function createScriptRuntimePlan(context: BuilderContext): ScriptRuntimePlan {
  return {
    context,
    selection: {
      scope: 'prod',
      modFilters: [],
      patchFilters: [],
      dryRun: true,
      verbose: false,
      yes: false,
      useCache: true,
    },
    selectedReplaceFiles: [],
  };
}

function createScriptApplicationAtRoot(rootPath: string): ScriptApplication {
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
    id: 'patch.runtime',
    name: 'Runtime Patch',
    enabled: true,
    scope: 'prod',
    dependsOn: [],
    targets: [],
    scripts: [],
    tempPaths: [],
  };
  const mod: DiscoveredMod = {
    config: modConfig,
    absolutePath: path.join(rootPath, 'YMB', 'mods', 'sample_pack'),
    configAbsolutePath: path.join(rootPath, 'YMB', 'mods', 'sample_pack', 'config'),
    relativePathFromMods: 'sample_pack',
    absoluteConfigPath: path.join(rootPath, 'YMB', 'mods', 'sample_pack', 'config', 'ymb.mod.yaml'),
    patches: [],
  };
  const patch: DiscoveredPatch = {
    config: patchConfig,
    absolutePath: path.join(
      rootPath,
      'YMB',
      'mods',
      'sample_pack',
      'config',
      'patch',
      'patch.runtime',
    ),
    relativePathInMod: 'config/patch/patch.runtime',
    absoluteConfigPath: path.join(
      rootPath,
      'YMB',
      'mods',
      'sample_pack',
      'config',
      'patch',
      'patch.runtime',
      'ymb.patch.yaml',
    ),
  };

  return {
    mod,
    patch,
    config: { path: 'generate.ts', enabled: true, tests: [] },
    absolutePath: path.join(
      rootPath,
      'YMB',
      'mods',
      'sample_pack',
      'config',
      'patch',
      'patch.runtime',
      'generate.ts',
    ),
    testAbsolutePaths: [],
  };
}
