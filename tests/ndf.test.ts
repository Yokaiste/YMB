import { describe, expect, test } from 'bun:test';
import { validateNdf } from '../src/patch/ndf/validate.ts';
import type { PatchTarget } from '../src/types.ts';
import { application, applyPatchTarget } from './helpers/ndf.ts';

const TWO_WEAPON_SOURCE = `export WeaponDescriptor_Swarm is TWeaponManagerModuleDescriptor
(
    MountedWeaponDescriptorList =
    [
        TMountedWeaponDescriptor
        (
            Ammunition = $/GFX/Weapon/Ammo_First
        ),
        TMountedWeaponDescriptor
        (
            Ammunition = $/GFX/Weapon/Ammo_Second
        ),
    ]
)
`;

describe('ndf patching', () => {
  test('modifies field path and copies object', async () => {
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
          destination: { name: 'Descriptor_Unit_T80UM' },
        },
      ],
    };

    const output = await applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');

    expect(output).toContain('FrontArmor = 7');
    expect(output).toContain('// YMB-MODIFY-START');
    expect(output).toContain('//     FrontArmor = 5');
    expect(output).toContain('export Descriptor_Unit_T80UM is TEntityDescriptor');
    expect(output).toContain('// YMB-COPY-START');
  });

  test('object modify applies every change to a block written on one line', async () => {
    const source = "SingleLine is TTemplate(Alpha = 'first' Beta = TNested(Inner = 1))\n";
    const target: PatchTarget = {
      file: 'GameData/Sample/Sample.ndf',
      operations: [
        {
          op: 'modify',
          selector: { kind: 'object', by: 'name', value: 'SingleLine' },
          changes: { Alpha: { $raw: "'second'" }, Beta: { $raw: 'nil' } },
        },
      ],
    };

    const output = await applyPatchTarget(source, target, application, 'C:/fixture/Sample.ndf');

    // Both edits land, and neither swallows the sibling that follows it.
    expect(output).toContain("SingleLine is TTemplate(Alpha = 'second' Beta = nil)");
    expect(output).toContain('// YMB-MODIFY-START');
    expect(output).toContain(
      "// SingleLine is TTemplate(Alpha = 'first' Beta = TNested(Inner = 1))",
    );
    expect(() => validateNdf(output, 'C:/fixture/Sample.ndf')).not.toThrow();
  });

  test('object modify edits the last field of a one-line block without moving the paren', async () => {
    const source = 'SingleLine is TTemplate(Alpha = 1 Beta = 2)\n';
    const target: PatchTarget = {
      file: 'GameData/Sample/Sample.ndf',
      operations: [
        {
          op: 'modify',
          selector: { kind: 'object', by: 'name', value: 'SingleLine' },
          changes: { Beta: 9 },
        },
      ],
    };

    const output = await applyPatchTarget(source, target, application, 'C:/fixture/Sample.ndf');

    expect(output).toContain('SingleLine is TTemplate(Alpha = 1 Beta = 9)');
  });

  test('copies and modifies action-DSL objects with local is declarations', async () => {
    const source = `export fx_impact_sol_Tactical_Nuke is SimultaneousActionDeclaration
(
    parDuration is 8
    SizeFactor is 6.0
    Actions = []
)
`;
    const target: PatchTarget = {
      file: 'GameData/Fx/Set/FX_Impact_Nuke.ndf',
      operations: [
        {
          op: 'copy',
          selector: { kind: 'object', by: 'name', value: 'fx_impact_sol_Tactical_Nuke' },
          destination: { name: 'fx_impact_sol_YN_Tactical_Nuke' },
        },
        {
          op: 'modify',
          selector: {
            kind: 'field',
            by: 'path',
            value: 'fx_impact_sol_YN_Tactical_Nuke.SizeFactor',
          },
          value: { $raw: '18.0' },
        },
      ],
    };

    const output = await applyPatchTarget(
      source,
      target,
      application,
      'C:/fixture/FX_Impact_Nuke.ndf',
    );

    expect(output).toContain(
      'export fx_impact_sol_YN_Tactical_Nuke is SimultaneousActionDeclaration',
    );
    expect(output).toContain('SizeFactor is 18.0');
    expect(output).toContain('//     SizeFactor is 6.0');
  });

  test('supports raw ndf values for copied object rewrites', async () => {
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
          destination: { name: 'Descriptor_Unit_Sample_Supply_Base' },
        },
        {
          op: 'modify',
          selector: { kind: 'object', by: 'name', value: 'Descriptor_Unit_Sample_Supply_Base' },
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

    const output = await applyPatchTarget(
      source,
      target,
      application,
      'C:/fixture/BuildingDescriptors.ndf',
    );

    expect(output).toContain('Descriptor_Unit_Sample_Supply_Base');
    expect(output).toContain('DescriptorId = GUID:{22222222-2222-2222-2222-222222222222}');
    expect(output).toContain('SupplyCapacity = 2000000.0');
  });

  test('modifies unnamed top-level blocks by index', async () => {
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
        (Descriptor_Sample, 999),
        (Descriptor_A, 1),
    ]`,
            },
          },
        },
      ],
    };

    const output = await applyPatchTarget(
      source,
      target,
      application,
      'C:/fixture/DeckSerializer.ndf',
    );

    expect(output).toContain('(Descriptor_Sample, 999)');
    expect(output).toContain('// YMB-MODIFY-START');
    expect(output).toContain('// unnamed TDeckSerializerEntries');
  });

  // A decooked base mod spells one entry as the source TEMPLATE, another as the class it expands to,
  // depending on which mod it came from. A patch has to be able to name both.
  test('collection type selector accepts alternative spellings', async () => {
    const source = `export Descriptor_Unit_Nuke is TEntityDescriptor
(
    ModulesDescriptors =
    [
        TAirplaneMovementModuleDescriptor
        (
            AltitudeGRU = 100
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
              'Descriptor_Unit_Nuke.ModulesDescriptors.[AirplaneMovementDescriptor|TAirplaneMovementModuleDescriptor].AltitudeGRU',
          },
          value: 525,
        },
      ],
    };

    const output = await applyPatchTarget(
      source,
      target,
      application,
      'C:/fixture/UniteDescriptor.ndf',
    );

    expect(output).toContain('AltitudeGRU = 525');
  });

  // A base mod may have grown the list, so "the only one of this type" stops being true. #N says which.
  test('collection type selector picks the Nth entry of that type', async () => {
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Gfx/WeaponDescriptor.ndf',
      operations: [
        {
          op: 'modify',
          selector: {
            kind: 'field',
            by: 'path',
            value:
              'WeaponDescriptor_Swarm.MountedWeaponDescriptorList.[TMountedWeaponDescriptor#0].Ammunition',
          },
          value: { $raw: '$/GFX/Weapon/Ammo_Replaced' },
        },
      ],
    };

    const output = await applyPatchTarget(
      TWO_WEAPON_SOURCE,
      target,
      application,
      'C:/fixture/WeaponDescriptor.ndf',
    );

    expect(output).toContain('Ammo_Replaced');
    expect(output).toContain('Ammo_Second');
  });

  // Without #N an ambiguous type selector must still fail loudly rather than silently taking the first.
  test('collection type selector still refuses an ambiguous match', async () => {
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Gfx/WeaponDescriptor.ndf',
      operations: [
        {
          op: 'modify',
          selector: {
            kind: 'field',
            by: 'path',
            value:
              'WeaponDescriptor_Swarm.MountedWeaponDescriptorList.[TMountedWeaponDescriptor].Ammunition',
          },
          value: { $raw: '$/GFX/Weapon/Ammo_Replaced' },
        },
      ],
    };

    await expect(
      applyPatchTarget(TWO_WEAPON_SOURCE, target, application, 'C:/fixture/WeaponDescriptor.ndf'),
    ).rejects.toThrow(/matched multiple entries/);
  });

  test('adds to an unnamed top-level block by semantic type', async () => {
    const source = `NamedHeader is TString("stable")

unnamed TUISpecificCountriesInfos
(
    CountriesInfos = MAP
    [
        ("US", TUISpecificCountryInfos(Country = "US")),
    ]
)
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/UserInterface/UISpecificCountriesInfos.ndf',
      operations: [
        {
          op: 'add',
          selector: {
            kind: 'collection',
            by: 'path',
            value: '@type:TUISpecificCountriesInfos.CountriesInfos',
          },
          value: {
            $raw: '("SAMPLE", TUISpecificCountryInfos(Country = "SAMPLE")),',
          },
        },
      ],
    };

    const output = await applyPatchTarget(
      source,
      target,
      application,
      'C:/fixture/UISpecificCountriesInfos.ndf',
    );

    expect(output).toContain('("SAMPLE", TUISpecificCountryInfos(Country = "SAMPLE"))');
    expect(output).toContain('// YMB-ADD-START');
  });

  test('adds raw top-level content after a named block', async () => {
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
          position: { mode: 'after', anchor: 'MatrixCostName_Base' },
          value: {
            $raw: `MatrixCostName_Sample is MAP
[
    (Factory/Logistic, [1, 1, 1]),
]`,
          },
        },
      ],
    };

    const output = await applyPatchTarget(
      source,
      target,
      application,
      'C:/fixture/DivisionCostMatrix.ndf',
    );

    expect(output).toContain('MatrixCostName_Sample is MAP');
    expect(output).toContain('(Factory/Logistic, [1, 1, 1])');
  });

  test('supports leading comments for copied unit descriptors', async () => {
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
          destination: { name: 'Descriptor_Unit_Sample_Forced' },
          leadingComment: 'force-include',
        },
      ],
    };

    const output = await applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');

    expect(output).toContain('// force-include');
    expect(output).toContain('export Descriptor_Unit_Sample_Forced is TEntityDescriptor');
    expect(output).toMatch(
      /\/\/ YMB-COPY-START[\s\S]*?\/\/ force-include[\s\S]*?export Descriptor_Unit_Sample_Forced is TEntityDescriptor/,
    );
  });

  test('supports field-path modification on named non-export blocks', async () => {
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
        ('SAMPLE', 'TextureSample_Flag'),
        ('MECHANIZ', 'Texture_Mech'),
    ]`,
          },
        },
      ],
    };

    const output = await applyPatchTarget(
      source,
      target,
      application,
      'C:/fixture/DivisionTypes.ndf',
    );

    expect(output).toContain("('SAMPLE', 'TextureSample_Flag')");
  });

  test('adds entries to collections by path for unnamed root blocks', async () => {
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
            $raw: `(Descriptor_Sample, 999),`,
          },
        },
      ],
    };

    const output = await applyPatchTarget(
      source,
      target,
      application,
      'C:/fixture/DeckSerializer.ndf',
    );

    expect(output).toContain('(Descriptor_A, 1)');
    expect(output).toContain('        (Descriptor_Sample, 999),');
    expect(output).toContain('// YMB-ADD-START');
    expect(output).toContain('// YMB-ADD-END');
  });

  test('adds entries to top-level named collections by path', async () => {
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
            $raw: '    TBUCKTextVideoIntroOneSubtitleDescriptor(Text = "SAMPLE" StartTimeInSeconds = 1),',
          },
        },
      ],
    };

    const output = await applyPatchTarget(source, target, application, 'C:/fixture/Intro.ndf');

    expect(output).toContain('Text = "Base"');
    expect(output).toContain('Text = "SAMPLE"');
  });

  test('auto-appends a trailing comma for collection entries when the raw snippet omits it', async () => {
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

    const output = await applyPatchTarget(
      source,
      target,
      application,
      'C:/fixture/UniteDescriptor.ndf',
    );

    expect(output).toContain('TAttackReactionModuleDescriptor');
    expect(output).toContain('CanAssist = True');
    expect(output).toContain('),\n        // YMB-ADD-END');
    expect(output).toContain('// YMB-ADD-END');
    expect(output).toContain('// YMB-ADD-END {"id":"');
    expect(output).toContain('}\n        TMinimapDisplayModuleDescriptor');
  });

  test('adds collection entries before an anchor to preserve order', async () => {
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

    const output = await applyPatchTarget(
      source,
      target,
      application,
      'C:/fixture/GDConstants.ndf',
    );

    expect(output).toContain('TimeLimitTable = [\n    // YMB-ADD-START');
    expect(output).toContain('\n    5,\n');
    expect(output).toContain('\n    // YMB-ADD-END');
    expect(output).toContain('20, 30, 40, 60, 0]');
  });

  test('strips raw snippet comments from generated output', async () => {
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

    const output = await applyPatchTarget(
      source,
      target,
      application,
      'C:/fixture/UISpecificHUDScoreView.ndf',
    );

    expect(output).toContain('~/PlayerScorePanelButton');
    expect(output).not.toContain('Updated by YMB');
  });

  test('modifies fields inside named template blocks', async () => {
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

    const output = await applyPatchTarget(
      source,
      target,
      application,
      'C:/fixture/UISpecificChatView.ndf',
    );

    expect(output).toContain('MagnifiableOffset = [10.0, -575.0]');
  });

  test('modifies nested fields inside collection entries selected by type', async () => {
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
          value: { $raw: "'SAMPLE'" },
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

    const output = await applyPatchTarget(
      source,
      target,
      application,
      'C:/fixture/UniteDescriptor.ndf',
    );

    expect(output).toContain("MotherCountry = 'SAMPLE'");
    expect(output).toContain('SupplyCapacity = 2000000.0');
    expect(output).toContain('"UNITE_YSM_Supply_Helicopter"');
  });

  test('matches collection entries by nested field path for ui tweaks', async () => {
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

    const output = await applyPatchTarget(
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

  test('matches collection entries by a nested selector field without positional paths', async () => {
    const source = `TimePanelSpeedButtons is BUCKListDescriptor
(
    Elements =
    [
        BUCKListElementDescriptor
        (
            ComponentDescriptor = HUDButton
            (
                ElementName = "SpeedSlowButton"
                ComponentFrame = TUIFramePropertyRTTI
                (
                    MagnifiableWidthHeight = [25.0, 25.0]
                )
            )
        ),
        BUCKListElementDescriptor
        (
            ComponentDescriptor = HUDButton
            (
                ElementName = "SpeedFastButton"
                ComponentFrame = TUIFramePropertyRTTI
                (
                    MagnifiableWidthHeight = [30.0, 30.0]
                )
            )
        ),
    ]
)
`;
    const target: PatchTarget = {
      file: 'GameData/UserInterface/Use/InGame/UISpecificInGameHUDTimePanelView.ndf',
      operations: [
        {
          op: 'modify',
          selector: {
            kind: 'field',
            by: 'path',
            value:
              'TimePanelSpeedButtons.Elements.[ComponentDescriptor.ElementName="SpeedSlowButton"].ComponentDescriptor.ComponentFrame.MagnifiableWidthHeight',
          },
          value: { $raw: '[20.0, 20.0]' },
        },
      ],
    };

    const output = await applyPatchTarget(
      source,
      target,
      application,
      'C:/fixture/UISpecificInGameHUDTimePanelView.ndf',
    );

    expect(output).toContain('MagnifiableWidthHeight = [20.0, 20.0]');
    expect(output).toContain('MagnifiableWidthHeight = [30.0, 30.0]');
  });

  test('removes whole collection entries when the selector ends at the matched entry', async () => {
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

    const output = await applyPatchTarget(
      source,
      target,
      application,
      'C:/fixture/UniteDescriptor.ndf',
    );

    expect(output).toContain('// YMB-REMOVE-START');
    expect(output).toContain('// TSupplyModuleDescriptor');
    expect(output).toContain("MotherCountry = 'SOV'");
    expect(output).not.toContain(`        TSupplyModuleDescriptor
        (
            SupplyCapacity = 6000.0
        )`);
  });

  test('removes named scalar blocks so configs can replace them with raw adds', async () => {
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
          value: {
            $raw: 'DeckCreatorMaxUnitsInDeckPerCategory is 70',
          },
        },
      ],
    };

    const output = await applyPatchTarget(
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

  test('preserves surrounding whitespace when modifying nested field values', async () => {
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

    const output = await applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');

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

  test('collection add dedupe compares whole entries, not substrings', async () => {
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

    const output = await applyPatchTarget(source, target, application, 'C:/fixture/DeckIds.ndf');

    expect(output).toMatch(/^\s+5,$/m);
    expect(output.match(/^\s+25,$/gm)).toHaveLength(1);
  });

  test('copy renames every occurrence of the source name', async () => {
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
          destination: { name: 'Descriptor_Recycler_Copy' },
        },
      ],
    };

    const output = await applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');
    const copiedBlock = output.slice(output.indexOf('// YMB-COPY-START'));

    expect(copiedBlock).toContain('export Descriptor_Recycler_Copy is TEntityDescriptor');
    expect(copiedBlock).toContain('SelfReference = ~/Descriptor_Recycler_Copy');
    expect(copiedBlock).toContain('~/Descriptor_Recycler_Copy,');
  });

  test('renders explicit $string values quoted even when identifier-like', async () => {
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

    const output = await applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');

    expect(output).toContain("Name = 'Infantry'");
    expect(output).toContain('Faction = PACT');
  });

  test('escapes the chosen quote when a string value mixes both quote styles', async () => {
    const source = `export Descriptor_Unit is TEntityDescriptor
(
    Name = 'placeholder'
)
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Units.ndf',
      operations: [
        {
          op: 'modify',
          selector: { kind: 'field', by: 'path', value: 'Descriptor_Unit.Name' },
          value: { $string: `2" gun's crew` },
        },
      ],
    };

    const output = await applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');

    expect(output).toContain(`Name = '2" gun\\'s crew'`);
    expect(() => validateNdf(output, 'C:/fixture/Units.ndf')).not.toThrow();
  });

  test('ignores header-shaped lines inside strings and comments', async () => {
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

    const output = await applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');

    expect(output).toContain('FrontArmor = 2');
    expect(output).toContain('Fake_Block is TEntityDescriptor\nlast line');
  });
});

/** The scan anchored on the `\r` closing the header, so the first field looked like it shared that line. */
describe('CRLF targets', () => {
  const source =
    'export Descriptor_Unit_A is TEntityDescriptor\r\n(\r\n    FrontArmor = 5\r\n    Availability = 2\r\n)\r\n';

  async function applyOperation(operation: PatchTarget['operations'][number]): Promise<string> {
    return await applyPatchTarget(
      source,
      { file: 'GameData/Generated/Gameplay/Units.ndf', operations: [operation] },
      application,
      'C:/fixture/Units.ndf',
    );
  }

  test('modifies the first field of a block', async () => {
    const output = await applyOperation({
      op: 'modify',
      selector: { kind: 'field', by: 'path', value: 'Descriptor_Unit_A.FrontArmor' },
      value: 7,
    });

    expect(output).toContain('FrontArmor = 7\r\n');
    expect(output).toContain('//     FrontArmor = 5');
    // The line break the field sat on survives the rewrite.
    expect(output).toContain('is TEntityDescriptor\r\n(\r\n');
    expect(output).toContain('Availability = 2\r\n');
  });

  test('removes the first field of a block', async () => {
    const output = await applyOperation({
      op: 'remove',
      selector: { kind: 'field', by: 'path', value: 'Descriptor_Unit_A.FrontArmor' },
    });

    // Only the commented copy is left; nothing declares the field any more.
    expect(output).not.toMatch(/^\s*FrontArmor = 5/m);
    expect(output).toContain('//     FrontArmor = 5');
    expect(output).toContain('Availability = 2\r\n');
  });
});

describe('adding top-level blocks', () => {
  const source = `First_Block is TType(Value = 1)

Second_Block is TType(Value = 2)
`;

  async function addBlock(operation: Record<string, unknown>): Promise<string> {
    return await applyPatchTarget(
      source,
      {
        file: 'GameData/Generated/Gameplay/Units.ndf',
        operations: [{ op: 'add', ...operation } as PatchTarget['operations'][number]],
      },
      application,
      'C:/fixture/Units.ndf',
    );
  }

  function positionOf(output: string, needle: string): number {
    return output.indexOf(needle);
  }

  test('appends at the end when no position is given', async () => {
    const output = await addBlock({ value: { $raw: 'New_Block is TType(Value = 3)' } });
    expect(positionOf(output, 'New_Block')).toBeGreaterThan(positionOf(output, 'Second_Block'));
  });

  test.each([
    ['start', false],
    ['end', true],
  ] as const)('places the block at the %s of the file', async (mode, expectAfter) => {
    const output = await addBlock({
      position: { mode },
      value: { $raw: 'New_Block is TType(Value = 3)' },
    });
    const isAfter = positionOf(output, 'New_Block') > positionOf(output, 'First_Block');
    expect(isAfter).toBe(expectAfter);
  });

  test.each([
    ['before', false],
    ['after', true],
  ] as const)('places the block %s its anchor', async (mode, expectAfter) => {
    const output = await addBlock({
      position: { mode, anchor: 'Second_Block' },
      value: { $raw: 'New_Block is TType(Value = 3)' },
    });
    const isAfter = positionOf(output, 'New_Block') > positionOf(output, 'Second_Block');
    expect(isAfter).toBe(expectAfter);
  });

  test('an anchor is an existing block, and says so when it is missing', async () => {
    // The old shape made the anchor look like the name of the block being
    // added, which produced exactly this mistake.
    await expect(
      addBlock({
        position: { mode: 'after', anchor: 'New_Block' },
        value: { $raw: 'New_Block is TType(Value = 3)' },
      }),
    ).rejects.toThrow('Anchor block `New_Block` was not found');
  });

  test('refuses to add a block whose name is already taken', async () => {
    // NDF still parses with two definitions of one name and the game quietly
    // picks one, so nothing downstream would report this.
    await expect(addBlock({ value: { $raw: 'Second_Block is TType(Value = 9)' } })).rejects.toThrow(
      'Top-level block `Second_Block` already exists',
    );
  });

  test('checks every block in a multi-block snippet', async () => {
    await expect(
      addBlock({
        value: { $raw: 'Fresh_Block is TType(Value = 8)\n\nFirst_Block is TType(Value = 9)' },
      }),
    ).rejects.toThrow('Top-level block `First_Block` already exists');
  });
});

describe('anchored collection inserts', () => {
  const divisions = `export DivisionRules is TDivisionRules
(
    DivisionIds =
    [
        ~/Descriptor_Deck_Division_A,
        ~/Descriptor_Deck_Division_B,
        ~/Descriptor_Deck_Division_C
    ]
)
`;

  async function insertBeside(
    mode: 'before' | 'after',
    anchor: string,
    source = divisions,
  ): Promise<string> {
    return await applyPatchTarget(
      source,
      {
        file: 'GameData/Generated/Gameplay/Divisions.ndf',
        operations: [
          {
            op: 'add',
            selector: { kind: 'collection', by: 'path', value: 'DivisionRules.DivisionIds' },
            value: { $raw: '~/Descriptor_Deck_Division_NEW' },
            position: { mode, anchor },
          },
        ],
      },
      application,
      'C:/fixture/Divisions.ndf',
    );
  }

  function readEntries(output: string): string[] {
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('~/'))
      .map((line) => line.replace(/,$/, ''));
  }

  test('places the entry after the anchor and its separator', async () => {
    // The insertion point used to stop before the anchor's comma, which left the
    // anchor and the new entry fused with a stray separator after them.
    const output = await insertBeside('after', '~/Descriptor_Deck_Division_B');

    expect(readEntries(output)).toEqual([
      '~/Descriptor_Deck_Division_A',
      '~/Descriptor_Deck_Division_B',
      '~/Descriptor_Deck_Division_NEW',
      '~/Descriptor_Deck_Division_C',
    ]);
    expect(output).not.toMatch(/^\s*,\s*$/m);
  });

  test('adds the missing separator when the anchor is the last entry', async () => {
    // `after` on the last entry lands where a plain append does, so the separator
    // the entry never wrote has to come from the trailing-separator check.
    const output = await insertBeside('after', '~/Descriptor_Deck_Division_C');

    expect(readEntries(output)).toEqual([
      '~/Descriptor_Deck_Division_A',
      '~/Descriptor_Deck_Division_B',
      '~/Descriptor_Deck_Division_C',
      '~/Descriptor_Deck_Division_NEW',
    ]);
    expect(output).toMatch(/~\/Descriptor_Deck_Division_C\s*,/);
  });

  test('keeps a missing separator out of a trailing comment on the last entry', async () => {
    const commented = `export DivisionRules is TDivisionRules
(
    DivisionIds =
    [
        ~/Descriptor_Deck_Division_A,
        ~/Descriptor_Deck_Division_B // kept for the campaign
    ]
)
`;

    const output = await insertBeside('after', '~/Descriptor_Deck_Division_B', commented);

    expect(output).toContain('// kept for the campaign\n');
    expect(output).not.toContain('// kept for the campaign,');
    expect(readEntries(output)).toEqual([
      '~/Descriptor_Deck_Division_A',
      '~/Descriptor_Deck_Division_B // kept for the campaign',
      '~/Descriptor_Deck_Division_NEW',
    ]);
  });

  test('ignores an anchor mentioned in a collection comment', async () => {
    const source = divisions.replace(
      '        ~/Descriptor_Deck_Division_A,',
      '        // Keep ~/Descriptor_Deck_Division_B after A.\n        ~/Descriptor_Deck_Division_A,',
    );
    const output = await insertBeside('before', '~/Descriptor_Deck_Division_B', source);

    expect(readEntries(output)).toEqual([
      '~/Descriptor_Deck_Division_A',
      '~/Descriptor_Deck_Division_NEW',
      '~/Descriptor_Deck_Division_B',
      '~/Descriptor_Deck_Division_C',
    ]);
    expect(output).toContain('// Keep ~/Descriptor_Deck_Division_B after A.');
  });

  test('places the entry before the anchor without leaving a blank indented line', async () => {
    const output = await insertBeside('before', '~/Descriptor_Deck_Division_B');

    expect(readEntries(output)).toEqual([
      '~/Descriptor_Deck_Division_A',
      '~/Descriptor_Deck_Division_NEW',
      '~/Descriptor_Deck_Division_B',
      '~/Descriptor_Deck_Division_C',
    ]);
    expect(output).not.toMatch(/[ \t]+$/m);
  });
});

describe('NDF value rendering', () => {
  async function renderField(value: unknown): Promise<string> {
    return await applyPatchTarget(
      'export Settings is TSettings\n(\n    ModPath = 0\n    Other = 1\n)\n',
      {
        file: 'GameData/Generated/Gameplay/Settings.ndf',
        operations: [
          {
            op: 'modify',
            selector: { kind: 'field', by: 'path', value: 'Settings.ModPath' },
            value,
          },
        ],
      },
      application,
      'C:/fixture/Settings.ndf',
    );
  }

  test('escapes backslashes so a value ending in one still closes its string', async () => {
    // `\` before the closing quote used to escape it, so the string ran on into the
    // rest of the file. `applyPatchTarget` validates its own output, so an unclosed
    // string would throw here.
    const backslash = String.fromCharCode(92);
    const output = await renderField(`C:${backslash}Games${backslash}WARNO${backslash}`);

    expect(output).toContain(
      `'C:${backslash}${backslash}Games${backslash}${backslash}WARNO${backslash}${backslash}'`,
    );
  });

  test('keeps a quote escape readable next to an escaped backslash', async () => {
    const backslash = String.fromCharCode(92);
    const output = await renderField(`it's ${backslash}`);

    expect(output).toContain(`"it's ${backslash}${backslash}"`);
  });
});
