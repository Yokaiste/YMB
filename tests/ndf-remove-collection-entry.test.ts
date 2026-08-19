import { describe, expect, test } from 'bun:test';
import { validateNdf } from '../src/patch/ndf/validate.ts';
import type { PatchTarget } from '../src/types.ts';
import { application, applyPatchTarget } from './helpers/ndf.ts';

// Indented type names are legal multi-line entries; only column 1 breaks the cook.
const DEDENTED_TYPE_NAME = /^[A-Za-z_][A-Za-z0-9_]*[ \t]*$/m;

const source = `export Descriptor_Unit_YZ_Swarm is TEntityDescriptor
(
    ModulesDescriptors =
    [
        TDangerousnessModuleDescriptor
        (
            Dangerousness = 190
        ),
        TBaseDamageModuleDescriptor
        (
            PhysicalDamageLevelsPack = DamageLevelsPackDescriptor_Default
            MaxPhysicalDamages = 9.0
        ),
        TDamageModuleDescriptor
        (
            KillWhenDamagesReachMax = True
        ),
    ]
)
`;

async function removeEntry(value: string): Promise<string> {
  const target: PatchTarget = {
    file: 'GameData/Generated/Gameplay/Gfx/UniteDescriptor.ndf',
    operations: [{ op: 'remove', selector: { kind: 'field', by: 'path', value } }],
  };
  return await applyPatchTarget(source, target, application, 'C:/fixture/UniteDescriptor.ndf');
}

function liveText(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

describe('adding collection entries before a multi-line anchor', () => {
  const sharedLineSource = `export Descriptor_Unit_YZ_Stalker is TEntityDescriptor
(
    ModulesDescriptors =
    [
        TFooModuleDescriptor( A = 1 ), TBarModuleDescriptor
        (
            B = 2
        ),
    ]
)
`;

  test('keeps the anchor entry indented after the inserted marker block', async () => {
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Gfx/UniteDescriptor.ndf',
      operations: [
        {
          op: 'add',
          selector: {
            kind: 'collection',
            by: 'path',
            value: 'Descriptor_Unit_YZ_Stalker.ModulesDescriptors',
          },
          position: { mode: 'before', anchor: 'TBarModuleDescriptor' },
          value: { $raw: 'TNewModuleDescriptor( C = 3 )' },
        },
      ],
    };

    const output = await applyPatchTarget(
      sharedLineSource,
      target,
      application,
      'C:/fixture/UniteDescriptor.ndf',
    );

    expect(output).toContain('YMB-ADD-END');
    expect(output).not.toMatch(DEDENTED_TYPE_NAME);
    expect(output).toContain('        TBarModuleDescriptor\n');
    expect(() => validateNdf(output, 'C:/fixture/UniteDescriptor.ndf')).not.toThrow();
  });
});

describe('removing multi-line collection entries', () => {
  test('removes scalar reference entries by exact value', async () => {
    const scalarSource = `export Descriptor_Unit_Test is TEntityDescriptor
(
    ModulesDescriptors =
    [
        ~/BuildingOrderConfigModuleDescriptor,
        $/GFX/Weapon/WeaponDescriptor_Test,
        TBaseDamageModuleDescriptor(MaxPhysicalDamages = 10),
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
            value:
              'Descriptor_Unit_Test.ModulesDescriptors.[value=$/GFX/Weapon/WeaponDescriptor_Test]',
          },
        },
      ],
    };

    const output = await applyPatchTarget(
      scalarSource,
      target,
      application,
      'C:/fixture/UniteDescriptor.ndf',
    );

    expect(liveText(output)).not.toContain('$/GFX/Weapon/WeaponDescriptor_Test');
    expect(liveText(output)).toContain('~/BuildingOrderConfigModuleDescriptor');
    expect(() => validateNdf(output, 'C:/fixture/UniteDescriptor.ndf')).not.toThrow();
  });

  test('comments out the removed entry including its type-name line', async () => {
    const output = await removeEntry(
      'Descriptor_Unit_YZ_Swarm.ModulesDescriptors.[TBaseDamageModuleDescriptor]',
    );

    expect(output).toContain('YMB-REMOVE-START');
    expect(output).toContain('// TBaseDamageModuleDescriptor');
    expect(liveText(output)).not.toContain('TBaseDamageModuleDescriptor');
    expect(() => validateNdf(output, 'C:/fixture/UniteDescriptor.ndf')).not.toThrow();
  });

  test('preserves the indentation of the entry following the removed one', async () => {
    const output = await removeEntry(
      'Descriptor_Unit_YZ_Swarm.ModulesDescriptors.[TBaseDamageModuleDescriptor]',
    );

    expect(output).not.toMatch(DEDENTED_TYPE_NAME);
    expect(output).toContain('        TDamageModuleDescriptor\n');
  });

  test('preserves the indentation when removing by index', async () => {
    const output = await removeEntry('Descriptor_Unit_YZ_Swarm.ModulesDescriptors.[0]');

    expect(liveText(output)).not.toContain('TDangerousnessModuleDescriptor');
    expect(output).not.toMatch(DEDENTED_TYPE_NAME);
    expect(output).toContain('        TBaseDamageModuleDescriptor\n');
    expect(() => validateNdf(output, 'C:/fixture/UniteDescriptor.ndf')).not.toThrow();
  });

  test('removes the trailing entry without dedenting the collection close', async () => {
    const output = await removeEntry(
      'Descriptor_Unit_YZ_Swarm.ModulesDescriptors.[TDamageModuleDescriptor]',
    );

    expect(liveText(output)).not.toContain('TDamageModuleDescriptor');
    expect(output).not.toMatch(DEDENTED_TYPE_NAME);
    expect(output).toContain('    ]\n');
    expect(() => validateNdf(output, 'C:/fixture/UniteDescriptor.ndf')).not.toThrow();
  });

  test('keeps every remaining entry indented when consecutive removes stack up', async () => {
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Gfx/UniteDescriptor.ndf',
      operations: [
        {
          op: 'remove',
          selector: {
            kind: 'field',
            by: 'path',
            value: 'Descriptor_Unit_YZ_Swarm.ModulesDescriptors.[TDangerousnessModuleDescriptor]',
          },
        },
        {
          op: 'remove',
          selector: {
            kind: 'field',
            by: 'path',
            value: 'Descriptor_Unit_YZ_Swarm.ModulesDescriptors.[TBaseDamageModuleDescriptor]',
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

    expect(output).not.toMatch(DEDENTED_TYPE_NAME);
    expect(liveText(output)).not.toContain('TDangerousnessModuleDescriptor');
    expect(liveText(output)).not.toContain('TBaseDamageModuleDescriptor');
    expect(output).toContain('        TDamageModuleDescriptor\n');
    expect(() => validateNdf(output, 'C:/fixture/UniteDescriptor.ndf')).not.toThrow();
  });
});
