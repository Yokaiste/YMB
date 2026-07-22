import { describe, expect, test } from 'bun:test';
import { patchSchema } from '../src/config/schemas.ts';

const field = { kind: 'field', by: 'path', value: 'Descriptor.Value' } as const;
const collection = { kind: 'collection', by: 'path', value: 'Descriptor.Items' } as const;
const objectName = { kind: 'object', by: 'name', value: 'Descriptor' } as const;
const objectIndex = { kind: 'object', by: 'index', value: 0 } as const;
const objectMatch = { kind: 'object', by: 'match', where: { Value: 1 } } as const;

function parseOperation(operation: unknown) {
  return patchSchema.safeParse({
    version: 1,
    id: 'fixture.patch',
    name: 'Fixture patch',
    scope: 'prod',
    targets: [{ file: 'GameData/Fixture.ndf', operations: [operation] }],
  });
}

describe('configuration operation schemas', () => {
  test.each([
    { op: 'copy', selector: objectName, destination: { kind: 'sibling', name: 'Copy' } },
    { op: 'copy', selector: objectMatch, destination: { kind: 'name', name: 'Copy' } },
    { op: 'modify', selector: field, value: false },
    { op: 'modify', selector: objectIndex, changes: { Value: 0 } },
    { op: 'add', selector: objectName, value: { $raw: 'Descriptor is TType()' } },
    {
      op: 'add',
      selector: collection,
      value: 'Item',
      position: { mode: 'before', anchor: 'Other' },
    },
    { op: 'add', selector: field, value: 0 },
    { op: 'remove', selector: objectMatch },
    { op: 'remove', selector: field },
  ])('accepts a precise operation shape', (operation) => {
    expect(parseOperation(operation).success).toBe(true);
  });

  test.each([
    [
      { op: 'copy', selector: objectName, destination: { kind: 'name', name: 'Copy' }, value: 1 },
      'value',
    ],
    [{ op: 'modify', selector: field, changes: { Value: 1 } }, 'changes'],
    [{ op: 'modify', selector: objectName, value: 1 }, 'value'],
    [{ op: 'add', selector: objectMatch, value: 1 }, 'selector'],
    [
      { op: 'add', selector: collection, value: 1, destination: { kind: 'name', name: 'Copy' } },
      'destination',
    ],
    [{ op: 'add', selector: field, value: 1, leadingComment: 'unsupported' }, 'leadingComment'],
    [{ op: 'remove', selector: objectName, value: 1 }, 'value'],
    [{ op: 'remove', selector: collection }, 'selector'],
  ] as const)('rejects unsupported operation properties', (operation, invalidProperty) => {
    const parsed = parseOperation(operation);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.path.includes(invalidProperty))).toBe(true);
  });

  test('requires collection anchors only for relative positions', () => {
    expect(
      parseOperation({ op: 'add', selector: collection, value: 1, position: { mode: 'before' } })
        .success,
    ).toBe(false);
    expect(
      parseOperation({ op: 'add', selector: collection, value: 1, position: { mode: 'end' } })
        .success,
    ).toBe(true);
  });

  test.each([
    { field: 'Speed', set: false },
    { field: 'Speed', multiply: 1.5 },
    { field: 'Speed', multiply: '${speedMultiplier}' },
    { mapEntry: 'EVisionRange/Standard', set: 0 },
    { mapEntry: 'EVisionRange/Standard', multiply: 2 },
    { list: 'Modules', insert: { value: null } },
    { list: 'Modules', removeEntry: '~/OldModule' },
    { list: 'Modules', setEntry: { index: -1, value: { $raw: 'TModule' } } },
  ])('accepts a precise bulk edit shape', (edit) => {
    expect(
      parseOperation({
        op: 'bulk',
        match: { conditions: [{ on: 'name', is: 'startsWith', value: 'Descriptor_' }] },
        edits: [edit],
      }).success,
    ).toBe(true);
  });

  test('normalizes bulk defaults and scalar condition values', () => {
    const parsed = parseOperation({
      op: 'bulk',
      match: { conditions: [{ on: 'name', is: 'contains', value: 'Unit' }] },
      edits: [{ list: 'Modules', insert: { value: 'NewModule' } }],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const operation = parsed.data.targets[0]?.operations[0];
    expect(operation?.op).toBe('bulk');
    if (operation?.op !== 'bulk') return;
    expect(operation.match).toEqual({
      mode: 'all',
      conditions: [{ on: 'name', is: 'contains', value: ['Unit'] }],
    });
    expect(operation.expect).toEqual({ minBlocks: 1 });
    expect(operation.edits[0]?.insert?.position).toBe('end');
  });

  test.each([
    [{ on: 'field', is: 'contains', value: 'Tank' }, 'require `field`'],
    [{ on: 'name', field: 'TagSet', is: 'contains', value: 'Tank' }, 'only supported'],
  ] as const)('rejects invalid bulk condition shapes', (condition, message) => {
    const parsed = parseOperation({
      op: 'bulk',
      match: { conditions: [condition] },
      edits: [{ field: 'Speed', set: 1 }],
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes(message))).toBe(true);
  });

  test.each([
    [{ field: 'Speed' }, 'exactly one of `set`'],
    [{ field: 'Speed', set: 1, multiply: 2 }, 'exactly one of `set`'],
    [{ field: 'Speed', mapEntry: 'Speed', set: 1 }, 'exactly one of `field`'],
    [{ list: 'Modules', set: 1 }, '`list` edits support'],
    [{ field: 'Modules', insert: { value: 1 } }, 'require a `list`'],
    [{ list: 'Modules', removeEntry: 'Old', comment: 'unused' }, 'field` and `mapEntry'],
    [{ list: 'Modules', insert: {} }, 'required'],
    [{ list: 'Modules', setEntry: { index: 0 } }, 'required'],
    [{ field: 'Speed', multiply: Number.POSITIVE_INFINITY }, 'finite number'],
    [{ field: 'Speed', multiply: 'twice' }, 'exact template expression'],
    [{ field: 'Speed', set: 1, minChanges: -1 }, '>=0'],
  ] as const)('rejects invalid bulk edit shapes', (edit, message) => {
    const parsed = parseOperation({
      op: 'bulk',
      match: { conditions: [{ on: 'name', is: 'contains', value: 'Unit' }] },
      edits: [edit],
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes(message))).toBe(true);
  });

  test.each(['selector', 'value', 'changes', 'destination', 'position', 'annotate'] as const)(
    'rejects unsupported `%s` on bulk operations',
    (property) => {
      const parsed = parseOperation({
        op: 'bulk',
        match: { conditions: [{ on: 'type', is: 'contains', value: 'Descriptor' }] },
        edits: [{ field: 'Speed', set: 1 }],
        [property]: {},
      });
      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      expect(parsed.error.issues.some((issue) => issue.path.includes(property))).toBe(true);
    },
  );

  test('rejects empty bulk collections and negative block expectations', () => {
    expect(parseOperation({ op: 'bulk', match: { conditions: [] }, edits: [] }).success).toBe(
      false,
    );
    expect(
      parseOperation({
        op: 'bulk',
        match: { conditions: [{ on: 'text', is: 'contains', value: 'Descriptor' }] },
        edits: [{ field: 'Speed', set: 1 }],
        expect: { minBlocks: -1 },
      }).success,
    ).toBe(false);
  });
});
