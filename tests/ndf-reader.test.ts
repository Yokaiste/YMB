import { describe, expect, test } from 'bun:test';
import {
  findCollectionEntries,
  findCollectionEntryRange,
  findDirectFieldRange,
  findMatchingDelimiter,
  findNamedBlockByName,
  findNestedFieldRange,
  findTopLevelBlocks,
  readDirectFieldValue,
  readNestedFieldValue,
  readNestedPathValue,
} from '../src/patch/ndf/scan.ts';
import {
  formatNdfValue,
  normalizeSnippetIndentation,
  removeRange,
  selectorError,
  stripLineComments,
} from '../src/patch/ndf/shared.ts';
import { application } from './helpers/ndf.ts';

describe('ndf reader helpers', () => {
  test('finds standard, template, bare collection, and scalar top-level blocks', () => {
    const source = `export ExportedBlock is TDescriptor
(
    Value = 1
)

unnamed TAnonymous
(
    Value = 2
)

template TemplateBlock
[
    PanelColorStyle : string,
] is BUCKContainerDescriptor
(
    Value = 3
)

NamedCollection is
[
    "One",
]

NamedScalar is 10
`;

    const topLevelBlocks = findTopLevelBlocks(source);

    expect(topLevelBlocks).toHaveLength(2);
    expect(topLevelBlocks[0]?.name).toBe('ExportedBlock');
    expect(topLevelBlocks[1]?.typeName).toBe('TAnonymous');
    expect(findNamedBlockByName(source, 'TemplateBlock')?.typeName).toBe('template');
    expect(findNamedBlockByName(source, 'NamedCollection')?.text).toContain('"One"');
    expect(findNamedBlockByName(source, 'NamedScalar')?.text).toBe('NamedScalar is 10');
  });

  test('parses typed collection entries with nested structures and commas in strings', () => {
    const collection = `[
    TSoundEvent
    (
        Name = "Sound, With, Commas"
    ),
    TOtherEvent
    (
        Name = "Focus"
    )
]`;

    const entries = findCollectionEntries(collection);

    expect(entries).toHaveLength(2);
    expect(entries[0]?.typeName).toBe('TSoundEvent');
    expect(entries[0]?.text).toContain('Sound, With, Commas');
    expect(entries[1]?.typeName).toBe('TOtherEvent');
  });

  test('finds fields in large blocks without quadratic slowdown', () => {
    const fieldLines = Array.from({ length: 5000 }, (_, i) => `    Field_${i} = ${i}`).join('\n');
    const source = `export Big is TDescriptor\n(\n${fieldLines}\n)\n`;

    const startedAt = performance.now();
    const value = readDirectFieldValue(source, 'Field_4999');
    const elapsed = performance.now() - startedAt;

    expect(value?.trim()).toBe('4999');
    expect(elapsed).toBeLessThan(500);
  });

  test('reads fields across CRLF line endings and comment lines', () => {
    const source =
      'export Block is TDescriptor\r\n(\r\n    // comment\r\n    Alpha = 1\r\n    Beta = 2\r\n)\r\n';

    expect(readDirectFieldValue(source, 'Alpha')?.trim()).toBe('1');
    expect(readDirectFieldValue(source, 'Beta')?.trim()).toBe('2');
  });

  test('parses entries that start with quotes, tuples, and nested collections', () => {
    const collection = `[
    "Base",
    'YSM',
    (1, 2),
    [3, 4],
    Plain,
]`;

    const entries = findCollectionEntries(collection);

    expect(entries.map((entry) => entry.text)).toEqual([
      '"Base"',
      "'YSM'",
      '(1, 2)',
      '[3, 4]',
      'Plain',
    ]);
  });

  test('resolves collection entries by index, type, and nested field selectors', () => {
    const collection = `[
    TSoundEvent
    (
        Name = "Click"
    ),
    TSoundEvent
    (
        Name = "Hover"
    ),
    TOtherEvent
    (
        Name = "Focus"
    ),
]`;

    const byIndex = findCollectionEntryRange(
      collection,
      '[index:1]',
      application,
      'C:/fixture/UICommonResources.ndf',
      0,
    );
    const byType = findCollectionEntryRange(
      collection,
      '[type:TOtherEvent]',
      application,
      'C:/fixture/UICommonResources.ndf',
      0,
    );
    const byField = findCollectionEntryRange(
      collection,
      '[Name="Click"]',
      application,
      'C:/fixture/UICommonResources.ndf',
      0,
    );

    expect(byIndex.text).toContain('Hover');
    expect(byType.text).toContain('Focus');
    expect(byField.text).toContain('Click');
  });

  test('reads nested values through object fields and collection selectors', () => {
    const source = `InGameMainContainerResource is TUICommonMainContainerResource
(
    ForegroundComponents = BUCKContainerDescriptor
    (
        Components =
        [
            BUCKContainerDescriptor
            (
                UniqueName = "barre_du_haut"
                HasBackground = true
            )
        ]
    )
)
`;

    expect(
      readNestedPathValue(source, [
        'ForegroundComponents',
        'Components',
        '[UniqueName="barre_du_haut"]',
        'HasBackground',
      ]),
    ).toBe('true');
    expect(readNestedPathValue(source, ['ForegroundComponents', 'MissingField'])).toBeUndefined();
  });

  test('stops direct multiline field values before anonymous typed siblings', () => {
    const source = `CustomDescriptor_Laser is TWeaponManagerModuleDescriptor
(
    Salves =
    [
        2,
        4
    ]
    TMountedWeaponDescriptor
    (
        Ammunition = $/GFX/Weapon/Ammo_Custom_Laser
        AmmoBoxIndex = 0
        NbWeapons = 3
    )
)`;

    const field = findDirectFieldRange(source, 'Salves');

    expect(field).toBeDefined();
    expect(source.slice(field?.valueStart, field?.valueEnd).trim()).toBe(
      '[\n        2,\n        4\n    ]',
    );
  });

  test('finds nested fields inside module descriptors', () => {
    const source = `export Descriptor_Unit_Test is TEntityDescriptor
(
    ModulesDescriptors = [
        TTypeUnitModuleDescriptor
        (
            Coalition = TWargameCoalition/NATO
            MotherCountry = 'US'
        ),
        TProductionModuleDescriptor
        (
            FactoryType = Factory/Infantry
        )
    ]
)`;

    const motherCountry = findNestedFieldRange(source, 'MotherCountry');
    const factoryType = findNestedFieldRange(source, 'FactoryType');

    expect(source.slice(motherCountry?.valueStart, motherCountry?.valueEnd).trim()).toBe("'US'");
    expect(source.slice(factoryType?.valueStart, factoryType?.valueEnd).trim()).toBe(
      'Factory/Infantry',
    );
  });

  test('reads direct and nested field values through builder helpers', () => {
    const source = `export Descriptor_Unit_Test is TEntityDescriptor
(
    Name = 'TopLevel'
    ModulesDescriptors = [
        TTypeUnitModuleDescriptor
        (
            MotherCountry = 'US'
        )
    ]
)`;

    expect(readDirectFieldValue(source, 'Name')).toBe("'TopLevel'");
    expect(readNestedFieldValue(source, 'MotherCountry')).toBe("'US'");
  });

  test('stops nested scalar values before trailing comment markers and container close', () => {
    const source = `export Descriptor_Unit_Test is TEntityDescriptor
(
    ModulesDescriptors = [
        TTypeUnitModuleDescriptor
        (
            MotherCountry = 'YSM'

            // YMB-MODIFY-END {"id":"field","patchId":"test.patch"}
        ),
    ]
)`;

    expect(readNestedFieldValue(source, 'MotherCountry')).toBe("'YSM'");
  });

  test('matches delimiters while ignoring comments and quoted text', () => {
    const value = `[
    "// not a real delimiter ]",
    // ] this is a comment
    [
        1,
        2,
    ],
]`;

    expect(findMatchingDelimiter(value, 0, '[', ']')).toBe(value.lastIndexOf(']'));
  });

  test('formats scalar, path, object, array, and null values for NDF output', () => {
    expect(formatNdfValue('GameData/Path')).toBe('GameData/Path');
    expect(formatNdfValue("can't")).toBe(`"can't"`);
    expect(formatNdfValue(true)).toBe('True');
    expect(formatNdfValue(['A', 2, false])).toBe('[A, 2, False]');
    expect(formatNdfValue({ FrontArmor: 5, RearArmor: null })).toBe(
      '(\n    FrontArmor = 5\n    RearArmor = Nil\n)',
    );
  });

  test('normalizes snippet indentation, strips comments, and removes full lines cleanly', () => {
    const normalized = normalizeSnippetIndentation(
      `
            Alpha

                Bravo
      `,
      '    ',
    );
    const stripped = stripLineComments(`Value = "// keep"\n// remove me\nNext = 1\n`);
    const removed = removeRange('Alpha\nBravo\n', 0, 'Alpha'.length);

    expect(normalized).toBe('    Alpha\n    \n        Bravo');
    expect(stripped).toBe('Value = "// keep"\n\nNext = 1\n');
    expect(removed).toBe('Bravo\n');
  });

  test('builds structured selector errors for broken selector shapes', () => {
    const error = selectorError(
      { kind: 'object', by: 'path', value: 'Broken.Path' } as never,
      application,
      'C:/fixture/Units.ndf',
      2,
      'Unsupported selector mode.',
    );

    expect(error.category).toBe('SelectorError');
    expect(error.message).toContain(
      'Unsupported selector mode. Selector `object:path` is not supported here.',
    );
    expect(error.message).toContain('- operation: 2');
  });
});
