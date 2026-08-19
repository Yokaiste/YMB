import { describe, expect, test } from 'bun:test';
import { stripLineComments } from '../src/patch/ndf/comments.ts';
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
  splitNdfPath,
} from '../src/patch/ndf/scan.ts';
import {
  formatNdfValue,
  normalizeSnippetIndentation,
  removeRange,
  selectorError,
  toPatchErrorIdentity,
} from '../src/patch/ndf/shared.ts';
import { application } from './helpers/ndf.ts';

const identity = (absolutePath: string) => toPatchErrorIdentity(application, absolutePath, 0);

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

  /** Pinning the name or the body opener to a line boundary hid most of the templates WARNO ships. */
  describe('template header spellings', () => {
    const bodyOf = (source: string, name: string) =>
      findNamedBlockByName(source, name)?.text.replace(/\s+/g, ' ');

    test('reads the parameter list on the name line, the next line, or with no line break at all', () => {
      const headers = [
        'template Sample\n[\n    Size,\n] is TShape\n(\n    Size = <Size>\n)',
        'template Sample [ Size ] is TShape\n(\n    Size = <Size>\n)',
        'template Sample[Size] is TShape (\n    Size = <Size>\n)',
        'template Sample\n[\n    Size,\n]\nis TShape\n(\n    Size = <Size>\n)',
        'export template Sample [ Size ] is TShape ( Size = <Size> )',
        'private template Sample [] is TShape ( Size = <Size> )',
        ' template Sample [ Size ] is TShape\n(\n    Size = <Size>\n)',
      ];

      for (const header of headers) {
        const block = findNamedBlockByName(`${header}\n`, 'Sample');
        expect(block?.typeName, header).toBe('template');
        // The block starts at the declaration, never at the indentation before it.
        expect(block?.text.startsWith(' '), header).toBeFalse();
        expect(block?.text.replace(/\s+/g, ' '), header).toEndWith('Size = <Size> )');
      }
    });

    test('stops at the end of the template it read', () => {
      const source = `template First [ A ] is TShape
(
    Value = <A>
)

template Second [ B ] is TShape
(
    Value = <B>
)
`;

      expect(bodyOf(source, 'First')).toBe('template First [ A ] is TShape ( Value = <A> )');
      expect(bodyOf(source, 'Second')).toBe('template Second [ B ] is TShape ( Value = <B> )');
    });

    test('ignores a template nested inside another block', () => {
      const source = `export Descriptor_Unit_A is TEntityDescriptor
(
    Items =
    [
template Nested [ A ] is TShape ( Value = <A> ),
    ]
)
`;

      expect(findNamedBlockByName(source, 'Nested')).toBeUndefined();
    });

    test('refuses a template whose parameter list or body is never closed', () => {
      expect(
        findNamedBlockByName('template Sample [ A is TShape\n(\n)\n', 'Sample'),
      ).toBeUndefined();
      expect(
        findNamedBlockByName('template Sample [ A ] is TShape\n(\n', 'Sample'),
      ).toBeUndefined();
    });
  });

  /** Anything spelled like a declaration and written flush against the margin looked top-level, even nested or inside a string. */
  describe('names that only look top-level', () => {
    test('ignores a declaration nested inside another block, however it is indented', () => {
      for (const indent of ['', '        ']) {
        const source = `export Descriptor_Unit_A is TEntityDescriptor
(
    Items =
    [
${indent}Shared is Template_Param_Float( DefaultValue = 10 ),
    ]
)
`;
        expect(findTopLevelBlocks(source).map((block) => block.name)).toEqual([
          'Descriptor_Unit_A',
        ]);
        expect(findNamedBlockByName(source, 'Shared')).toBeUndefined();
      }
    });

    test('ignores a declaration that only exists inside a string', () => {
      const source = `export Descriptor_Unit_A is TEntityDescriptor
(
    Note = "
Ghost is 10
"
)
`;

      expect(findNamedBlockByName(source, 'Ghost')).toBeUndefined();
    });

    test('still finds a real top-level scalar after a nested one of the same name', () => {
      const source = `export Descriptor_Unit_A is TEntityDescriptor
(
    Items =
    [
Shared is Template_Param_Float( DefaultValue = 10 ),
    ]
)

Shared is 42
`;

      // The nested one is skipped rather than ending the search.
      expect(findNamedBlockByName(source, 'Shared')?.text).toBe('Shared is 42');
    });

    test('still finds real top-level collections and templates after nested lookalikes', () => {
      const source = `export Descriptor_Unit_A is TEntityDescriptor
(
    Items =
    [
SharedCollection is
[
    "Nested",
]
template SharedTemplate
[
] is TNested
(
)
    ]
)

SharedCollection is
[
    "TopLevel",
]

template SharedTemplate
[
] is TTopLevel
(
    Value = 1
)
`;

      expect(findNamedBlockByName(source, 'SharedCollection')?.text).toContain('"TopLevel"');
      expect(findNamedBlockByName(source, 'SharedTemplate')?.text).toContain('Value = 1');
    });
  });

  /** An unbalanced target has to resolve to nothing rather than to a backwards range. */
  test('refuses a bare named collection whose bracket is never closed', () => {
    const source = `MyList is
[
    "One",
    "Two",
`;

    expect(findNamedBlockByName(source, 'MyList')).toBeUndefined();
  });

  test('finds a bare collection after bracket-shaped comments', () => {
    const source = `MyList is
// [ old shape removed in a game update
[
    "One",
]
`;

    expect(findNamedBlockByName(source, 'MyList')?.text).toContain('"One"');
  });

  test('does not borrow an opener from a later declaration', () => {
    const source = `Broken is
NotACollection

Later is
[
    "One",
]
`;

    expect(findNamedBlockByName(source, 'Broken')?.text).toBe('Broken is');
    expect(findNamedBlockByName(source, 'Later')?.text).toContain('"One"');
  });

  test('finds top-level blocks in flattened cooked NDF', () => {
    const source =
      'export Descriptor_Missile_ATGM_TOW is TMissileDescriptor ( PhysicalDamages = 10 ) ' +
      'export Descriptor_Missile_AGM_Maverick is TMissileDescriptor ( PhysicalDamages = 20 ) ' +
      'unnamed TAnonymous ( Value = 3 )';

    const blocks = findTopLevelBlocks(source);

    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.name).toBe('Descriptor_Missile_ATGM_TOW');
    expect(blocks[1]?.name).toBe('Descriptor_Missile_AGM_Maverick');
    expect(blocks[2]?.typeName).toBe('TAnonymous');
    expect(
      readDirectFieldValue(
        findNamedBlockByName(source, 'Descriptor_Missile_AGM_Maverick')?.text ?? '',
        'PhysicalDamages',
      ),
    ).toBe('20');
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

  test('reads each field of a block written on one line', () => {
    const source = "Block is TTemplate(Alpha = 'first' Beta = TNested(Inner = 1) Gamma = 3)\n";

    // `Alpha` is written hard against the opening paren, and every value here is
    // followed by a sibling rather than a newline.
    expect(readDirectFieldValue(source, 'Alpha')?.trim()).toBe("'first'");
    expect(readDirectFieldValue(source, 'Beta')?.trim()).toBe('TNested(Inner = 1)');
    expect(readDirectFieldValue(source, 'Gamma')?.trim()).toBe('3');
    // `Inner` belongs to the nested block, not to this one.
    expect(readDirectFieldValue(source, 'Inner')).toBeUndefined();
  });

  test('reads one-line fields declared with `is` and ignores lookalikes in strings', () => {
    const source =
      'Block is SimultaneousActionDeclaration(parDuration is 8 Label = "Size = 6" SizeFactor is 6.0)\n';

    expect(readDirectFieldValue(source, 'parDuration')?.trim()).toBe('8');
    expect(readDirectFieldValue(source, 'Label')?.trim()).toBe('"Size = 6"');
    expect(readDirectFieldValue(source, 'SizeFactor')?.trim()).toBe('6.0');
    expect(readDirectFieldValue(source, 'Size')).toBeUndefined();
  });

  test('keeps a multi-line value whole when a sibling follows on a later line', () => {
    const source = `export Block is TDescriptor
(
    Table = MAP
    [
        (Key, 1),
    ]
    After = 2
)
`;

    expect(readDirectFieldValue(source, 'Table')?.trim()).toBe(
      'MAP\n    [\n        (Key, 1),\n    ]',
    );
    expect(readDirectFieldValue(source, 'After')?.trim()).toBe('2');
  });

  test('reads fields across CRLF line endings and comment lines', () => {
    const source =
      'export Block is TDescriptor\r\n(\r\n    // comment\r\n    Alpha = 1\r\n    Beta = 2\r\n)\r\n';

    expect(readDirectFieldValue(source, 'Alpha')?.trim()).toBe('1');
    expect(readDirectFieldValue(source, 'Beta')?.trim()).toBe('2');
  });

  /** A match beginning on a `\r` reported the first field of a CRLF block as starting on the line above. */
  test('starts a CRLF field range at its own indentation, not at the line break before it', () => {
    const source = 'export Block is TDescriptor\r\n(\r\n    Alpha = 1\r\n    Beta = 2\r\n)\r\n';

    for (const fieldName of ['Alpha', 'Beta']) {
      const fieldRange = findDirectFieldRange(source, fieldName);
      expect(source.slice(fieldRange?.start ?? 0, fieldRange?.end ?? 0), fieldName).toBe(
        `    ${fieldName} = ${fieldName === 'Alpha' ? 1 : 2}\r`,
      );
    }
  });

  test('parses entries that start with quotes, tuples, and nested collections', () => {
    const collection = `[
    "Base",
    'SAMPLE',
    (1, 2),
    [3, 4],
    Plain,
]`;

    const entries = findCollectionEntries(collection);

    expect(entries.map((entry) => entry.text)).toEqual([
      '"Base"',
      "'SAMPLE'",
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
      identity('C:/fixture/UICommonResources.ndf'),
    );
    const byType = findCollectionEntryRange(
      collection,
      '[type:TOtherEvent]',
      identity('C:/fixture/UICommonResources.ndf'),
    );
    const byField = findCollectionEntryRange(
      collection,
      '[Name="Click"]',
      identity('C:/fixture/UICommonResources.ndf'),
    );

    expect(byIndex.text).toContain('Hover');
    expect(byType.text).toContain('Focus');
    expect(byField.text).toContain('Click');
  });

  test('resolves scalar collection entries by exact value', () => {
    const collection = `[
    ~/BuildingOrderConfigModuleDescriptor,
    $/GFX/Weapon/WeaponDescriptor_Test,
]`;

    const byValue = findCollectionEntryRange(
      collection,
      '[value=$/GFX/Weapon/WeaponDescriptor_Test]',
      identity('C:/fixture/UniteDescriptor.ndf'),
    );

    expect(byValue.text).toBe('$/GFX/Weapon/WeaponDescriptor_Test');
  });

  test('splits paths around bracketed nested-field selectors', () => {
    expect(
      splitNdfPath(
        'TimePanelSpeedButtons.Elements.[ComponentDescriptor.ElementName="SpeedSlowButton"].ComponentDescriptor.ComponentFrame.RelativeWidthHeight',
      ),
    ).toEqual([
      'TimePanelSpeedButtons',
      'Elements',
      '[ComponentDescriptor.ElementName="SpeedSlowButton"]',
      'ComponentDescriptor',
      'ComponentFrame',
      'RelativeWidthHeight',
    ]);
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

  test('reads direct action-DSL local declarations written with is', () => {
    const source = `export fx_impact_sol_Test is SimultaneousActionDeclaration
(
    parDuration is 8
    SizeFactor is 6.0
    Params = []
)`;

    const duration = findDirectFieldRange(source, 'parDuration');
    const sizeFactor = findDirectFieldRange(source, 'SizeFactor');

    expect(source.slice(duration?.valueStart, duration?.valueEnd).trim()).toBe('8');
    expect(source.slice(sizeFactor?.valueStart, sizeFactor?.valueEnd).trim()).toBe('6.0');
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
            MotherCountry = 'SAMPLE'

            // YMB-MODIFY-END {"id":"field","patchId":"test.patch"}
        ),
    ]
)`;

    expect(readNestedFieldValue(source, 'MotherCountry')).toBe("'SAMPLE'");
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

  test('writes a `$raw` scalar out literally instead of as an object', () => {
    // A template that resolves to a single number hands over a number, not the
    // text of one. Treating that as an ordinary object emitted
    // `( $raw = 1460.99 )` into the game file, which then failed to parse.
    expect(formatNdfValue({ $raw: 1460.994835 })).toBe('1460.994835');
    expect(formatNdfValue({ $raw: 150 })).toBe('150');
    expect(formatNdfValue({ $raw: true })).toBe('true');
    expect(formatNdfValue({ $raw: 'Descriptor_Unit_A' })).toBe('Descriptor_Unit_A');
  });

  test('refuses a `$raw` that holds something with structure', () => {
    expect(() => formatNdfValue({ $raw: { nested: 1 } })).toThrow(/\$raw/);
    expect(() => formatNdfValue({ $raw: [1, 2] })).toThrow(/a list/);
    expect(() => formatNdfValue({ $raw: null })).toThrow(/null/);
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
    // Only the comment body goes. Resuming at the line feed instead of the
    // carriage return rewrote commented lines to LF and left a CRLF file with
    // two kinds of line ending.
    expect(stripLineComments('A = 1 // note\r\nB = 2\r\n')).toBe('A = 1 \r\nB = 2\r\n');
    expect(stripLineComments('// whole line\r\nB = 2\r\n')).toBe('\r\nB = 2\r\n');
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
    expect(error.message).toContain('Written at  operation #3');
  });
});
