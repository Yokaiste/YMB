import { describe, expect, test } from 'bun:test';
import { applyPatchTarget, validateNdf } from '../src/patch/ndf.ts';
import type { PatchTarget } from '../src/types.ts';
import { application, expectYmbError } from './helpers/ndf.ts';

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

  test('reports the line and column for mismatched closing delimiters', () => {
    const error = expectYmbError(
      () => validateNdf('export Broken is TEntityDescriptor\n(\n]\n)\n', 'C:/fixture/Broken.ndf'),
      'ParserError',
      'Unbalanced delimiter `]` at line 3, column 1.',
    );

    expect(error.message).toContain(
      '- next: Fix the surrounding NDF syntax so parentheses, brackets, and braces are balanced.',
    );
  });

  test('returns the original text when an object modify would be a no-op', () => {
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

    const output = applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');

    expect(output).toBe(source);
    expect(output).not.toContain('YMB-MODIFY-START');
  });

  test('adds missing fields into an existing object when using add on a field path', () => {
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

    const output = applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');

    expect(output).toContain('RearArmor = 2');
    expect(output).toContain('// YMB-ADD-START');
  });

  test('rejects copying unnamed blocks instead of globally replacing empty word boundaries', () => {
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
          destination: { kind: 'sibling', name: 'NamedCopy' },
        },
      ],
    };

    expect(() => applyPatchTarget(source, target, application, 'C:/fixture/Anonymous.ndf')).toThrow(
      '`copy` cannot rename an unnamed top-level block',
    );
  });

  test('skips collection inserts when the same raw entry already exists', () => {
    const source = `DeckList is
[
    "Base",
    "YSM",
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
            $raw: '"YSM",',
          },
        },
      ],
    };

    const output = applyPatchTarget(source, target, application, 'C:/fixture/List.ndf');

    expect(output).toBe(source);
    expect(output).not.toContain('YMB-ADD-START');
  });

  test('rejects copy operations whose destination object already exists', () => {
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
          destination: { kind: 'sibling', name: 'Descriptor_Unit_T80UM' },
        },
      ],
    };

    expectYmbError(
      () => applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf'),
      'ConflictError',
      'Copy destination `Descriptor_Unit_T80UM` already exists.',
    );
  });

  test('fails when a raw patch produces malformed output NDF', () => {
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

    expectYmbError(
      () => applyPatchTarget(source, target, application, 'C:/fixture/UISpecificHUDScoreView.ndf'),
      'ParserError',
      'Unbalanced delimiter',
    );
  });

  test('fails validation when collection entries are missing a separating comma', () => {
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

    expectYmbError(
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

  test('supports unique object match selectors for patching', () => {
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
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Units.ndf',
      operations: [
        {
          op: 'modify',
          selector: {
            kind: 'object',
            by: 'match',
            where: { Availability: 2 },
          },
          changes: {
            FrontArmor: 7,
          },
        },
      ],
    };

    const output = applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');

    expect(output).toContain('Availability = 2');
    expect(output).toContain('FrontArmor = 7');
    expect(output).toContain('YMB-MODIFY-START');
  });

  test('rejects object match selectors that find zero objects', () => {
    const source = `export Descriptor_A is TEntityDescriptor
(
    Availability = 1
)
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Units.ndf',
      operations: [
        {
          op: 'modify',
          selector: {
            kind: 'object',
            by: 'match',
            where: { Availability: 2 },
          },
          changes: {
            FrontArmor: 7,
          },
        },
      ],
    };

    expectYmbError(
      () => applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf'),
      'SelectorError',
      'Match selector matched no objects.',
    );
  });

  test('rejects object match selectors that are ambiguous', () => {
    const source = `export Descriptor_A is TEntityDescriptor
(
    Availability = 1
)

export Descriptor_B is TEntityDescriptor
(
    Availability = 1
)
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Units.ndf',
      operations: [
        {
          op: 'modify',
          selector: {
            kind: 'object',
            by: 'match',
            where: { Availability: 1 },
          },
          changes: {
            FrontArmor: 7,
          },
        },
      ],
    };

    expectYmbError(
      () => applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf'),
      'SelectorError',
      'Match selector matched multiple objects.',
    );
  });

  test('surfaces schema errors when object modify operations omit changes', () => {
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
    } as PatchTarget;

    expectYmbError(
      () => applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf'),
      'SchemaError',
      'Object modify operations require `changes`.',
    );
  });

  test('rejects unsupported add object selectors from broken patch configs', () => {
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
            $raw: 'DeckCreatorMaxUnitsInDeckPerCategory is 70',
          },
        },
      ],
    } as PatchTarget;

    expectYmbError(
      () => applyPatchTarget(source, target, application, 'C:/fixture/DeckCreator.ndf'),
      'SelectorError',
      'Unsupported add object selector.',
    );
  });

  test('removes the first typed collection entry without leaving a dangling comma', () => {
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

    const output = applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');

    expect(output).not.toContain('\n        TTypeUnitModuleDescriptor\n');
    expect(output).toContain('SupplyCapacity = 6000.0');
    expect(output).toContain('// YMB-REMOVE-START');
  });

  test('removes the last typed collection entry without corrupting the remaining list', () => {
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

    const output = applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');

    expect(output).toContain("MotherCountry = 'SOV'");
    expect(output).not.toContain('\n        TSupplyModuleDescriptor\n');
    expect(output).toContain('// YMB-REMOVE-START');
  });
});
