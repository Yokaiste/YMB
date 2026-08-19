import { describe, expect, test } from 'bun:test';
import {
  builderProjectSchema,
  modSchema,
  patchSchema,
  SUPPORTED_CONFIG_VERSION,
} from '../src/config/schemas.ts';
import { asOperation } from './helpers/ndf.ts';

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

describe('configuration version', () => {
  const mod = { id: 'fixture', name: 'Fixture' };
  const patch = { id: 'fixture.patch', name: 'Fixture patch', scope: 'prod' as const };
  const target = {
    targets: [{ file: 'GameData/Fixture.ndf', operations: [{ op: 'remove', selector: field }] }],
  };

  test('accepts only the exact supported version', () => {
    expect(modSchema.safeParse({ ...mod, version: 1 }).success).toBe(true);
    expect(patchSchema.safeParse({ ...patch, ...target, version: 1 }).success).toBe(true);
    expect(builderProjectSchema.safeParse({ version: 1 }).success).toBe(true);
  });

  test.each([2, 3, 10])('rejects a newer version and says to update YMB', (version) => {
    const parsed = modSchema.safeParse({ ...mod, version });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const message = parsed.error.issues[0]?.message ?? '';
    expect(message).toContain(`\`${version}\``);
    expect(message).toContain(`only supports \`${SUPPORTED_CONFIG_VERSION}\``);
    expect(message).toContain('update YMB');
  });

  test.each([modSchema, patchSchema, builderProjectSchema])(
    'rejects a version below the supported one',
    (schema) => {
      // Version `1` is current, so an "older" config cannot exist yet. Pinning
      // the branch now means the message is already right the day version `2`
      // ships, instead of silently accepting a stale config.
      const parsed = schema.safeParse({ ...mod, ...patch, ...target, version: 0.5 });
      expect(parsed.success).toBe(false);
    },
  );

  test('a mismatch offers migrating and staying put, not an ultimatum', () => {
    const parsed = modSchema.safeParse({ ...mod, version: 2 });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toContain('only supports');
  });
});

describe('configuration operation schemas', () => {
  test.each(['add', 'copy', 'replace'] as const)(
    'accepts `%s` file operations and applies patch defaults',
    (op) => {
      const parsed = patchSchema.safeParse({
        version: 1,
        id: 'fixture.files',
        name: 'Fixture files',
        scope: 'prod',
        files: [
          {
            op,
            source: { root: 'patch', path: 'assets' },
            destination: 'GameData/Assets',
            expect: { files: 2 },
          },
        ],
      });
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.files[0]?.op).toBe(op);
      expect(parsed.data.targets).toEqual([]);
      expect(parsed.data.scripts).toEqual([]);
    },
  );

  test('accepts remove file operations', () => {
    const parsed = patchSchema.safeParse({
      version: 1,
      id: 'fixture.files',
      name: 'Fixture files',
      scope: 'prod',
      files: [
        {
          op: 'remove',
          target: 'GameData/Assets/Old',
          expect: { files: 1 },
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  test.each([
    [{ op: 'add', source: { root: 'unknown', path: 'a' }, destination: 'GameData/a' }],
    [{ op: 'copy', source: { root: 'patch', path: '' }, destination: 'GameData/a' }],
    [{ op: 'replace', source: { root: 'patch', path: 'a' } }],
    [{ op: 'remove', target: 'GameData/a', source: { root: 'patch', path: 'a' } }],
    [{ op: 'remove', target: 'GameData/a', expect: { files: 0 } }],
    [{ op: 'move', source: { root: 'patch', path: 'a' }, destination: 'GameData/a' }],
  ])('rejects malformed file operations', (fileOperations) => {
    expect(
      patchSchema.safeParse({
        version: 1,
        id: 'fixture.files',
        name: 'Fixture files',
        scope: 'prod',
        files: fileOperations,
      }).success,
    ).toBe(false);
  });

  test.each([
    { op: 'copy', selector: objectName, destination: { name: 'Copy' } },
    { op: 'copy', selector: objectMatch, destination: { name: 'Copy' } },
    { op: 'modify', selector: field, value: false },
    { op: 'modify', selector: objectIndex, changes: { Value: 0 } },
    { op: 'add', value: { $raw: 'Descriptor is TType()' } },
    {
      op: 'add',
      value: { $raw: 'Descriptor is TType()' },
      position: { mode: 'after', anchor: 'Other' },
    },
    { op: 'add', value: { $raw: 'Descriptor is TType()' }, position: { mode: 'start' } },
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
    [{ op: 'copy', selector: objectName, destination: { name: 'Copy' }, value: 1 }, 'value'],
    [{ op: 'modify', selector: field, changes: { Value: 1 } }, 'changes'],
    [{ op: 'modify', selector: objectName, value: 1 }, 'value'],
    [{ op: 'add', selector: objectMatch, value: 1 }, 'selector'],
    // The old shape named the anchor the way other operations name their
    // target, which read as "the name of the block I am adding".
    [{ op: 'add', selector: objectName, value: 1 }, 'selector'],
    [{ op: 'add', selector: collection, value: 1, destination: { name: 'Copy' } }, 'destination'],
    [{ op: 'add', selector: field, value: 1, leadingComment: 'unsupported' }, 'leadingComment'],
    [{ op: 'remove', selector: objectName, value: 1 }, 'value'],
    [{ op: 'remove', selector: collection }, 'selector'],
  ] as const)('rejects unsupported operation properties', (operation, invalidProperty) => {
    const parsed = parseOperation(operation);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.path.includes(invalidProperty))).toBe(true);
  });

  test('names `destination.kind` when a config still carries the removed key', () => {
    // It was required once and read by nothing, so a config that kept it has to
    // be told rather than quietly accepted with a key that means nothing.
    const parsed = parseOperation({
      op: 'copy',
      selector: objectName,
      destination: { kind: 'sibling', name: 'Copy' },
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toEqual([
      'targets.0.operations.0.destination.kind',
    ]);
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

    const operation = asOperation(parsed.data.targets[0]?.operations[0]);
    expect(operation.op).toBe('bulk');
    if (operation.op !== 'bulk') return;
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
    [{ list: 'Modules', removeEntry: 'Old', trailingComment: 'unused' }, 'field` and `mapEntry'],
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

describe('script test phases', () => {
  function parseScripts(scripts: unknown) {
    return modSchema.safeParse({ version: 1, id: 'fixture', name: 'Fixture', scripts });
  }

  test('a bare path runs before its script, and `when` moves it after', () => {
    const parsed = parseScripts([
      {
        path: 'generate.ts',
        tests: ['unit.test.ts', { path: 'output.test.ts', when: 'after' }],
      },
    ]);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.scripts[0]?.tests).toEqual([
      { path: 'unit.test.ts', when: 'before' },
      { path: 'output.test.ts', when: 'after' },
    ]);
  });

  test('rejects a phase that is not one of the two, and unknown keys', () => {
    expect(
      parseScripts([{ path: 'generate.ts', tests: [{ path: 'a.test.ts', when: 'later' }] }])
        .success,
    ).toBe(false);
    expect(
      parseScripts([{ path: 'generate.ts', tests: [{ path: 'a.test.ts', phase: 'after' }] }])
        .success,
    ).toBe(false);
    expect(parseScripts([{ path: 'generate.ts', tests: [{ when: 'after' }] }]).success).toBe(false);
    expect(parseScripts([{ path: 'generate.ts', tests: [''] }]).success).toBe(false);
  });
});
