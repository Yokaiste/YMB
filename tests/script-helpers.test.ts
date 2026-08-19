import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ScriptToolError } from '../src/api.ts';
import { createCooperativeYieldController } from '../src/async.ts';
import { toPathKey } from '../src/path-utils.ts';
import {
  dedupeScriptContributors,
  describeFileOwner,
  describeScriptOwner,
  toContributor,
} from '../src/scripts/contributors.ts';
import { resolveScriptBaseText } from '../src/scripts/text-state.ts';
import { createScriptNdfTools } from '../src/scripts/tools.ts';
import { createScriptValueTools } from '../src/scripts/value-tools.ts';
import type { ScriptApplication, WrittenBuildFile } from '../src/types.ts';
import {
  createTestBuilderContext,
  createTestBuildPlan,
  createTestScriptApplication,
} from './helpers/planner.ts';

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
    const context = createTestBuilderContext(tempRoot);
    const plan = createTestBuildPlan(context);
    const yieldController = createCooperativeYieldController();
    const targetRelativePath = 'CommonData/Text/generated.ndf';

    try {
      await mkdir(path.join(context.commonDataRoot, 'Text'), { recursive: true });
      await Bun.write(path.join(context.commonDataRoot, 'Text', 'generated.ndf'), 'from-disk\n');

      const existingGenerated = new Map<string, string>([
        [toPathKey(targetRelativePath), 'from-generated\n'],
      ]);
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
          yieldController,
        ),
      ).toBe('from-generated\n');

      expect(
        await resolveScriptBaseText(
          plan,
          targetRelativePath,
          new Map(),
          replaceOutput,
          new Map(),
          yieldController,
        ),
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
          yieldController,
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
          yieldController,
        ),
      ).toBe('');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('exposes builder-provided NDF tools with structured validation and path reads', () => {
    const ndf = createScriptNdfTools();
    const text = [
      'export Descriptor_Unit_Test is TEntityDescriptor',
      '(',
      '    ModulesDescriptors = [',
      '      TTypeUnitModuleDescriptor',
      '      (',
      "          MotherCountry = 'US'",
      '          Value = 1',
      '      ),',
      '      TModuleBar',
      '      (',
      '          Value = 2',
      '      )',
      '    ]',
      ')',
    ].join('\n');

    const blocks = ndf.findTopLevelBlocks(text);
    const block = ndf.findNamedBlock(text, 'Descriptor_Unit_Test');
    const modulesField = ndf.findField(block?.text ?? '', 'ModulesDescriptors');
    const motherCountryField = ndf.findFieldDeep(block?.text ?? '', 'MotherCountry');
    const entries = ndf.findCollectionEntries(modulesField?.valueText ?? '');
    const validResult = ndf.validate(text, 'Descriptor_Unit_Test.ndf');
    const invalidResult = ndf.validate('export Bad is TEntityDescriptor\n(\n', 'broken.ndf');

    expect(blocks).toHaveLength(1);
    expect(block?.typeName).toBe('TEntityDescriptor');
    expect(entries.map((entry) => entry.typeName)).toEqual([
      'TTypeUnitModuleDescriptor',
      'TModuleBar',
    ]);
    expect(motherCountryField?.valueText).toBe("'US'");
    expect(ndf.readPath(block?.text ?? '', ['ModulesDescriptors', '[Value=2]', 'Value'])).toBe('2');
    expect(ndf.formatValue({ Foo: 'Bar', Enabled: true })).toContain('Foo = Bar');
    expect(ndf.stripComments("Value = 1 // inline comment\n'// kept in string'\n")).toContain(
      "'// kept in string'",
    );
    expect(validResult).toEqual({ ok: true });
    expect(invalidResult.ok).toBe(false);
    expect(invalidResult.ok ? '' : invalidResult.error.absolutePath).toBe('broken.ndf');
  });

  test('validates reusable script values without coercing configuration policy', () => {
    const values = createScriptValueTools();
    const record = { enabled: true };

    expect(values.record(record, 'settings')).toBe(record);
    expect(values.string(' value ', 'name')).toBe(' value ');
    expect(values.optionalString(undefined, 'description')).toBeUndefined();
    expect(values.boolean(false, 'enabled')).toBe(false);
    expect(values.stringArray(['alpha', 'beta'], 'groups')).toEqual(['alpha', 'beta']);
    expect(values.oneOf('prod', 'scope', ['prod', 'dev'] as const)).toBe('prod');
    expect(values.positiveInteger('7', 'count')).toBe(7);

    const invalidCases: Array<() => unknown> = [
      () => values.record([], 'settings'),
      () => values.string(1, 'name'),
      () => values.optionalString(null, 'description'),
      () => values.boolean('true', 'enabled'),
      () => values.stringArray(['alpha', 2], 'groups'),
      () => values.oneOf('other', 'scope', ['prod', 'dev'] as const),
      () => values.positiveInteger(0, 'count'),
    ];
    for (const run of invalidCases) {
      expect(run).toThrow(ScriptToolError);
    }
  });
});

function createScriptApplication(): ScriptApplication {
  return createTestScriptApplication({ patchId: 'patch.one', patchName: 'Patch One' });
}
