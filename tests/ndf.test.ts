import { describe, expect, test } from 'bun:test';
import { applyPatchTarget, validateNdf } from '../src/patch/ndf.ts';
import type { PatchTarget } from '../src/types.ts';
import { application } from './helpers/ndf.ts';

describe('ndf patching', () => {
  test('modifies field path and copies object', () => {
    const source = `export Descriptor_Unit_T80U is TEntityDescriptor
(
    FrontArmor = 5
    Availability = 2
)
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Units.ndf',
      operations: [
        {
          op: 'modify',
          selector: { kind: 'field', by: 'path', value: 'Descriptor_Unit_T80U.FrontArmor' },
          value: 7,
        },
        {
          op: 'copy',
          selector: { kind: 'object', by: 'name', value: 'Descriptor_Unit_T80U' },
          destination: { kind: 'sibling', name: 'Descriptor_Unit_T80UM' },
        },
      ],
    };

    const output = applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');

    expect(output).toContain('FrontArmor = 7');
    expect(output).toContain('// YMB-MODIFY-START');
    expect(output).toContain('//     FrontArmor = 5');
    expect(output).toContain('export Descriptor_Unit_T80UM is TEntityDescriptor');
    expect(output).toContain('// YMB-COPY-START');
  });

  test('supports raw ndf values for copied object rewrites', () => {
    const source = `export Descriptor_Unit_FOB_US is TEntityDescriptor
(
    DescriptorId = GUID:{11111111-1111-1111-1111-111111111111}
    ModulesDescriptors = [
        ~/Original
    ]
)
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/BuildingDescriptors.ndf',
      operations: [
        {
          op: 'copy',
          selector: { kind: 'object', by: 'name', value: 'Descriptor_Unit_FOB_US' },
          destination: { kind: 'sibling', name: 'Descriptor_Unit_YSM_Supply_Base' },
        },
        {
          op: 'modify',
          selector: { kind: 'object', by: 'name', value: 'Descriptor_Unit_YSM_Supply_Base' },
          changes: {
            DescriptorId: 'GUID:{22222222-2222-2222-2222-222222222222}',
            ModulesDescriptors: {
              $raw: `[
        ~/Original,
        TSupplyModuleDescriptor
        (
            SupplyCapacity = 2000000.0
        )
    ]`,
            },
          },
        },
      ],
    };

    const output = applyPatchTarget(
      source,
      target,
      application,
      'C:/fixture/BuildingDescriptors.ndf',
    );

    expect(output).toContain('Descriptor_Unit_YSM_Supply_Base');
    expect(output).toContain('DescriptorId = GUID:{22222222-2222-2222-2222-222222222222}');
    expect(output).toContain('SupplyCapacity = 2000000.0');
  });

  test('modifies unnamed top-level blocks by index', () => {
    const source = `unnamed TDeckSerializerEntries
(
    DivisionIds = MAP
    [
        (Descriptor_A, 1),
    ]
)
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Decks/DeckSerializer.ndf',
      operations: [
        {
          op: 'modify',
          selector: { kind: 'object', by: 'index', value: 0 },
          changes: {
            DivisionIds: {
              $raw: `MAP
    [
        (Descriptor_YSM, 999),
        (Descriptor_A, 1),
    ]`,
            },
          },
        },
      ],
    };

    const output = applyPatchTarget(source, target, application, 'C:/fixture/DeckSerializer.ndf');

    expect(output).toContain('(Descriptor_YSM, 999)');
    expect(output).toContain('// YMB-MODIFY-START');
    expect(output).toContain('// unnamed TDeckSerializerEntries');
  });

  test('adds raw top-level content after a named block', () => {
    const source = `MatrixCostName_Base is MAP
[
    (Factory/Logistic, [1]),
]
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Decks/DivisionCostMatrix.ndf',
      operations: [
        {
          op: 'add',
          selector: { kind: 'object', by: 'name', value: 'MatrixCostName_Base' },
          value: {
            $raw: `MatrixCostName_YSM is MAP
[
    (Factory/Logistic, [1, 1, 1]),
]`,
          },
        },
      ],
    };

    const output = applyPatchTarget(
      source,
      target,
      application,
      'C:/fixture/DivisionCostMatrix.ndf',
    );

    expect(output).toContain('MatrixCostName_YSM is MAP');
    expect(output).toContain('(Factory/Logistic, [1, 1, 1])');
  });

  test('supports leading comments for copied unit descriptors', () => {
    const source = `export Descriptor_Unit_T80U is TEntityDescriptor
(
    FrontArmor = 5
)
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Units.ndf',
      operations: [
        {
          op: 'copy',
          selector: { kind: 'object', by: 'name', value: 'Descriptor_Unit_T80U' },
          destination: { kind: 'sibling', name: 'Descriptor_Unit_YSM_Forced' },
          leadingComment: 'YSM-force-include',
        },
      ],
    };

    const output = applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');

    expect(output).toContain('// YSM-force-include');
    expect(output).toContain('export Descriptor_Unit_YSM_Forced is TEntityDescriptor');
    expect(output).toMatch(
      /\/\/ YMB-COPY-START[\s\S]*?\/\/ YSM-force-include[\s\S]*?export Descriptor_Unit_YSM_Forced is TEntityDescriptor/,
    );
  });

  test('supports field-path modification on named non-export blocks', () => {
    const source = `DivisionTypeDescriptions is TDivisionTypeDescriptions
(
    DivisionTypes = MAP [
        ('MECHANIZ', 'Texture_Mech'),
    ]
)
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/UserInterface/DivisionTypes.ndf',
      operations: [
        {
          op: 'modify',
          selector: {
            kind: 'field',
            by: 'path',
            value: 'DivisionTypeDescriptions.DivisionTypes',
          },
          value: {
            $raw: `MAP [
        ('YSM', 'TextureYSM_Flag'),
        ('MECHANIZ', 'Texture_Mech'),
    ]`,
          },
        },
      ],
    };

    const output = applyPatchTarget(source, target, application, 'C:/fixture/DivisionTypes.ndf');

    expect(output).toContain("('YSM', 'TextureYSM_Flag')");
  });

  test('adds entries to collections by path for unnamed root blocks', () => {
    const source = `unnamed TDeckSerializerEntries
(
    DivisionIds = MAP
    [
        (Descriptor_A, 1),
    ]
)
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Decks/DeckSerializer.ndf',
      operations: [
        {
          op: 'add',
          selector: {
            kind: 'collection',
            by: 'path',
            value: '@0.DivisionIds',
          },
          value: {
            $raw: `(Descriptor_YSM, 999),`,
          },
        },
      ],
    };

    const output = applyPatchTarget(source, target, application, 'C:/fixture/DeckSerializer.ndf');

    expect(output).toContain('(Descriptor_A, 1)');
    expect(output).toContain('        (Descriptor_YSM, 999),');
    expect(output).toContain('// YMB-ADD-START');
    expect(output).toContain('// YMB-ADD-END');
  });

  test('adds entries to top-level named collections by path', () => {
    const source = `IntroSubtitles is
[
    TBUCKTextVideoIntroOneSubtitleDescriptor(Text = "Base" StartTimeInSeconds = 0),
]
`;
    const target: PatchTarget = {
      file: 'CommonData/LogoVideos/Intro.ndf',
      operations: [
        {
          op: 'add',
          selector: {
            kind: 'collection',
            by: 'path',
            value: 'IntroSubtitles',
          },
          value: {
            $raw: '    TBUCKTextVideoIntroOneSubtitleDescriptor(Text = "YSM" StartTimeInSeconds = 1),',
          },
        },
      ],
    };

    const output = applyPatchTarget(source, target, application, 'C:/fixture/Intro.ndf');

    expect(output).toContain('Text = "Base"');
    expect(output).toContain('Text = "YSM"');
  });

  test('auto-appends a trailing comma for collection entries when the raw snippet omits it', () => {
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
          op: 'add',
          selector: {
            kind: 'collection',
            by: 'path',
            value: 'Descriptor_Unit_Test.ModulesDescriptors',
          },
          position: {
            mode: 'before',
            anchor: 'TMinimapDisplayModuleDescriptor',
          },
          value: {
            $raw: `TAttackReactionModuleDescriptor
(
    CanAssist = True
)`,
          },
        },
      ],
    };

    const output = applyPatchTarget(source, target, application, 'C:/fixture/UniteDescriptor.ndf');

    expect(output).toContain('TAttackReactionModuleDescriptor');
    expect(output).toContain('CanAssist = True');
    expect(output).toContain('),\n        // YMB-ADD-END');
    expect(output).toContain('// YMB-ADD-END');
    expect(output).toContain('// YMB-ADD-END {"id":"');
    expect(output).toContain('}\n        TMinimapDisplayModuleDescriptor');
  });

  test('adds collection entries before an anchor to preserve order', () => {
    const source = `unnamed TConstants
(
    TimeLimitTable = [20, 30, 40, 60, 0]
)
`;
    const target: PatchTarget = {
      file: 'GameData/Gameplay/Constantes/GDConstants.ndf',
      operations: [
        {
          op: 'add',
          selector: {
            kind: 'collection',
            by: 'path',
            value: '@0.TimeLimitTable',
          },
          position: {
            mode: 'before',
            anchor: '20,',
          },
          value: {
            $raw: '5,',
          },
        },
      ],
    };

    const output = applyPatchTarget(source, target, application, 'C:/fixture/GDConstants.ndf');

    expect(output).toContain('TimeLimitTable = [\n    // YMB-ADD-START');
    expect(output).toContain('\n    5,\n');
    expect(output).toContain('\n    // YMB-ADD-END');
    expect(output).toContain('20, 30, 40, 60, 0]');
  });

  test('strips raw snippet comments from generated output', () => {
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
            $raw: `[
        // Updated by YMB
        ~/PlayerScorePanelButton,
    ]`,
          },
        },
      ],
    };

    const output = applyPatchTarget(
      source,
      target,
      application,
      'C:/fixture/UISpecificHUDScoreView.ndf',
    );

    expect(output).toContain('~/PlayerScorePanelButton');
    expect(output).not.toContain('Updated by YMB');
  });

  test('modifies fields inside named template blocks', () => {
    const source = `template BUCKSpecificGameChatMainComponentDescriptor
[
    PanelColorStyle : string,
] is BUCKContainerDescriptor
(
    ComponentFrame = TUIFramePropertyRTTI
    (
        MagnifiableOffset = [10.0, -275.0]
    )
)
`;
    const target: PatchTarget = {
      file: 'GameData/UserInterface/Use/Common/UISpecificChatView.ndf',
      operations: [
        {
          op: 'modify',
          selector: {
            kind: 'field',
            by: 'path',
            value: 'BUCKSpecificGameChatMainComponentDescriptor.ComponentFrame.MagnifiableOffset',
          },
          value: {
            $raw: '[10.0, -575.0]',
          },
        },
      ],
    };

    const output = applyPatchTarget(
      source,
      target,
      application,
      'C:/fixture/UISpecificChatView.ndf',
    );

    expect(output).toContain('MagnifiableOffset = [10.0, -575.0]');
  });

  test('modifies nested fields inside collection entries selected by type', () => {
    const source = `export Descriptor_Unit_Mi_26_SOV is TEntityDescriptor
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
        TTagsModuleDescriptor
        (
            TagSet = [
                "UNITE_Mi_26_SOV",
                "Unite",
            ]
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
            value:
              'Descriptor_Unit_Mi_26_SOV.ModulesDescriptors.[TTypeUnitModuleDescriptor].MotherCountry',
          },
          value: { $raw: "'YSM'" },
        },
        {
          op: 'modify',
          selector: {
            kind: 'field',
            by: 'path',
            value:
              'Descriptor_Unit_Mi_26_SOV.ModulesDescriptors.[TSupplyModuleDescriptor].SupplyCapacity',
          },
          value: { $raw: '2000000.0' },
        },
        {
          op: 'add',
          selector: {
            kind: 'collection',
            by: 'path',
            value: 'Descriptor_Unit_Mi_26_SOV.ModulesDescriptors.[TTagsModuleDescriptor].TagSet',
          },
          position: { mode: 'before', anchor: '"Unite"' },
          value: { $raw: '"UNITE_YSM_Supply_Helicopter",' },
        },
      ],
    };

    const output = applyPatchTarget(source, target, application, 'C:/fixture/UniteDescriptor.ndf');

    expect(output).toContain("MotherCountry = 'YSM'");
    expect(output).toContain('SupplyCapacity = 2000000.0');
    expect(output).toContain('"UNITE_YSM_Supply_Helicopter"');
  });

  test('matches collection entries by nested field path for ui tweaks', () => {
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
                BackgroundBlockColorToken = "H2_bleu_1"
            ),
            BUCKContainerDescriptor
            (
                UniqueName = "other"
            )
        ]
    )
)
`;
    const target: PatchTarget = {
      file: 'GameData/UserInterface/Use/InGame/UIInGameResources.ndf',
      operations: [
        {
          op: 'remove',
          selector: {
            kind: 'field',
            by: 'path',
            value:
              'InGameMainContainerResource.ForegroundComponents.Components.[UniqueName="barre_du_haut"].HasBackground',
          },
        },
        {
          op: 'remove',
          selector: {
            kind: 'field',
            by: 'path',
            value:
              'InGameMainContainerResource.ForegroundComponents.Components.[UniqueName="barre_du_haut"].BackgroundBlockColorToken',
          },
        },
      ],
    };

    const output = applyPatchTarget(
      source,
      target,
      application,
      'C:/fixture/UIInGameResources.ndf',
    );

    expect(output).toContain('// YMB-REMOVE-START');
    expect(output).toContain('//                 HasBackground = true');
    expect(output).toContain('//                 BackgroundBlockColorToken = "H2_bleu_1"');
    expect(output).toContain('UniqueName = "other"');
  });

  test('removes whole collection entries when the selector ends at the matched entry', () => {
    const source = `export Descriptor_Unit_Mi_26_SOV is TEntityDescriptor
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
      file: 'GameData/Generated/Gameplay/Gfx/UniteDescriptor.ndf',
      operations: [
        {
          op: 'remove',
          selector: {
            kind: 'field',
            by: 'path',
            value: 'Descriptor_Unit_Mi_26_SOV.ModulesDescriptors.[TSupplyModuleDescriptor]',
          },
        },
      ],
    };

    const output = applyPatchTarget(source, target, application, 'C:/fixture/UniteDescriptor.ndf');

    expect(output).toContain('// YMB-REMOVE-START');
    expect(output).toContain('// TSupplyModuleDescriptor');
    expect(output).toContain("MotherCountry = 'SOV'");
    expect(output).not.toContain(`        TSupplyModuleDescriptor
        (
            SupplyCapacity = 6000.0
        )`);
  });

  test('removes named scalar blocks so configs can replace them with raw adds', () => {
    const source = `DeckCreatorMaxUnitsInDeckPerCategory is 10
DeckCreatorCategoryButtonDescriptor is BUCKButtonDescriptor
(
    TextSizeToken = "22"
)
`;
    const target: PatchTarget = {
      file: 'GameData/UserInterface/Use/ShowRoom/Views/UISpecificShowRoomDeckCreatorScreenComponent.ndf',
      operations: [
        {
          op: 'remove',
          selector: {
            kind: 'object',
            by: 'name',
            value: 'DeckCreatorMaxUnitsInDeckPerCategory',
          },
        },
        {
          op: 'add',
          selector: {
            kind: 'object',
            by: 'index',
            value: -1,
          },
          value: {
            $raw: 'DeckCreatorMaxUnitsInDeckPerCategory is 70',
          },
        },
      ],
    };

    const output = applyPatchTarget(
      source,
      target,
      application,
      'C:/fixture/UISpecificShowRoomDeckCreatorScreenComponent.ndf',
    );

    expect(output).toContain('// YMB-REMOVE-START');
    expect(output).toContain('// DeckCreatorMaxUnitsInDeckPerCategory is 10');
    expect(output).toContain('DeckCreatorMaxUnitsInDeckPerCategory is 70');
    expect(output).toContain('DeckCreatorCategoryButtonDescriptor is BUCKButtonDescriptor');
  });

  test('preserves surrounding whitespace when modifying nested field values', () => {
    const source = `export Descriptor_Unit_T80U is TEntityDescriptor
(
    Stats =
        TArmorStats
        (
            Front = 5
            Side =
                3    
        )    
)
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Units.ndf',
      operations: [
        {
          op: 'modify',
          selector: {
            kind: 'field',
            by: 'path',
            value: 'Descriptor_Unit_T80U.Stats.Side',
          },
          value: 4,
        },
      ],
    };

    const output = applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');

    expect(output).toContain(`Stats =
        TArmorStats`);
    expect(output).toContain('// YMB-MODIFY-START');
    expect(output).toContain('//             Side =');
    expect(output).toContain(`Side =
                4`);
  });

  test('detects malformed ndf delimiters', () => {
    expect(() => validateNdf('export Broken is X\n(\n', 'C:/fixture/Broken.ndf')).toThrow();
  });

  test('collection add dedupe compares whole entries, not substrings', () => {
    const source = `export DeckIds is TDeckList
(
    Ids = [
        15,
        25,
    ]
)
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/DeckIds.ndf',
      operations: [
        {
          op: 'add',
          selector: { kind: 'collection', by: 'path', value: 'DeckIds.Ids' },
          value: { $raw: '5,' },
        },
        {
          op: 'add',
          selector: { kind: 'collection', by: 'path', value: 'DeckIds.Ids' },
          value: { $raw: '25,' },
        },
      ],
    };

    const output = applyPatchTarget(source, target, application, 'C:/fixture/DeckIds.ndf');

    expect(output).toMatch(/^\s+5,$/m);
    expect(output.match(/^\s+25,$/gm)).toHaveLength(1);
  });

  test('copy renames every occurrence of the source name', () => {
    const source = `export Descriptor_Recycler is TEntityDescriptor
(
    SelfReference = ~/Descriptor_Recycler
    Modules = [
        ~/Descriptor_Recycler,
    ]
)
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Units.ndf',
      operations: [
        {
          op: 'copy',
          selector: { kind: 'object', by: 'name', value: 'Descriptor_Recycler' },
          destination: { kind: 'sibling', name: 'Descriptor_Recycler_Copy' },
        },
      ],
    };

    const output = applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');
    const copiedBlock = output.slice(output.indexOf('// YMB-COPY-START'));

    expect(copiedBlock).toContain('export Descriptor_Recycler_Copy is TEntityDescriptor');
    expect(copiedBlock).toContain('SelfReference = ~/Descriptor_Recycler_Copy');
    expect(copiedBlock).toContain('~/Descriptor_Recycler_Copy,');
  });

  test('renders explicit $string values quoted even when identifier-like', () => {
    const source = `export Descriptor_Unit is TEntityDescriptor
(
    Name = 'placeholder'
    Faction = NATO
)
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Units.ndf',
      operations: [
        {
          op: 'modify',
          selector: { kind: 'field', by: 'path', value: 'Descriptor_Unit.Name' },
          value: { $string: 'Infantry' },
        },
        {
          op: 'modify',
          selector: { kind: 'field', by: 'path', value: 'Descriptor_Unit.Faction' },
          value: 'PACT',
        },
      ],
    };

    const output = applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');

    expect(output).toContain("Name = 'Infantry'");
    expect(output).toContain('Faction = PACT');
  });

  test('ignores header-shaped lines inside strings and comments', () => {
    const source = `export Localized_Text is TTextDescriptor
(
    Body = "first line
Fake_Block is TEntityDescriptor
last line"
)
// Commented_Block is TEntityDescriptor
export Real_Block is TEntityDescriptor
(
    FrontArmor = 1
)
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Units.ndf',
      operations: [
        {
          op: 'modify',
          selector: { kind: 'field', by: 'path', value: 'Real_Block.FrontArmor' },
          value: 2,
        },
      ],
    };

    const output = applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');

    expect(output).toContain('FrontArmor = 2');
    expect(output).toContain('Fake_Block is TEntityDescriptor\nlast line');
  });
});
