import { expect, test } from 'bun:test';
import { matchesBlock } from '../src/patch/ndf/bulk.ts';
import { createScriptPatchTool } from '../src/scripts/patch-tool.ts';
import { SCRIPT_NDF_TOOLS } from '../src/scripts/tools.ts';
import type { BulkOperation, PatchTarget } from '../src/types.ts';
import { application, applyPatchTarget, expectYmbError } from './helpers/ndf.ts';
import {
  createTestBuilderContext,
  createTestBuildPlan,
  createTestScriptApplication,
} from './helpers/planner.ts';

const ndf = SCRIPT_NDF_TOOLS;
const file = 'GameData/Sample.ndf';

test('exact matching accounts for equivalent values even when another condition rejects a block', () => {
  const block = ndf.findObjects('Sample is TItem(Category = 1)')[0];
  expect(block).toBeDefined();
  if (!block) return;
  const unreached = [new Set(['TOther']), new Set(['1', '1.0', '10'])];
  expect(
    matchesBlock(
      block,
      {
        mode: 'all',
        conditions: [
          { on: 'type', is: 'equals', value: ['TOther'] },
          { on: 'field', field: 'Category', is: 'equals', value: ['1', '1.0', '10'] },
        ],
      },
      unreached,
    ),
  ).toBe(false);
  expect([...(unreached[1] ?? [])]).toEqual(['10']);
});

test('script patches share template expansion, validation, and path guards', async () => {
  const plan = createTestBuildPlan(createTestBuilderContext('patch-fixture'));
  const script = createTestScriptApplication({ patchId: 'sample' });
  script.mod.config.variables = { multiplier: 3 };
  const patch = createScriptPatchTool(plan, script);
  const source = 'Root is TItem(Value = 5)';
  const operations = [
    {
      op: 'bulk',
      match: { conditions: [{ on: 'type', is: 'equals', value: 'TItem' }] },
      edits: [{ field: 'Value', multiply: '${multiplier}' }],
    },
  ];
  expect(await patch(source, { file, operations })).toContain('Value = 15');
  await expectYmbError(() => patch(source, { file: '../Outside.ndf', operations }), 'LayoutError');
  await expectYmbError(
    () => patch(source, { file, operations: [{ op: 'unknown' }] }),
    'SchemaError',
  );
  const modScript = createScriptPatchTool(plan, { ...script, patch: undefined });
  expect(await modScript(source, { file, operations })).toContain('Value = 15');
});

test('recursive bulk isolates siblings and exact values ignore numeric prefixes and comments', async () => {
  const source = `Root is TContainer (
    Help = 'TAmmo(Category = 1 Value = 999)'
    Items = [ TAmmo // type comment
      (Category = 1.0 // category comment
       Value = 10), TAmmo(Category = 10 Value = 20), TAmmo(Category = 11 Value = 30), TAmmo(Value = 40) ]
  )`;
  const operation: BulkOperation = {
    op: 'bulk',
    recursive: true,
    match: {
      mode: 'all',
      conditions: [
        { on: 'type', is: 'equals', value: ['TAmmo'] },
        { on: 'field', field: 'Category', is: 'equals', value: ['1'] },
      ],
    },
    expect: { minBlocks: 1 },
    edits: [{ field: 'Value', multiply: 2, minChanges: 1 }],
  };
  const result = await applyPatchTarget(
    source,
    { file, operations: [operation] },
    application,
    `C:/${file}`,
  );
  const values = ndf
    .findObjects(result)
    .filter((block) => block.typeName === 'TAmmo')
    .map((block) => ndf.readField(block.text, 'Value'));
  expect(values).toEqual(['20', '20', '30', '40']);
  expect(result).toContain("Help = 'TAmmo(Category = 1 Value = 999)'");
  const different = ndf.matcher({
    conditions: [{ on: 'field', field: 'Category', is: 'notEquals', value: '1' }],
  });
  expect(
    ndf
      .findObjects(source)
      .filter((block) => block.typeName === 'TAmmo')
      .map(different),
  ).toEqual([false, true, true, false]);
});

test('recursive bulk rejects overlapping parent and child matches', async () => {
  await expectYmbError(
    () =>
      applyPatchTarget(
        'Root is TItem(Child = TItem(Value = 2))',
        {
          file,
          operations: [
            {
              op: 'bulk',
              recursive: true,
              match: { mode: 'all', conditions: [{ on: 'type', is: 'equals', value: ['TItem'] }] },
              expect: { minBlocks: 2 },
              edits: [{ field: 'Value', multiply: 2 }],
            },
          ],
        },
        application,
        `C:/${file}`,
      ),
    'SelectorError',
  );
});

test('numeric definitions exclude comments, strings and nested declarations', () => {
  expect(
    ndf.readNumericDefinitions(`// Fake is 9
    First is 41
    export Second is 1.0e2
    Root is TContainer(Text = 'Hidden is 88' Values = [Nested is 11])
    Last is -2 // Last value
    Expression is 10 * 20
  `),
  ).toEqual({ First: 41, Second: 100, Last: -2 });
});

test('exact string predicates do not select a longer effect name', () => {
  const objects = ndf.findObjects(
    "First is TItem(Effect = 'Impact') Second is TItem(Effect = 'ImpactLarge')",
  );
  expect(
    objects
      .filter(
        ndf.matcher({
          conditions: [{ on: 'field', field: 'Effect', is: 'equals', value: 'Impact' }],
        }),
      )
      .map((block) => block.name),
  ).toEqual(['First']);
});

test('copy can allocate stable identities without changing GUID references or source identities', async () => {
  const guid = '11111111-2222-3333-4444-555555555555';
  const source = `Source is TContainer (
    DescriptorId = GUID:{${guid}} // root identity
    Ref = GUID:{${guid}}
    Child = TItem(DescriptorId = GUID:{${guid}})
    // DescriptorId = GUID:{${guid}}
    Help = 'DescriptorId = GUID:{${guid}}'
  )`;
  const target: PatchTarget = {
    file,
    operations: [
      {
        op: 'copy',
        reidentify: true,
        selector: { kind: 'object', by: 'name', value: 'Source' },
        destination: { name: 'Copy' },
      },
    ],
  };
  const first = await applyPatchTarget(source, target, application, `C:/one/${file}`);
  const second = await applyPatchTarget(source, target, application, `D:/two/${file}`);
  const copy = ndf.findNamedBlock(first, 'Copy');
  expect(copy).toBeDefined();
  expect(copy?.text).toBe(ndf.findNamedBlock(second, 'Copy')?.text);
  const ids = ndf
    .findObjects(copy?.text ?? '')
    .map((block) => ndf.readField(block.text, 'DescriptorId'));
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
  expect(ids.every((id) => id !== `GUID:{${guid}}`)).toBe(true);
  expect(copy?.text).toContain(`Ref = GUID:{${guid}}`);
  expect(copy?.text).toContain(`// DescriptorId = GUID:{${guid}}`);
  expect(ndf.findNamedBlock(first, 'Source')?.text).toBe(source);
  expect(await applyPatchTarget(first, target, application, `C:/one/${file}`)).toBe(first);
  const other = await applyPatchTarget(
    source,
    {
      file,
      operations: [
        {
          ...target.operations[0],
          destination: { name: 'Other' },
        } as (typeof target.operations)[number],
      ],
    },
    application,
    `C:/one/${file}`,
  );
  expect(ndf.readField(ndf.findNamedBlock(other, 'Other')?.text ?? '', 'DescriptorId')).not.toBe(
    ids[0],
  );
});
