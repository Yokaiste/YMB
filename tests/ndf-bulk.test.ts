import { describe, expect, test } from 'bun:test';
import { findTopLevelBlocks } from '../src/patch/ndf/scan.ts';
import { applyPatchTarget } from '../src/patch/ndf.ts';
import type { BulkOperation, PatchTarget } from '../src/types.ts';
import { application, expectYmbError } from './helpers/ndf.ts';

const file = 'GameData/Generated/Gameplay/Gfx/Ammunition.ndf';

function apply(source: string, operation: BulkOperation): string {
  const target: PatchTarget = { file, operations: [operation] };
  return applyPatchTarget(source, target, application, 'C:/fixture/Ammunition.ndf');
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
  test('multiplies fields only in matching blocks', () => {
    const output = apply(ammunition, {
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

  test('preserves float formatting and records the original value in comments', () => {
    const output = apply(ammunition, {
      op: 'bulk',
      match: {
        mode: 'all',
        conditions: [{ on: 'type', is: 'startsWith', value: ['TAmmunitionDescriptor'] }],
      },
      edits: [
        {
          field: 'ProjectileSpeedGRU',
          multiply: 1.5,
          comment: 'range increased 1.5x',
        },
      ],
      expect: { minBlocks: 2 },
    });

    expect(output).toContain('ProjectileSpeedGRU = 6000.0 // range increased 1.5x (was 4000.0)');
    expect(output).toContain('ProjectileSpeedGRU = 13500.0');
  });

  test('supports flattened cooked NDF without comments swallowing later blocks', () => {
    const source =
      'export First is TAmmunitionDescriptor ( ProjectileSpeedGRU = 4000.0 ) ' +
      'export Second is TAmmunitionDescriptor ( ProjectileSpeedGRU = 5000.0 )';
    const output = apply(source, {
      op: 'bulk',
      match: {
        mode: 'all',
        conditions: [{ on: 'type', is: 'startsWith', value: ['TAmmunitionDescriptor'] }],
      },
      edits: [{ field: 'ProjectileSpeedGRU', multiply: 1.5, comment: 'speed increased' }],
      leadingComment: 'bulk rule',
      expect: { minBlocks: 2 },
    });

    expect(output).toContain('// speed increased (was 4000.0)\n');
    expect(output).toContain('// bulk rule\n(');
    expect(output).toContain('= 7500.0');
    expect(findTopLevelBlocks(output)).toHaveLength(2);
  });

  test('lets a later operation edit a value annotated by an earlier operation', () => {
    const target: PatchTarget = {
      file,
      operations: [
        {
          op: 'bulk',
          match: {
            mode: 'all',
            conditions: [{ on: 'name', is: 'startsWith', value: ['Ammo_Canon'] }],
          },
          edits: [{ field: 'MaximumRangeGRU', multiply: 2, comment: 'first pass' }],
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

    const output = applyPatchTarget(ammunition, target, application, 'C:/fixture/Ammunition.ndf');
    expect(output).toContain('MaximumRangeGRU = 6300 // first pass (was 1575)');
  });

  test('supports any-match mode and alternative condition values', () => {
    const output = apply(ammunition, {
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

  test('matches nested field values and complete block text', () => {
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
    const output = apply(source, {
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

  test('edits matching MAP entries at any depth', () => {
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
    const output = apply(source, {
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

  test('removes and inserts collection entries with a standard leading comment', () => {
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
    const output = apply(source, {
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

  test('normalizes multiline leading comments like exact operations', () => {
    const output = apply(ammunition, {
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

  test('inserts into an empty collection', () => {
    const source = `Descriptor is TDescriptor
(
    ModulesDescriptors = []
)
`;
    const output = apply(source, {
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

  test('sets collection entries using negative indexes', () => {
    const source = `WeaponDescriptor_Test is TWeaponManagerModuleDescriptor
(
    Salves = [
        1,
        6,
        8,
    ]
)
`;
    const output = apply(source, {
      op: 'bulk',
      match: { mode: 'all', conditions: [{ on: 'name', is: 'startsWith', value: ['Weapon'] }] },
      edits: [{ list: 'Salves', setEntry: { index: -1, value: 3 } }],
      expect: { minBlocks: 1 },
    });

    expect(output).toContain('        1,\n        6,\n        3,\n');
  });

  test('keeps list insertion idempotent', () => {
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

    expect(apply(source, operation)).toBe(source);
  });

  test('leaves non-numeric multiply targets unchanged', () => {
    const source = `Ammo_Canon_Test is TAmmunitionDescriptor
(
    MaximumRangeGRU = ~/SomeReference
)
`;
    const output = apply(source, {
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

  test('rejects a multiply template that did not resolve to a finite number', () => {
    expect(() =>
      apply('export Unit is TDescriptor\n(\n    Speed = 10\n)\n', {
        op: 'bulk',
        match: {
          mode: 'all',
          conditions: [{ on: 'name', is: 'contains', value: ['Unit'] }],
        },
        edits: [{ field: 'Speed', multiply: 'twice' as unknown as number }],
        expect: { minBlocks: 1 },
      }),
    ).toThrow('must resolve to a finite number');
  });

  test('enforces block and edit expectations', () => {
    expectYmbError(
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

    expectYmbError(
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

  test('rejects overlapping edits instead of silently dropping one', () => {
    expectYmbError(
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
      'overlap',
    );
  });
});
