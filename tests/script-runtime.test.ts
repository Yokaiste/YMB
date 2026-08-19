import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BUILDER_CONFIG } from '../src/builder-config.ts';
import { hashText } from '../src/hash.ts';
import { executeScriptInProcess, runScript } from '../src/scripts/runtime.ts';
import {
  createScriptExecutionContext,
  createScriptTestExecutionContext,
} from '../src/scripts/runtime-context.ts';
import { normalizeScriptOutput } from '../src/scripts/runtime-output.ts';
import { setScriptTimeoutSecondsForTests } from '../src/scripts/runtime-shared.ts';
import type { BuilderContext, ScriptApplication, ScriptRuntimePlan } from '../src/types.ts';
import {
  createTestBuilderContext,
  createTestScriptApplication,
  createTestScriptRuntimePlan,
} from './helpers/planner.ts';

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

  test('normalizes delegated generated-block owner paths', () => {
    const script = createScriptApplication();
    expect(
      normalizeScriptOutput(
        script,
        {
          targetRelativePath: 'GameData/Generated/Summary.ndf',
          content: 'content',
          generatedBlockOwnerPaths: ['mods\\sample\\core.ts'],
        },
        0,
      ).generatedBlockOwnerPaths,
    ).toEqual(['mods/sample/core.ts']);
    expect(() =>
      normalizeScriptOutput(
        script,
        {
          targetRelativePath: 'GameData/Generated/Summary.ndf',
          content: 'content',
          generatedBlockOwnerPaths: [''],
        },
        0,
      ),
    ).toThrow('invalid generated-block owner paths');
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

      const { outputs } = await executeScriptInProcess(
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
        scriptDirectoryEntries.some((entry) => entry.startsWith(BUILDER_CONFIG.tempPrefix)),
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

      const { outputs } = await executeScriptInProcess(
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
          "  context.tools.assert.ok(context.tools.apiVersion === 4, { reason: 'Wrong API version.', suggestion: 'Update the script.' });",
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
      const { outputs: first } = await executeScriptInProcess(plan, script, new Map());
      const { outputs: second } = await executeScriptInProcess(plan, script, new Map());

      expect(first[0]?.content).toBe('7:miss');
      expect(second[0]?.content).toBe('7:hit');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('exposes immutable public context views without discovery internals', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ymb-runtime-public-context-'));
    const { context, script } = createTempScriptFixture(tempRoot);

    try {
      await mkdir(path.dirname(script.absolutePath), { recursive: true });
      await Bun.write(
        script.absolutePath,
        [
          'export default function generate(context) {',
          '  return {',
          "    targetRelativePath: 'CommonData/Text/context.json',",
          '    content: JSON.stringify({',
          '      frozen: [context.builder, context.selection, context.selection.modFilters, context.mod, context.patch, context.variables].every(Object.isFrozen),',
          '      mod: context.mod,',
          '      patch: context.patch,',
          "      leaksConfig: 'config' in context.mod,",
          "      leaksBuilderConfig: 'builderConfig' in context.builder,",
          '    }),',
          '  };',
          '}',
          '',
        ].join('\n'),
      );

      const {
        outputs: [output],
      } = await executeScriptInProcess(createScriptRuntimePlan(context), script, new Map());
      const publicContext = JSON.parse(String(output?.content)) as {
        frozen: boolean;
        mod: { id: string; name: string; rootPath: string };
        patch: { id: string; name: string; rootPath: string };
        leaksConfig: boolean;
        leaksBuilderConfig: boolean;
      };

      expect(publicContext.frozen).toBe(true);
      expect(publicContext.mod.id).toBe('sample_pack');
      expect(publicContext.mod.name).toBe('Sample Pack');
      expect(publicContext.mod.rootPath).toBe(script.mod.absolutePath);
      expect(publicContext.patch.id).toBe('patch.runtime');
      expect(publicContext.patch.rootPath).toBe(script.patch?.absolutePath ?? '');
      expect(publicContext.leaksConfig).toBe(false);
      expect(publicContext.leaksBuilderConfig).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('public contexts expose isolated authored-file and target I/O', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ymb-runtime-public-io-'));
    const { context, script } = createTempScriptFixture(tempRoot);
    const plan = createScriptRuntimePlan(context);
    const targetPath = path.join(context.gameDataRoot, 'Text', 'target.ndf');

    try {
      await mkdir(path.dirname(targetPath), { recursive: true });
      await Bun.write(targetPath, 'target text');
      const publicContext = createScriptExecutionContext(plan, script, new Map()).context;

      expect(await publicContext.writeOwnedTextIfChanged('state/owned.txt', 'owned')).toBe(true);
      expect(await publicContext.writeOwnedTextIfChanged('state/owned.txt', 'owned')).toBe(false);
      expect(await publicContext.readOwnedTextIfExists('state/owned.txt')).toBe('owned');
      expect(await publicContext.writeModTextIfChanged('state/mod.txt', 'mod')).toBe(true);
      expect(await publicContext.readModTextIfExists('state/mod.txt')).toBe('mod');
      expect(await publicContext.readTarget('GameData/Text/target.ndf')).toBe('target text');
      expect(await publicContext.readTargets(['GameData/Text/target.ndf'])).toEqual({
        'GameData/Text/target.ndf': 'target text',
      });
      expect(await publicContext.readBinaryTarget('GameData/Text/target.ndf')).toEqual(
        new TextEncoder().encode('target text'),
      );

      const outsidePath = path.join(tempRoot, 'outside-owned-root.txt');
      const linkedPath = path.join(script.patch?.absolutePath ?? '', 'linked-outside.txt');
      await Bun.write(outsidePath, 'outside');
      await symlink(outsidePath, linkedPath, 'file');
      await expect(publicContext.readOwnedTextIfExists('linked-outside.txt')).rejects.toThrow(
        'outside its owner script root',
      );

      const testExecution = createScriptTestExecutionContext(
        plan,
        script,
        new Map(),
        'generate.test.ts',
      );
      const existingVirtualPath = path.join(
        script.patch?.absolutePath ?? '',
        'already-current.txt',
      );
      await Bun.write(existingVirtualPath, 'current');
      expect(testExecution.context.script.path).toBe('generate.ts');
      expect(
        await testExecution.context.writeOwnedTextIfChanged('already-current.txt', 'current'),
      ).toBe(false);
      expect(await testExecution.context.writeOwnedTextIfChanged('missing-empty.txt', '')).toBe(
        true,
      );
      expect(await testExecution.context.writeOwnedTextIfChanged('virtual.txt', 'first')).toBe(
        true,
      );
      expect(await testExecution.context.writeOwnedTextIfChanged('virtual.txt', 'first')).toBe(
        false,
      );
      expect(await testExecution.context.readOwnedTextIfExists('virtual.txt')).toBe('first');
      expect(testExecution.getObservedTargetReads()).toEqual([]);
      expect(testExecution.getObservedScriptFileReads()).toEqual([
        {
          scope: 'owner',
          relativePath: 'already-current.txt',
          exists: true,
          contentHash: hashText('current'),
        },
        {
          scope: 'owner',
          relativePath: 'missing-empty.txt',
          exists: false,
          contentHash: hashText(''),
        },
        {
          scope: 'owner',
          relativePath: 'virtual.txt',
          exists: false,
          contentHash: hashText(''),
        },
      ]);
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

      setScriptTimeoutSecondsForTests(1);
      const attempt = runScript(createScriptRuntimePlan(context), script, new Map());
      await expect(attempt).rejects.toThrow('timed out after 1s and was terminated');
    } finally {
      setScriptTimeoutSecondsForTests(undefined);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

function createScriptApplication(): ScriptApplication {
  return createTestScriptApplication({ patchId: 'patch.runtime', patchName: 'Runtime Patch' });
}

function createTempScriptFixture(tempRoot: string): {
  context: BuilderContext;
  script: ScriptApplication;
} {
  return {
    context: createTestBuilderContext(tempRoot),
    script: createTestScriptApplication({
      patchId: 'patch.runtime',
      patchName: 'Runtime Patch',
      modsRoot: path.join(tempRoot, 'YMB', 'mods'),
    }),
  };
}

function createScriptRuntimePlan(context: BuilderContext): ScriptRuntimePlan {
  return createTestScriptRuntimePlan(context, { useCache: true });
}
