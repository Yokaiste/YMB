import { describe, expect, test } from 'bun:test';
import { findTopLevelBlocks } from '../src/patch/ndf/scan.ts';
import { validateNdf } from '../src/patch/ndf/validate.ts';
import type { BulkOperation, PatchTarget } from '../src/types.ts';
import { application, applyPatchTarget, expectYmbError } from './helpers/ndf.ts';

const file = 'GameData/Generated/Gameplay/Gfx/Ammunition.ndf';

async function apply(source: string, operation: BulkOperation): Promise<string> {
  const target: PatchTarget = { file, operations: [operation] };
  return await applyPatchTarget(source, target, application, 'C:/fixture/Ammunition.ndf');
}

const ammunition = `Ammo_Canon_AP_105mm is TAmmunitionDescriptor
(
    MaximumRangeGRU = 1575
    ProjectileSpeedGRU = 4000.0
)

Ammo_SAM_Patriot is TAmmunitionDescriptor
(
    MaximumRangeGRU = 12000
    ProjectileSpeedGRU = 9000.0
)
`;

describe('bulk NDF operations', () => {
  test('multiplies fields only in matching blocks', async () => {
    const output = await apply(ammunition, {
      op: 'bulk',
      match: {
        mode: 'all',
        conditions: [{ on: 'name', is: 'startsWith', value: ['Ammo_Canon'] }],
      },
      edits: [{ field: 'MaximumRangeGRU', multiply: 2 }],
      expect: { minBlocks: 1 },
    });

    expect(output).toContain('MaximumRangeGRU = 3150');
    expect(output).toContain('MaximumRangeGRU = 12000');
  });

  test('preserves float formatting and records the original value in comments', async () => {
    const output = await apply(ammunition, {
      op: 'bulk',
      match: {
        mode: 'all',
        conditions: [{ on: 'type', is: 'startsWith', value: ['TAmmunitionDescriptor'] }],
      },
      edits: [
        {
          field: 'ProjectileSpeedGRU',
          multiply: 1.5,
          trailingComment: 'range increased 1.5x',
        },
      ],
      expect: { minBlocks: 2 },
    });

    expect(output).toContain('ProjectileSpeedGRU = 6000.0 // range increased 1.5x (was 4000.0)');
    expect(output).toContain('ProjectileSpeedGRU = 13500.0');
  });

  /** A plain `includes('//')` read a value holding `//` as already commented and dropped the note. */
  test('still records the original value when the line holds a `//` inside a string', async () => {
    const source =
      'export First is TAmmunitionDescriptor\n(\n' +
      '    ProjectileSpeedGRU = 4000.0\n' +
      '    HelpText = "see http://example/wiki"\n)\n';
    const output = await apply(source, {
      op: 'bulk',
      match: {
        mode: 'all',
        conditions: [{ on: 'type', is: 'startsWith', value: ['TAmmunitionDescriptor'] }],
      },
      edits: [{ field: 'HelpText', set: { $raw: '"gone"' }, trailingComment: 'text replaced' }],
      expect: { minBlocks: 1 },
    });

    expect(output).toContain('HelpText = "gone" // text replaced (was "see http://example/wiki")');
  });

  test('supports flattened cooked NDF without comments swallowing later blocks', async () => {
    const source =
      'export First is TAmmunitionDescriptor ( ProjectileSpeedGRU = 4000.0 ) ' +
      'export Second is TAmmunitionDescriptor ( ProjectileSpeedGRU = 5000.0 )';
    const output = await apply(source, {
      op: 'bulk',
      match: {
        mode: 'all',
        conditions: [{ on: 'type', is: 'startsWith', value: ['TAmmunitionDescriptor'] }],
      },
      edits: [{ field: 'ProjectileSpeedGRU', multiply: 1.5, trailingComment: 'speed increased' }],
      leadingComment: 'bulk rule',
      expect: { minBlocks: 2 },
    });

    expect(output).toContain('// speed increased (was 4000.0)\n');
    expect(output).toContain('// bulk rule\n(');
    expect(output).toContain('= 7500.0');
    expect(findTopLevelBlocks(output)).toHaveLength(2);
  });

  test('lets a later operation edit a value annotated by an earlier operation', async () => {
    const target: PatchTarget = {
      file,
      operations: [
        {
          op: 'bulk',
          match: {
            mode: 'all',
            conditions: [{ on: 'name', is: 'startsWith', value: ['Ammo_Canon'] }],
          },
          edits: [{ field: 'MaximumRangeGRU', multiply: 2, trailingComment: 'first pass' }],
          expect: { minBlocks: 1 },
        },
        {
          op: 'bulk',
          match: {
            mode: 'all',
            conditions: [{ on: 'name', is: 'startsWith', value: ['Ammo_Canon_AP'] }],
          },
          edits: [{ field: 'MaximumRangeGRU', multiply: 2 }],
          expect: { minBlocks: 1 },
        },
      ],
    };

    const output = await applyPatchTarget(
      ammunition,
      target,
      application,
      'C:/fixture/Ammunition.ndf',
    );
    expect(output).toContain('MaximumRangeGRU = 6300 // first pass (was 1575)');
  });

  test('supports any-match mode and alternative condition values', async () => {
    const output = await apply(ammunition, {
      op: 'bulk',
      match: {
        mode: 'any',
        conditions: [
          { on: 'name', is: 'startsWith', value: ['Ammo_Canon', 'Unused'] },
          { on: 'name', is: 'endsWith', value: ['Patriot'] },
        ],
      },
      edits: [{ field: 'MaximumRangeGRU', set: 1 }],
      expect: { minBlocks: 2 },
    });

    expect(output.match(/MaximumRangeGRU = 1$/gm)).toHaveLength(2);
  });

  test('matches nested field values and complete block text', async () => {
    const source = `Descriptor_Unit_Tank is TEntityDescriptor
(
    TagSet = [ "GroundUnits", "Tank" ]
    MaxSpeedInKmph = 60
)

Descriptor_Unit_Jet is TEntityDescriptor
(
    TagSet = [ "Air", "Avion" ]
    MaxSpeedInKmph = 900
)
`;
    const output = await apply(source, {
      op: 'bulk',
      match: {
        mode: 'all',
        conditions: [
          { on: 'field', field: 'TagSet', is: 'notContains', value: ['"Air"'] },
          { on: 'text', is: 'contains', value: ['MaxSpeedInKmph'] },
        ],
      },
      edits: [{ field: 'MaxSpeedInKmph', multiply: 0.7 }],
      expect: { minBlocks: 1 },
    });

    expect(output).toContain('MaxSpeedInKmph = 42');
    expect(output).toContain('MaxSpeedInKmph = 900');
  });

  test('edits matching MAP entries at any depth', async () => {
    const source = `Descriptor_Unit_Scout is TEntityDescriptor
(
    ModulesDescriptors =
    [
        TScannerConfigurationDescriptor
        (
            VisionRangesGRU = MAP [
                ( EVisionRange/Standard, 3500.0 ),
                ( EVisionRange/LowAltitude, 4947.0 ),
            ]
        ),
    ]
)
`;
    const output = await apply(source, {
      op: 'bulk',
      match: {
        mode: 'all',
        conditions: [{ on: 'name', is: 'startsWith', value: ['Descriptor_'] }],
      },
      edits: [{ mapEntry: 'EVisionRange/Standard', multiply: 2 }],
      expect: { minBlocks: 1 },
    });

    expect(output).toContain('( EVisionRange/Standard, 7000.0 )');
    expect(output).toContain('( EVisionRange/LowAltitude, 4947.0 )');
  });

  test('removes and inserts collection entries with a standard leading comment', async () => {
    const source = `Descriptor_Unit_FOB is TEntityDescriptor
(
    ModulesDescriptors =
    [
        TDangerousnessModuleDescriptor(Dangerousness = 39),
        ~/FacingInfosModuleDescriptor,
        TGenericMovementModuleDescriptor,
    ]
)
`;
    const output = await apply(source, {
      op: 'bulk',
      match: {
        mode: 'all',
        conditions: [{ on: 'name', is: 'startsWith', value: ['Descriptor_'] }],
      },
      edits: [
        { list: 'ModulesDescriptors', removeEntry: '~/FacingInfosModuleDescriptor' },
        {
          list: 'ModulesDescriptors',
          insert: { value: { $raw: 'TDeploymentShiftModuleDescriptor' }, position: 'start' },
        },
      ],
      leadingComment: 'forward deployable',
      expect: { minBlocks: 1 },
    });

    expect(output).not.toContain('FacingInfosModuleDescriptor');
    expect(output).toContain('TDeploymentShiftModuleDescriptor,');
    expect(output).toContain('Descriptor_Unit_FOB is TEntityDescriptor\n// forward deployable\n(');
  });

  test('normalizes multiline leading comments like exact operations', async () => {
    const output = await apply(ammunition, {
      op: 'bulk',
      match: {
        mode: 'all',
        conditions: [{ on: 'name', is: 'startsWith', value: ['Ammo_Canon'] }],
      },
      edits: [{ field: 'MaximumRangeGRU', multiply: 2 }],
      leadingComment: ' first line\r\nsecond line ',
      expect: { minBlocks: 1 },
    });

    expect(output).toContain(
      'Ammo_Canon_AP_105mm is TAmmunitionDescriptor\n// first line\n// second line\n(',
    );
  });

  test('inserts into an empty collection', async () => {
    const source = `Descriptor is TDescriptor
(
    ModulesDescriptors = []
)
`;
    const output = await apply(source, {
      op: 'bulk',
      match: { mode: 'all', conditions: [{ on: 'name', is: 'startsWith', value: ['Descriptor'] }] },
      edits: [
        {
          list: 'ModulesDescriptors',
          insert: { value: { $raw: 'TNewModuleDescriptor' }, position: 'end' },
          minChanges: 1,
        },
      ],
      expect: { minBlocks: 1 },
    });

    expect(output).toContain('ModulesDescriptors = [\n        TNewModuleDescriptor,\n    ]');
  });

  test('sets collection entries using negative indexes', async () => {
    const source = `WeaponDescriptor_Test is TWeaponManagerModuleDescriptor
(
    Salves = [
        1,
        6,
        8,
    ]
)
`;
    const output = await apply(source, {
      op: 'bulk',
      match: { mode: 'all', conditions: [{ on: 'name', is: 'startsWith', value: ['Weapon'] }] },
      edits: [{ list: 'Salves', setEntry: { index: -1, value: 3 } }],
      expect: { minBlocks: 1 },
    });

    expect(output).toContain('        1,\n        6,\n        3,\n');
  });

  test('keeps list insertion idempotent', async () => {
    const source = `Descriptor is TDescriptor
(
    ModulesDescriptors = [ TDeploymentShiftModuleDescriptor, ]
)
`;
    const operation: BulkOperation = {
      op: 'bulk',
      match: { mode: 'all', conditions: [{ on: 'name', is: 'startsWith', value: ['Descriptor'] }] },
      edits: [
        {
          list: 'ModulesDescriptors',
          insert: { value: { $raw: 'TDeploymentShiftModuleDescriptor' }, position: 'start' },
        },
      ],
      leadingComment: 'inserted once',
      expect: { minBlocks: 1 },
    };

    expect(await apply(source, operation)).toBe(source);
  });

  test('leaves non-numeric multiply targets unchanged', async () => {
    const source = `Ammo_Canon_Test is TAmmunitionDescriptor
(
    MaximumRangeGRU = ~/SomeReference
)
`;
    const output = await apply(source, {
      op: 'bulk',
      match: {
        mode: 'all',
        conditions: [{ on: 'name', is: 'startsWith', value: ['Ammo_Canon'] }],
      },
      edits: [{ field: 'MaximumRangeGRU', multiply: 2 }],
      expect: { minBlocks: 1 },
    });

    expect(output).toBe(source);
  });

  test('rejects a multiply template that did not resolve to a finite number', async () => {
    await expect(
      apply('export Unit is TDescriptor\n(\n    Speed = 10\n)\n', {
        op: 'bulk',
        match: {
          mode: 'all',
          conditions: [{ on: 'name', is: 'contains', value: ['Unit'] }],
        },
        edits: [{ field: 'Speed', multiply: 'twice' as unknown as number }],
        expect: { minBlocks: 1 },
      }),
    ).rejects.toThrow('must resolve to a finite number');
  });

  test('enforces block and edit expectations', async () => {
    await expectYmbError(
      () =>
        apply(ammunition, {
          op: 'bulk',
          match: {
            mode: 'all',
            conditions: [{ on: 'name', is: 'startsWith', value: ['Missing'] }],
          },
          edits: [{ field: 'MaximumRangeGRU', multiply: 2 }],
          expect: { minBlocks: 1 },
        }),
      'SelectorError',
      'matched 0 block(s)',
    );

    await expectYmbError(
      () =>
        apply(ammunition, {
          op: 'bulk',
          match: {
            mode: 'all',
            conditions: [{ on: 'name', is: 'startsWith', value: ['Ammo_Canon'] }],
          },
          edits: [{ field: 'MissingField', set: 1, minChanges: 1 }],
          expect: { minBlocks: 1 },
        }),
      'SelectorError',
      'changed 0 value(s)',
    );
  });

  test('appends after a last entry that carries no trailing comma', async () => {
    // The insertion point used to be the entry's separator, which for a last entry
    // with no comma is the closing bracket - so the new entry landed against the
    // previous one with nothing between them and the file no longer parsed.
    const source = `Ammo_Canon_AP_105mm is TAmmunitionDescriptor
(
    ModulesDescriptors =
    [
        ~/Module_A,
        ~/Module_B
    ]
)
`;

    const output = await apply(source, {
      op: 'bulk',
      match: { mode: 'all', conditions: [{ on: 'name', is: 'startsWith', value: ['Ammo_'] }] },
      edits: [
        { list: 'ModulesDescriptors', insert: { value: { $raw: '~/Module_C' }, position: 'end' } },
      ],
      expect: { minBlocks: 1 },
    });

    expect(output).toContain('~/Module_B,\n        ~/Module_C,');
    expect(() => validateNdf(output, 'C:/fixture/Ammunition.ndf')).not.toThrow();
  });

  test('rejects overlapping edits instead of silently dropping one', async () => {
    await expectYmbError(
      () =>
        apply(ammunition, {
          op: 'bulk',
          match: {
            mode: 'all',
            conditions: [{ on: 'name', is: 'startsWith', value: ['Ammo_Canon'] }],
          },
          edits: [
            { field: 'MaximumRangeGRU', multiply: 2 },
            { field: 'MaximumRangeGRU', set: 1 },
          ],
          expect: { minBlocks: 1 },
        }),
      'ConflictError',
      // Not "duplicate": the usual cause is one edit's field sitting inside the
      // value another edit replaces wholesale, and calling that a duplicate sent
      // readers looking for a repeated target that is not there.
      'write over the same text in one matched block',
    );
  });
});
