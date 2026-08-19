import { describe, expect, test } from 'bun:test';
import { patchSchema } from '../src/config/schemas.ts';
import { YmbError } from '../src/errors.ts';
import { expandPatchTarget } from '../src/patch/for-each.ts';
import type { AuthoredPatchTarget } from '../src/types.ts';

const context = {
  absolutePath: 'C:/fixture/ymb.patch.yaml',
  modId: 'sample_pack',
  modName: 'Sample Pack',
  patchId: 'balance.armor',
};

function expand(
  operations: AuthoredPatchTarget['operations'],
  variables: Record<string, unknown> = {},
) {
  return expandPatchTarget(
    { file: 'GameData/Generated/Units.ndf', operations },
    variables,
    context,
  );
}

function parsePatch(operationsYaml: unknown) {
  return patchSchema.safeParse({
    version: 1,
    id: 'fixture.patch',
    name: 'Fixture patch',
    scope: 'prod',
    targets: [{ file: 'GameData/Fixture.ndf', operations: operationsYaml }],
  });
}

describe('forEach expansion', () => {
  test('repeats its operations once per list entry with the binding applied', () => {
    const expanded = expand(
      [
        {
          forEach: '${roles}',
          as: 'role',
          do: [
            {
              op: 'modify',
              selector: { kind: 'field', by: 'path', value: 'Unit_${role}.Armor' },
              value: '${role}',
            },
          ],
        },
      ],
      { roles: ['Alpha', 'Bravo'] },
    );

    expect(expanded.operations).toHaveLength(2);
    expect(expanded.operations.map((operation) => operation.selector?.value)).toEqual([
      'Unit_Alpha.Armor',
      'Unit_Bravo.Armor',
    ]);
    expect(expanded.operations.map((operation) => operation.value)).toEqual(['Alpha', 'Bravo']);
  });

  test('binds the position of each entry alongside the entry itself', () => {
    const expanded = expand(
      [
        {
          forEach: '${roles}',
          as: 'role',
          do: [
            {
              op: 'modify',
              selector: { kind: 'field', by: 'path', value: 'Unit.Armor' },
              value: '${roleIndex}',
            },
          ],
        },
      ],
      { roles: ['Alpha', 'Bravo', 'Charlie'] },
    );

    // An exact template keeps its real type, so the index arrives as a number.
    expect(expanded.operations.map((operation) => operation.value)).toEqual([0, 1, 2]);
  });

  test('accepts an inline list and keeps surrounding operations in order', () => {
    const expanded = expand([
      { op: 'remove', selector: { kind: 'field', by: 'path', value: 'Unit.Before' } },
      {
        forEach: [1, 2],
        as: 'n',
        do: [
          { op: 'modify', selector: { kind: 'field', by: 'path', value: 'Unit.N${n}' }, value: 0 },
        ],
      },
      { op: 'remove', selector: { kind: 'field', by: 'path', value: 'Unit.After' } },
    ]);

    expect(expanded.operations.map((operation) => operation.selector?.value)).toEqual([
      'Unit.Before',
      'Unit.N1',
      'Unit.N2',
      'Unit.After',
    ]);
  });

  test('nests, with the inner loop seeing the outer binding', () => {
    const expanded = expand(
      [
        {
          forEach: '${sides}',
          as: 'side',
          do: [
            {
              forEach: '${slots}',
              as: 'slot',
              do: [
                {
                  op: 'modify',
                  selector: { kind: 'field', by: 'path', value: 'Unit_${side}_${slot}.Armor' },
                  value: 1,
                },
              ],
            },
          ],
        },
      ],
      { sides: ['NATO', 'PACT'], slots: ['A', 'B'] },
    );

    expect(expanded.operations.map((operation) => operation.selector?.value)).toEqual([
      'Unit_NATO_A.Armor',
      'Unit_NATO_B.Armor',
      'Unit_PACT_A.Armor',
      'Unit_PACT_B.Armor',
    ]);
  });

  test('an empty list produces no operations rather than an error', () => {
    expect(
      expand(
        [
          {
            forEach: '${roles}',
            as: 'role',
            do: [
              { op: 'remove', selector: { kind: 'field', by: 'path', value: 'Unit_${role}.X' } },
            ],
          },
        ],
        { roles: [] },
      ).operations,
    ).toEqual([]);
  });

  test('names the mistake when the list is not a list', () => {
    // The common typo: pointing `forEach` at a scalar.
    try {
      expand(
        [
          {
            forEach: '${roles}',
            as: 'role',
            do: [{ op: 'remove', selector: { kind: 'field', by: 'path', value: 'X' } }],
          },
        ],
        { roles: 'Alpha' },
      );
      throw new Error('Expected expansion to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(YmbError);
      expect((error as YmbError).context.reason).toContain('`forEach` needs a list');
      // The error belongs to the patch config, not to the game file.
      expect((error as YmbError).context.absolutePath).toBe(context.absolutePath);
      expect((error as YmbError).context.patchId).toBe('balance.armor');
    }
  });

  test('names the missing variable when the list is spelled wrong', () => {
    // A name no variable answers is reported as the typo it is. It used to
    // resolve to empty text and arrive here as "needs a list", which blamed the
    // shape of the value instead of the name that produced it.
    expect(() =>
      expand([
        {
          forEach: '${missing}',
          as: 'role',
          do: [{ op: 'remove', selector: { kind: 'field', by: 'path', value: 'X' } }],
        },
      ]),
    ).toThrow('Unknown template variable "missing"');
  });

  test('stops a runaway loop instead of expanding forever', () => {
    expect(() =>
      expand(
        [
          {
            forEach: '${many}',
            as: 'n',
            do: [{ op: 'remove', selector: { kind: 'field', by: 'path', value: 'Unit.N${n}' } }],
          },
        ],
        { many: Array.from({ length: 20_000 }, (_value, index) => index) },
      ),
    ).toThrow('expanded past');
  });
});

describe('forEach config schema', () => {
  test('accepts a loop holding operations', () => {
    expect(
      parsePatch([
        {
          forEach: '${roles}',
          as: 'role',
          do: [{ op: 'remove', selector: { kind: 'field', by: 'path', value: 'Unit_${role}.X' } }],
        },
      ]).success,
    ).toBe(true);
  });

  test.each([
    [{ forEach: '${roles}', do: [] }, 'a missing `as`'],
    [{ forEach: '${roles}', as: 'role' }, 'a missing `do`'],
    [{ forEach: '${roles}', as: 'role', do: [] }, 'an empty `do`'],
    [{ forEach: '${roles}', as: 'role', do: [{ op: 'nope' }] }, 'a bad inner operation'],
    [{ forEach: '${roles}', as: 'role', do: [], extra: 1 }, 'an unknown key'],
  ])('rejects %#: %s', (operation) => {
    expect(parsePatch([operation]).success).toBe(false);
  });

  test('still reports a precise path for a plain operation beside a loop', () => {
    const parsed = parsePatch([
      {
        op: 'add',
        selector: { kind: 'field', by: 'path', value: 'Unit.X' },
        value: 1,
        leadingComment: 'unsupported here',
      },
    ]);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.path.includes('leadingComment'))).toBe(true);
  });
});
