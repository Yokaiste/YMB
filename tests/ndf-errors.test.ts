import { describe, expect, test } from 'bun:test';
import { validateNdf } from '../src/patch/ndf/validate.ts';
import type { PatchTarget } from '../src/types.ts';
import { application, applyPatchTarget, expectYmbError } from './helpers/ndf.ts';

function createObjectMatchModifyTarget(availability: number): PatchTarget {
  return {
    file: 'GameData/Generated/Gameplay/Units.ndf',
    operations: [
      {
        op: 'modify',
        selector: {
          kind: 'object',
          by: 'match',
          where: { Availability: availability },
        },
        changes: { FrontArmor: 7 },
      },
    ],
  };
}

describe('ndf patching failures and edge cases', () => {
  test('ignores comment-like delimiters inside strings and comments during validation', () => {
    const source = `export Descriptor_Unit_Test is TEntityDescriptor
(
    Label = "// not a comment [ ] ) }"
    // ] ) } should be ignored here too
    FrontArmor = 5
)
`;

    expect(() => validateNdf(source, 'C:/fixture/Units.ndf')).not.toThrow();
  });

  test('reports the line and column for mismatched closing delimiters', async () => {
    const error = await expectYmbError(
      () => validateNdf('export Broken is TEntityDescriptor\n(\n]\n)\n', 'C:/fixture/Broken.ndf'),
      'ParserError',
      'Unbalanced delimiter `]` at line 3, column 1.',
    );

    expect(error.message).toContain(
      '  Fix   Fix the surrounding NDF syntax so parentheses, brackets, and braces are balanced.',
    );
  });

  test('returns the original text when an object modify would be a no-op', async () => {
    const source = `export Descriptor_Unit_T80U is TEntityDescriptor
(
    FrontArmor = 5
)
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Units.ndf',
      operations: [
        {
          op: 'modify',
          selector: { kind: 'object', by: 'name', value: 'Descriptor_Unit_T80U' },
          changes: {
            FrontArmor: 5,
          },
        },
      ],
    };

    const output = await applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');

    expect(output).toBe(source);
    expect(output).not.toContain('YMB-MODIFY-START');
  });

  test('adds missing fields into an existing object when using add on a field path', async () => {
    const source = `export Descriptor_Unit_T80U is TEntityDescriptor
(
    FrontArmor = 5
)
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Units.ndf',
      operations: [
        {
          op: 'add',
          selector: {
            kind: 'field',
            by: 'path',
            value: 'Descriptor_Unit_T80U.RearArmor',
          },
          value: 2,
        },
      ],
    };

    const output = await applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');

    expect(output).toContain('RearArmor = 2');
    expect(output).toContain('// YMB-ADD-START');
  });

  test('rejects copying unnamed blocks instead of globally replacing empty word boundaries', async () => {
    const source = `unnamed TAnonymousDescriptor
(
    Value = 1
)
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Anonymous.ndf',
      operations: [
        {
          op: 'copy',
          selector: { kind: 'object', by: 'index', value: 0 },
          destination: { name: 'NamedCopy' },
        },
      ],
    };

    await expect(
      applyPatchTarget(source, target, application, 'C:/fixture/Anonymous.ndf'),
    ).rejects.toThrow('`copy` cannot rename an unnamed top-level block');
  });

  test('skips collection inserts when the same raw entry already exists', async () => {
    const source = `DeckList is
[
    "Base",
    "SAMPLE",
]
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Decks/List.ndf',
      operations: [
        {
          op: 'add',
          selector: {
            kind: 'collection',
            by: 'path',
            value: 'DeckList',
          },
          value: {
            $raw: '"SAMPLE",',
          },
        },
      ],
    };

    const output = await applyPatchTarget(source, target, application, 'C:/fixture/List.ndf');

    expect(output).toBe(source);
    expect(output).not.toContain('YMB-ADD-START');
  });

  test('rejects copy operations whose destination holds something other than the copy', async () => {
    const source = `export Descriptor_Unit_T80U is TEntityDescriptor
(
    FrontArmor = 5
)

export Descriptor_Unit_T80UM is TEntityDescriptor
(
    FrontArmor = 6
)
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Units.ndf',
      operations: [
        {
          op: 'copy',
          selector: { kind: 'object', by: 'name', value: 'Descriptor_Unit_T80U' },
          destination: { name: 'Descriptor_Unit_T80UM' },
        },
      ],
    };

    await expectYmbError(
      () => applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf'),
      'ConflictError',
      'Copy destination `Descriptor_Unit_T80UM` already exists, and holds something other than this copy.',
    );
  });

  test('fails when a raw patch produces malformed output NDF', async () => {
    const source = `MainScorePanelComponent is BUCKListDescriptor
(
    Elements = []
)
`;
    const target: PatchTarget = {
      file: 'GameData/UserInterface/Use/InGame/UISpecificHUDScoreView.ndf',
      operations: [
        {
          op: 'modify',
          selector: {
            kind: 'field',
            by: 'path',
            value: 'MainScorePanelComponent.Elements',
          },
          value: {
            $raw: '[',
          },
        },
      ],
    };

    await expectYmbError(
      () => applyPatchTarget(source, target, application, 'C:/fixture/UISpecificHUDScoreView.ndf'),
      'ParserError',
      'Unbalanced delimiter',
    );
  });

  test('fails validation when collection entries are missing a separating comma', async () => {
    const source = `export Descriptor_Unit_Test is TEntityDescriptor
(
    ModulesDescriptors =
    [
        TMinimapDisplayModuleDescriptor
        (
            Texture = "Texture_Minimap_Unit_unit"
        ),
    ]
)
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Gfx/UniteDescriptor.ndf',
      operations: [
        {
          op: 'modify',
          selector: {
            kind: 'field',
            by: 'path',
            value: 'Descriptor_Unit_Test.ModulesDescriptors',
          },
          value: {
            $raw: `[
        TAttackReactionModuleDescriptor
        (
            CanAssist = True
        )
        TMinimapDisplayModuleDescriptor
        (
            Texture = "Texture_Minimap_Unit_unit"
        ),
    ]`,
          },
        },
      ],
    };

    await expectYmbError(
      () => applyPatchTarget(source, target, application, 'C:/fixture/UniteDescriptor.ndf'),
      'ParserError',
      'Missing collection separator before `T`',
    );
  });

  test('allows collection expressions to continue after nested index access', () => {
    const source = `export Descriptor_UI_Test is TTestDescriptor
(
    Values = [
        [-<ButtonWidthHeight>[1] * <HeightCoefficient>, 0.0]
    ]
)
`;

    expect(() => validateNdf(source, 'C:/fixture/UISpecificOffMapView.ndf')).not.toThrow();
  });

  test('allows collection expressions to continue after a word-form infix operator', () => {
    const source = `export maxDistance is 500000

export FxLodLevel is (1 - sat[length[MobilePosition - CameraPosition] div maxDistance]) * FxQuality
`;

    expect(() => validateNdf(source, 'C:/fixture/@Evaluable.ndf')).not.toThrow();
  });

  test('still reports a genuinely missing separator before a plain identifier', () => {
    const source = `export Descriptor_UI_Test is TTestDescriptor
(
    Values = [
        sat[maxDistance] divisor
    ]
)
`;

    expect(() => validateNdf(source, 'C:/fixture/UISpecificOffMapView.ndf')).toThrow();
  });

  // A bare scalar entry closes no delimiter, so nothing announces its end. Both
  // collection inserters once appended straight after one and fused it with the new
  // entry; validation passed and the break only showed up in-game.
  test('reports two bare scalar entries written with no separator', async () => {
    const fusedReferences = `export Descriptor_Unit_Test is TEntityDescriptor
(
    ModulesDescriptors =
    [
        ~/Module_A,
        ~/Module_B
        ~/Module_NEW,
    ]
)
`;

    await expectYmbError(
      () => validateNdf(fusedReferences, 'C:/fixture/UniteDescriptor.ndf'),
      'ParserError',
      'Missing collection separator before `~`',
    );
  });

  test('reports two string entries written with no separator', async () => {
    const source = `export Descriptor_UI_Test is TTestDescriptor
(
    Values = [ 'first' 'second' ]
)
`;

    await expectYmbError(
      () => validateNdf(source, 'C:/fixture/UISpecificOffMapView.ndf'),
      'ParserError',
      'Missing collection separator',
    );
  });

  // Vanilla Fx banks build one entry out of several whitespace-separated tokens, and
  // template parameter lists write the type after a `:`. Neither ends an entry.
  test('allows multi-token declaration entries and typed template parameters', () => {
    const declarations = `export BANK_Test is SimultaneousActionDeclaration
(
    Params =
    [
        private parInitialSize is Template_Param_Float( DefaultValue = 10 ),
        private parFinalSize   is Template_Param_Float ( DefaultValue = 10000 )
    ]
)
`;
    const templateParameters = `template TestTemplate
[
    HasMaxVision: bool = True,
    MinGroundVisionValue: int = 0,
    TextDico: string = ~/LocalisationConstantes/dico_interface_ingame,
] is BUCKContainerDescriptor
(
    Value = 1
)
`;

    expect(() => validateNdf(declarations, 'C:/fixture/BANK_Test.ndf')).not.toThrow();
    expect(() => validateNdf(templateParameters, 'C:/fixture/UITest.ndf')).not.toThrow();
  });

  test('allows a collection entry whose type and block sit on separate lines', () => {
    const source = `export Descriptor_Unit_Test is TEntityDescriptor
(
    ModulesDescriptors =
    [
        TAttackReactionModuleDescriptor
        (
            CanAssist = True
        ),
        MAP
        [
            (Descriptor_A, 1),
        ]
    ]
)
`;

    expect(() => validateNdf(source, 'C:/fixture/UniteDescriptor.ndf')).not.toThrow();
  });

  test('supports unique object match selectors for patching', async () => {
    const source = `export Descriptor_A is TEntityDescriptor
(
    Availability = 1
    FrontArmor = 3
)

export Descriptor_B is TEntityDescriptor
(
    Availability = 2
    FrontArmor = 5
)
`;
    const target = createObjectMatchModifyTarget(2);

    const output = await applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');

    expect(output).toContain('Availability = 2');
    expect(output).toContain('FrontArmor = 7');
    expect(output).toContain('YMB-MODIFY-START');
  });

  test('rejects object match selectors that find zero objects', async () => {
    const source = `export Descriptor_A is TEntityDescriptor
(
    Availability = 1
)
`;
    const target = createObjectMatchModifyTarget(2);

    await expectYmbError(
      () => applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf'),
      'SelectorError',
      'Match selector matched no objects.',
    );
  });

  test('rejects object match selectors that are ambiguous', async () => {
    const source = `export Descriptor_A is TEntityDescriptor
(
    Availability = 1
)

export Descriptor_B is TEntityDescriptor
(
    Availability = 1
)
`;
    const target = createObjectMatchModifyTarget(1);

    await expectYmbError(
      () => applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf'),
      'SelectorError',
      'Match selector matched multiple objects.',
    );
  });

  test('surfaces schema errors when object modify operations omit changes', async () => {
    const source = `export Descriptor_Unit_T80U is TEntityDescriptor
(
    FrontArmor = 5
)
`;
    const target = {
      file: 'GameData/Generated/Gameplay/Units.ndf',
      operations: [
        {
          op: 'modify',
          selector: { kind: 'object', by: 'name', value: 'Descriptor_Unit_T80U' },
        },
      ],
    } as unknown as PatchTarget;

    await expectYmbError(
      () => applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf'),
      'SchemaError',
      'Object modify operations require `changes`.',
    );
  });

  test('rejects object selectors on add from broken patch configs', async () => {
    // The schema rejects this shape first. This covers a config that reached the
    // patcher anyway, so the runtime never silently treats an object selector as
    // an insertion anchor again.
    const source = `DeckCreatorMaxUnitsInDeckPerCategory is 10
`;
    const target = {
      file: 'GameData/UserInterface/Use/ShowRoom/DeckCreator.ndf',
      operations: [
        {
          op: 'add',
          selector: {
            kind: 'object',
            by: 'match',
            where: { Value: 10 },
          },
          value: {
            $raw: 'DeckCreatorNewSetting is 70',
          },
        },
      ],
    } as unknown as PatchTarget;

    await expectYmbError(
      () => applyPatchTarget(source, target, application, 'C:/fixture/DeckCreator.ndf'),
      'SelectorError',
      'Unsupported add selector.',
    );
  });

  test('removes the first typed collection entry without leaving a dangling comma', async () => {
    const source = `export Descriptor_Unit_Test is TEntityDescriptor
(
    ModulesDescriptors = [
        TTypeUnitModuleDescriptor
        (
            MotherCountry = 'SOV'
        ),
        TSupplyModuleDescriptor
        (
            SupplyCapacity = 6000.0
        ),
    ]
)
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Units.ndf',
      operations: [
        {
          op: 'remove',
          selector: {
            kind: 'field',
            by: 'path',
            value: 'Descriptor_Unit_Test.ModulesDescriptors.[TTypeUnitModuleDescriptor]',
          },
        },
      ],
    };

    const output = await applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');

    expect(output).not.toContain('\n        TTypeUnitModuleDescriptor\n');
    expect(output).toContain('SupplyCapacity = 6000.0');
    expect(output).toContain('// YMB-REMOVE-START');
  });

  test('removes the last typed collection entry without corrupting the remaining list', async () => {
    const source = `export Descriptor_Unit_Test is TEntityDescriptor
(
    ModulesDescriptors = [
        TTypeUnitModuleDescriptor
        (
            MotherCountry = 'SOV'
        ),
        TSupplyModuleDescriptor
        (
            SupplyCapacity = 6000.0
        )
    ]
)
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Units.ndf',
      operations: [
        {
          op: 'remove',
          selector: {
            kind: 'field',
            by: 'path',
            value: 'Descriptor_Unit_Test.ModulesDescriptors.[TSupplyModuleDescriptor]',
          },
        },
      ],
    };

    const output = await applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');

    expect(output).toContain("MotherCountry = 'SOV'");
    expect(output).not.toContain('\n        TSupplyModuleDescriptor\n');
    expect(output).toContain('// YMB-REMOVE-START');
  });

  /** All three read the selector one way now, so the message names the missing field segment. */
  test.each(['add', 'remove', 'modify'] as const)(
    'refuses a field path with no field segment on %s',
    async (op) => {
      const source = 'export Block is TDescriptor\n(\n    Alpha = 1\n)\n';
      const target: PatchTarget = {
        file: 'GameData/Sample/Sample.ndf',
        operations: [
          {
            op,
            selector: { kind: 'field', by: 'path', value: 'Block' },
            ...(op === 'remove' ? {} : { value: 2 }),
          } as PatchTarget['operations'][number],
        ],
      };

      await expectYmbError(
        () => applyPatchTarget(source, target, application, 'C:/fixture/Sample.ndf'),
        'SelectorError',
        'must include an export name and at least one field segment',
      );
    },
  );

  test('refuses a field modify that shares its line with other code', async () => {
    const source = "SingleLine is TTemplate(Alpha = 'first' Beta = 2)\n";
    const target: PatchTarget = {
      file: 'GameData/Sample/Sample.ndf',
      operations: [
        {
          op: 'modify',
          selector: { kind: 'field', by: 'path', value: 'SingleLine.Alpha' },
          value: { $raw: "'second'" },
        },
      ],
    };

    const error = await expectYmbError(
      () => applyPatchTarget(source, target, application, 'C:/fixture/Sample.ndf'),
      'SchemaError',
      'Field `Alpha` shares its line with other code',
    );

    expect(error.message).toContain('Use an object selector with `changes`');
    expect(error.message).toContain("Line: SingleLine is TTemplate(Alpha = 'first' Beta = 2)");
  });

  test('refuses a field remove that shares its line with other code', async () => {
    const source = 'SingleLine is TTemplate(Alpha = 1 Beta = 2)\n';
    const target: PatchTarget = {
      file: 'GameData/Sample/Sample.ndf',
      operations: [
        { op: 'remove', selector: { kind: 'field', by: 'path', value: 'SingleLine.Beta' } },
      ],
    };

    await expectYmbError(
      () => applyPatchTarget(source, target, application, 'C:/fixture/Sample.ndf'),
      'SchemaError',
      'Field `Beta` shares its line with other code',
    );
  });

  test('still edits a field that is first on its own line inside a one-line-tail block', async () => {
    const source = `export Block is TDescriptor
(
    Alpha = 1)
`;
    const target: PatchTarget = {
      file: 'GameData/Sample/Sample.ndf',
      operations: [
        { op: 'modify', selector: { kind: 'field', by: 'path', value: 'Block.Alpha' }, value: 2 },
      ],
    };

    const output = await applyPatchTarget(source, target, application, 'C:/fixture/Sample.ndf');

    // Nothing precedes the field on its line, so the marker block is safe even
    // though the closing paren trails it.
    expect(output).toContain('Alpha = 2');
    expect(output).toContain('//     Alpha = 1');
    expect(() => validateNdf(output, 'C:/fixture/Sample.ndf')).not.toThrow();
  });
});
