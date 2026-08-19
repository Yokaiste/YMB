import { describe, expect, test } from 'bun:test';
import { dedupePatchNotices, toPatchReportFinding } from '../src/engine/patch-notices.ts';
import { formatFindingGroups } from '../src/report/findings.ts';
import type { BulkOperation, NdfOperation, PatchNotice, PatchTarget } from '../src/types.ts';
import { application, applyPatchTarget, expectYmbError } from './helpers/ndf.ts';

const file = 'GameData/Generated/Gameplay/Units.ndf';
const absolutePath = 'C:/fixture/Units.ndf';

async function applyCollectingNotices(
  source: string,
  operations: NdfOperation[],
): Promise<{ output: string; notices: PatchNotice[] }> {
  const target: PatchTarget = { file, operations };
  const notices: PatchNotice[] = [];
  const output = await applyPatchTarget(source, target, application, absolutePath, {
    onNotice: (notice) => notices.push(notice),
  });
  return { output, notices };
}

const units = `export Descriptor_Unit_A is TEntityDescriptor
(
    FrontArmor = 5
    Availability = 2
)

export Descriptor_Unit_B is TEntityDescriptor
(
    FrontArmor = 5
    Availability = 1
)
`;

describe('operations that change nothing', () => {
  test('writing the value a field already holds reports it instead of failing', async () => {
    const { output, notices } = await applyCollectingNotices(units, [
      {
        op: 'modify',
        selector: { kind: 'field', by: 'path', value: 'Descriptor_Unit_A.FrontArmor' },
        value: 5,
      },
    ]);

    expect(output).toBe(units);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.reason).toContain('`Descriptor_Unit_A.FrontArmor` is already `5`');
    expect(notices[0]?.patchId).toBe('balance.armor');
    expect(notices[0]?.operationIndex).toBe(0);
  });

  test('an object modify reports only the fields that were already set', async () => {
    const { output, notices } = await applyCollectingNotices(units, [
      {
        op: 'modify',
        selector: { kind: 'object', by: 'name', value: 'Descriptor_Unit_A' },
        changes: { FrontArmor: 5, Availability: 4 },
      },
    ]);

    expect(output).toContain('Availability = 4');
    expect(notices.map((notice) => notice.reason)).toEqual([
      '`Descriptor_Unit_A.FrontArmor` is already `5`, so this operation changed nothing.',
    ]);
  });

  /** Reading it as part of the value hid redundant writes and deleted the note on rewrite. */
  describe('a value with a comment after it', () => {
    const commented = `export Descriptor_Unit_A is TEntityDescriptor
(
    FrontArmor = 5 // vanilla value, do not change
)
`;

    test('writing the value it already holds is reported, not rewritten', async () => {
      const { output, notices } = await applyCollectingNotices(commented, [
        {
          op: 'modify',
          selector: { kind: 'field', by: 'path', value: 'Descriptor_Unit_A.FrontArmor' },
          value: 5,
        },
      ]);

      expect(output).toBe(commented);
      expect(notices[0]?.reason).toContain('`Descriptor_Unit_A.FrontArmor` is already `5`');
    });

    test('the object form sees it the same way', async () => {
      const { output, notices } = await applyCollectingNotices(commented, [
        {
          op: 'modify',
          selector: { kind: 'object', by: 'name', value: 'Descriptor_Unit_A' },
          changes: { FrontArmor: 5 },
        },
      ]);

      expect(output).toBe(commented);
      expect(notices).toHaveLength(1);
    });

    test('a real change keeps the comment', async () => {
      const { output } = await applyCollectingNotices(commented, [
        {
          op: 'modify',
          selector: { kind: 'field', by: 'path', value: 'Descriptor_Unit_A.FrontArmor' },
          value: 9,
        },
      ]);

      expect(output).toContain('FrontArmor = 9 // vanilla value, do not change');
    });

    test('a comment inside a multi-line value is part of the value, not trailing it', async () => {
      const nested = `export Descriptor_Unit_A is TEntityDescriptor
(
    Stats = TArmorStats
    (
        // front facing
        Front = 5
    )
)
`;
      const { output, notices } = await applyCollectingNotices(nested, [
        {
          op: 'modify',
          selector: { kind: 'field', by: 'path', value: 'Descriptor_Unit_A.Stats.Front' },
          value: 5,
        },
      ]);

      expect(output).toBe(nested);
      expect(notices).toHaveLength(1);
    });
  });

  test('a field that does change reports nothing', async () => {
    const { output, notices } = await applyCollectingNotices(units, [
      {
        op: 'modify',
        selector: { kind: 'field', by: 'path', value: 'Descriptor_Unit_A.FrontArmor' },
        value: 9,
      },
    ]);

    expect(output).toContain('FrontArmor = 9');
    expect(notices).toEqual([]);
  });
});

describe('operations whose target is already gone', () => {
  test('removing an object that is not there reports it instead of failing', async () => {
    const { output, notices } = await applyCollectingNotices(units, [
      {
        op: 'remove',
        selector: { kind: 'object', by: 'name', value: 'Descriptor_Unit_Retired' },
      },
    ]);

    expect(output).toBe(units);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.reason).toBe(
      'Object `Descriptor_Unit_Retired` was not found. There was nothing to remove.',
    );
  });

  test('removing a field that is not there reports it', async () => {
    const { output, notices } = await applyCollectingNotices(units, [
      {
        op: 'remove',
        selector: { kind: 'field', by: 'path', value: 'Descriptor_Unit_A.Retired' },
      },
    ]);

    expect(output).toBe(units);
    expect(notices[0]?.reason).toBe(
      'Field `Descriptor_Unit_A.Retired` was not found. There was nothing to remove.',
    );
  });

  test('removing through a block that is not there reports it', async () => {
    const { notices } = await applyCollectingNotices(units, [
      {
        op: 'remove',
        selector: { kind: 'field', by: 'path', value: 'Descriptor_Unit_Retired.FrontArmor' },
      },
    ]);

    expect(notices[0]?.reason).toContain(
      'Top-level block `Descriptor_Unit_Retired` was not found.',
    );
  });

  test('a selector that cannot say which one it means still fails', async () => {
    // Ambiguity is a mistake in the patch, not the game already agreeing with it,
    // so `remove` must not swallow it the way it swallows "not there".
    await expectYmbError(
      () =>
        applyCollectingNotices(units, [
          {
            op: 'remove',
            selector: { kind: 'object', by: 'match', where: { FrontArmor: 5 } },
          },
        ]),
      'SelectorError',
      'matched multiple objects',
    );
  });

  test('a modify whose target is gone still fails', async () => {
    await expectYmbError(
      () =>
        applyCollectingNotices(units, [
          {
            op: 'modify',
            selector: { kind: 'field', by: 'path', value: 'Descriptor_Unit_Retired.FrontArmor' },
            value: 9,
          },
        ]),
      'SelectorError',
      'Top-level block `Descriptor_Unit_Retired` was not found.',
    );
  });
});

describe('operations whose result is already in the file', () => {
  const added = `export Descriptor_Unit_New is TEntityDescriptor
(
    FrontArmor = 4
)`;

  test('adding a block the file already holds, unchanged, reports it', async () => {
    const source = `${units}\n${added}\n`;
    const { output, notices } = await applyCollectingNotices(source, [
      { op: 'add', value: { $raw: added } },
    ]);

    expect(output).toBe(source);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.reason).toBe(
      'Block `Descriptor_Unit_New` is already in this file, so this operation added nothing.',
    );
  });

  test('adding a block whose name is taken by something else still fails', async () => {
    const source = `${units}\nexport Descriptor_Unit_New is TEntityDescriptor\n(\n    FrontArmor = 99\n)\n`;

    await expectYmbError(
      () => applyCollectingNotices(source, [{ op: 'add', value: { $raw: added } }]),
      'ConflictError',
      'Top-level block `Descriptor_Unit_New` already exists in this file.',
    );
  });

  /** A field or a string that merely reads like a declaration is not a duplicate. */
  test('adding a block is not blocked by the same name used somewhere else', async () => {
    const sources = [
      // A field of that name inside another object.
      `export Descriptor_Unit_A is TEntityDescriptor\n(\n    Descriptor_Unit_New = 1\n)\n`,
      // A nested declaration written flush against the margin.
      `export Descriptor_Unit_A is TEntityDescriptor\n(\n    Items =\n    [\nDescriptor_Unit_New is TFoo( X = 1 ),\n    ]\n)\n`,
      // Only ever mentioned inside a string.
      `export Descriptor_Unit_A is TEntityDescriptor\n(\n    Note = "\nDescriptor_Unit_New is 10\n"\n)\n`,
    ];

    for (const source of sources) {
      const { output, notices } = await applyCollectingNotices(source, [
        { op: 'add', value: { $raw: added } },
      ]);

      expect(notices).toEqual([]);
      expect(output).toContain('export Descriptor_Unit_New is TEntityDescriptor');
      expect(output.startsWith(source.trimEnd())).toBe(true);
    }
  });

  /** Counting only positionally indexed blocks let an `add` write a second declaration. */
  describe('a name a template already declares', () => {
    const addedTemplate = `template Sample_Shape [ Size = 1 ] is TShape
(
    Width = 3
)`;

    test('adding a template the file already holds, unchanged, reports it', async () => {
      const source = `${units}\n${addedTemplate}\n`;
      const { output, notices } = await applyCollectingNotices(source, [
        { op: 'add', value: { $raw: addedTemplate } },
      ]);

      expect(output).toBe(source);
      expect(notices[0]?.reason).toBe(
        'Block `Sample_Shape` is already in this file, so this operation added nothing.',
      );
    });

    test('adding a template whose name is taken by something else fails', async () => {
      const source = `${units}\ntemplate Sample_Shape [ Size = 1 ] is TShape\n(\n    Width = 99\n)\n`;

      await expectYmbError(
        () => applyCollectingNotices(source, [{ op: 'add', value: { $raw: addedTemplate } }]),
        'ConflictError',
        'Top-level block `Sample_Shape` already exists in this file.',
      );
    });

    test('adding an ordinary block whose name a template already holds fails', async () => {
      const source = `${units}\ntemplate Descriptor_Unit_New [ Size = 1 ] is TShape\n(\n    Width = 3\n)\n`;

      await expectYmbError(
        () => applyCollectingNotices(source, [{ op: 'add', value: { $raw: added } }]),
        'ConflictError',
        'Top-level block `Descriptor_Unit_New` already exists in this file.',
      );
    });
  });

  test('copying onto a destination that already holds that copy reports it', async () => {
    const source = `export Descriptor_Unit_A is TEntityDescriptor
(
    FrontArmor = 5
)

export Descriptor_Unit_Clone is TEntityDescriptor
(
    FrontArmor = 5
)
`;
    const { output, notices } = await applyCollectingNotices(source, [
      {
        op: 'copy',
        selector: { kind: 'object', by: 'name', value: 'Descriptor_Unit_A' },
        destination: { name: 'Descriptor_Unit_Clone' },
      },
    ]);

    expect(output).toBe(source);
    expect(notices[0]?.reason).toBe(
      'Copy destination `Descriptor_Unit_Clone` is already in this file, so this operation added nothing.',
    );
  });

  test('adding a collection entry that is already there reports it', async () => {
    const source = `export Descriptor_Unit_A is TEntityDescriptor
(
    ModulesDescriptors =
    [
        ~/Module_A,
    ]
)
`;
    const { output, notices } = await applyCollectingNotices(source, [
      {
        op: 'add',
        selector: {
          kind: 'collection',
          by: 'path',
          value: 'Descriptor_Unit_A.ModulesDescriptors',
        },
        value: { $raw: '~/Module_A,' },
      },
    ]);

    expect(output).toBe(source);
    expect(notices[0]?.reason).toBe(
      'Collection entry `~/Module_A,` is already in this file, so this operation added nothing.',
    );
  });
});

function bulkEditingBothUnits(edits: BulkOperation['edits']): BulkOperation {
  return {
    op: 'bulk',
    match: {
      mode: 'all',
      conditions: [{ on: 'name', is: 'startsWith', value: ['Descriptor_Unit_'] }],
    },
    edits,
    expect: { minBlocks: 2 },
  };
}

describe('bulk expectations met by values that were already set', () => {
  test('values already at the new value count towards `minChanges` and warn', async () => {
    const { output, notices } = await applyCollectingNotices(units, [
      bulkEditingBothUnits([{ field: 'FrontArmor', set: 5, minChanges: 2 }]),
    ]);

    expect(output).toBe(units);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.reason).toBe(
      'Bulk edit 0 changed 0 value(s), under `minChanges: 2`, because 2 target(s) already held the new value.',
    );
  });

  test('a factor of one is an unchanged value, not an untouched one', async () => {
    const { notices } = await applyCollectingNotices(units, [
      bulkEditingBothUnits([{ field: 'FrontArmor', multiply: 1, minChanges: 2 }]),
    ]);

    expect(notices[0]?.reason).toContain('2 target(s) already held the new value');
  });

  test('an expectation still fails when nothing reached the target at all', async () => {
    await expectYmbError(
      () =>
        applyCollectingNotices(units, [
          bulkEditingBothUnits([{ field: 'MissingField', set: 5, minChanges: 1 }]),
        ]),
      'SelectorError',
      'changed 0 value(s)',
    );
  });

  test('an expectation the already-set values cannot cover still fails, and says how many they were', async () => {
    const error = await expectYmbError(
      () =>
        applyCollectingNotices(units, [
          bulkEditingBothUnits([{ field: 'Availability', set: 2, minChanges: 3 }]),
        ]),
      'SelectorError',
      'changed 1 value(s)',
    );

    expect(error.context.details).toContain('1 target(s) already held the new value.');
  });

  test('an edit under `minChanges` for a list entry that is already there warns', async () => {
    const withModules = `export Descriptor_Unit_A is TEntityDescriptor
(
    ModulesDescriptors =
    [
        ~/Module_A,
    ]
)
`;
    const { output, notices } = await applyCollectingNotices(withModules, [
      {
        op: 'bulk',
        match: {
          mode: 'all',
          conditions: [{ on: 'name', is: 'startsWith', value: ['Descriptor_Unit_'] }],
        },
        edits: [
          {
            list: 'ModulesDescriptors',
            insert: { value: { $raw: '~/Module_A' }, position: 'end' },
            minChanges: 1,
          },
        ],
        expect: { minBlocks: 1 },
      },
    ]);

    expect(output).toBe(withModules);
    expect(notices[0]?.reason).toContain('1 target(s) already held the new value');
  });
});

/** `minChanges` is optional, so an edit written without one could do nothing indefinitely. */
describe('edits that change nothing without a `minChanges` to fail', () => {
  test('an edit whose target no matched block has is reported', async () => {
    const { output, notices } = await applyCollectingNotices(units, [
      bulkEditingBothUnits([{ field: 'RearArmor', set: 3 }]),
    ]);

    expect(output).toBe(units);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.reason).toBe(
      'Bulk edit 0 changed nothing, because none of the 2 matched block(s) have `field: RearArmor`.',
    );
    expect(notices[0]?.suggestion).toContain('Check the target name against the file');
  });

  test('an edit every block already satisfies is reported as redundant, not as missing', async () => {
    const { output, notices } = await applyCollectingNotices(units, [
      bulkEditingBothUnits([{ field: 'FrontArmor', set: 5 }]),
    ]);

    expect(output).toBe(units);
    expect(notices[0]?.reason).toBe(
      'Bulk edit 0 (field: FrontArmor) changed nothing: all 2 target(s) across 2 matched block(s) already hold this value.',
    );
    expect(notices[0]?.suggestion).toContain('Drop the edit if the game data already says this');
  });

  test('an edit that changed something says nothing', async () => {
    const { notices } = await applyCollectingNotices(units, [
      bulkEditingBothUnits([{ field: 'FrontArmor', set: 9 }]),
    ]);

    expect(notices).toEqual([]);
  });

  test('only the edit that did nothing is named, not the one beside it', async () => {
    const { notices } = await applyCollectingNotices(units, [
      bulkEditingBothUnits([
        { field: 'FrontArmor', set: 9 },
        { field: 'RearArmor', set: 3 },
      ]),
    ]);

    expect(notices).toHaveLength(1);
    expect(notices[0]?.reason).toContain('Bulk edit 1');
  });
});

describe('a target whose operations all leave the file alone', () => {
  test('a `forEach` that expanded to no operations at all is reported', async () => {
    // Nothing ran, so no operation is there to explain itself: the authored
    // `forEach` had an empty list and the whole target quietly does nothing.
    const { output, notices } = await applyCollectingNotices(units, []);

    expect(output).toBe(units);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.reason).toContain('left the file exactly as it was');
  });

  test('a target an operation already explained is not reported twice', async () => {
    const { notices } = await applyCollectingNotices(units, [
      bulkEditingBothUnits([{ field: 'FrontArmor', set: 5 }]),
    ]);

    expect(notices).toHaveLength(1);
    expect(notices[0]?.reason).not.toContain('left the file exactly as it was');
  });

  test('a target that changed something is not reported', async () => {
    const { notices } = await applyCollectingNotices(units, [
      bulkEditingBothUnits([{ field: 'FrontArmor', set: 9 }]),
    ]);

    expect(notices).toEqual([]);
  });
});

/** One literal that reaches nothing stays invisible behind neighbours that match. */
describe('match values that reach no block', () => {
  function bulkMatchingNames(
    value: string[],
    overrides: Partial<BulkOperation> = {},
  ): BulkOperation {
    return {
      op: 'bulk',
      match: { mode: 'all', conditions: [{ on: 'name', is: 'startsWith', value }] },
      edits: [{ field: 'FrontArmor', set: 9 }],
      expect: { minBlocks: 1 },
      ...overrides,
    };
  }

  test('a value nothing matches is named even when the operation still matched enough', async () => {
    const { output, notices } = await applyCollectingNotices(units, [
      bulkMatchingNames(['Descriptor_Unit_A', 'Descriptor_Unit_Typo']),
    ]);

    expect(output).toContain('FrontArmor = 9');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.reason).toBe(
      'Bulk match value `name startsWith Descriptor_Unit_Typo` matched no block in this file, so it reaches nothing.',
    );
  });

  test('values that all match report nothing', async () => {
    const { notices } = await applyCollectingNotices(units, [
      bulkMatchingNames(['Descriptor_Unit_A', 'Descriptor_Unit_B']),
    ]);

    expect(notices).toEqual([]);
  });

  test('several missed values are collected into one line, naming their condition', async () => {
    const { notices } = await applyCollectingNotices(units, [
      bulkMatchingNames(['Descriptor_Unit_A'], {
        match: {
          mode: 'any',
          conditions: [
            { on: 'name', is: 'startsWith', value: ['Descriptor_Unit_A', 'Descriptor_Unit_Gone'] },
            { on: 'type', is: 'contains', value: ['TMissingDescriptor'] },
          ],
        },
      }),
    ]);

    expect(notices[0]?.reason).toBe(
      'Bulk match values `name startsWith Descriptor_Unit_Gone`, `type contains TMissingDescriptor` matched no block in this file, so they reach nothing.',
    );
  });

  test('a `notContains` value nothing holds is the case it was written for, not a miss', async () => {
    const { notices } = await applyCollectingNotices(units, [
      bulkMatchingNames(['Descriptor_Unit_'], {
        match: {
          mode: 'all',
          conditions: [
            { on: 'name', is: 'startsWith', value: ['Descriptor_Unit_'] },
            { on: 'text', is: 'notContains', value: ['TDeploymentShiftModule'] },
          ],
        },
      }),
    ]);

    expect(notices).toEqual([]);
  });

  test('`expect.minBlocks: 0` opts a pass out, for a block another mod may contribute', async () => {
    const { notices } = await applyCollectingNotices(units, [
      bulkMatchingNames(['Descriptor_Unit_FromAnotherMod'], { expect: { minBlocks: 0 } }),
    ]);

    expect(notices).toEqual([]);
  });

  test('a condition every value misses is reported rather than only counted', async () => {
    // `mode: any` keeps the operation alive on its other condition, so nothing
    // else in the run would mention this one.
    const { notices } = await applyCollectingNotices(units, [
      bulkMatchingNames(['Descriptor_Unit_A'], {
        match: {
          mode: 'any',
          conditions: [
            { on: 'name', is: 'endsWith', value: ['_A'] },
            { on: 'name', is: 'contains', value: ['_Gone_', '_Also_Gone_'] },
          ],
        },
      }),
    ]);

    expect(notices[0]?.reason).toContain('`name contains _Gone_`, `name contains _Also_Gone_`');
  });
});

describe('reporting notices', () => {
  const notice: PatchNotice = {
    absolutePath: 'GameData/Generated/Gameplay/Units.ndf',
    modId: 'sample_pack',
    modName: 'Sample Pack',
    patchId: 'balance.armor',
    operationIndex: 1,
    reason: '`Descriptor_Unit_A.FrontArmor` is already `5`, so this operation changed nothing.',
    suggestion: 'Delete the operation if it is finished, or set the value you actually want.',
  };

  const locatedNotice: PatchNotice = {
    ...notice,
    patchConfigPath: 'C:/mods/sample-pack/config/patch/armor/ymb.patch.yaml',
    operationLine: 42,
  };

  test('the origin names the patch file and line the operation was written on', () => {
    expect(toPatchReportFinding(locatedNotice, 'C:/mods').origin).toBe(
      'sample-pack/config/patch/armor/ymb.patch.yaml:42',
    );
  });

  test('an operation with no known line falls back to the ordinal', () => {
    expect(toPatchReportFinding(notice).origin).toBe('operation #2');
  });

  test('the same operation reported twice is listed once', () => {
    expect(dedupePatchNotices([notice, { ...notice }])).toEqual([notice]);
    expect(dedupePatchNotices([notice, { ...notice, operationIndex: 2 }])).toHaveLength(2);
  });
});

/** Thirty-six operations sharing one fix is one thing to read, not thirty-six. */
describe('grouping notices for the report', () => {
  const baseNotice: PatchNotice = {
    absolutePath: 'GameData/Generated/Gameplay/Units.ndf',
    modId: 'sample_pack',
    modName: 'Sample Pack',
    patchId: 'balance.armor',
    operationIndex: 0,
    patchConfigPath: 'C:/mods/sample-pack/config/patch/armor/ymb.patch.yaml',
    operationLine: 12,
    reason: '`Descriptor_Unit_A.FrontArmor` is already `5`, so this operation changed nothing.',
    suggestion: 'Delete the operation if it is finished, or set the value you actually want.',
  };

  test('states a shared fix once and lists each occurrence under it', () => {
    const lines = formatFindingGroups(
      [
        baseNotice,
        { ...baseNotice, operationIndex: 1, operationLine: 20, reason: '`B` is already `1`.' },
        {
          ...baseNotice,
          operationIndex: 2,
          operationLine: 30,
          reason: '`C` was not found.',
          suggestion: 'Fix the selector.',
        },
      ].map((notice) => toPatchReportFinding(notice, 'C:/mods')),
    );

    // Largest group first. Its two members found different things, so the fix is
    // stated once and each line carries its own sentence, ordered by config line.
    expect(lines).toEqual([
      'warning  2 patch operations: Delete the operation if it is finished, or set the value you actually want.',
      '           balance.armor  sample-pack/config/patch/armor/ymb.patch.yaml:12  `Descriptor_Unit_A.FrontArmor` is already `5`, so this operation changed nothing.',
      '           balance.armor  sample-pack/config/patch/armor/ymb.patch.yaml:20  `B` is already `1`.',
      // A group of one has nothing to repeat, so what it found joins the header.
      'warning  1 patch operation: `C` was not found. Fix the selector.',
      '           balance.armor  sample-pack/config/patch/armor/ymb.patch.yaml:30',
    ]);
  });

  test('folds a detail every member shares into the header instead of repeating it', () => {
    const shared = {
      severity: 'warning' as const,
      label: 'marker sync target',
      detail: 'Exact inline markers were skipped because this target exceeded the diff budget.',
      suggestion: 'Raise the `marker` limits under `settings` to get the inline ones back.',
    };
    const lines = formatFindingGroups([
      { ...shared, subject: 'GameData/Generated/Gameplay/Decks/DeckPacks.ndf' },
      { ...shared, subject: 'GameData/Generated/Gameplay/Decks/DeckSerializer.ndf' },
      { ...shared, subject: 'GameData/Generated/Gameplay/Decks/DivisionRules.ndf' },
    ]);

    expect(lines[0]).toBe(`warning  3 marker sync targets: ${shared.detail} ${shared.suggestion}`);
    // Only the paths below it: everything else was the same for all three.
    expect(lines.slice(1)).toEqual([
      '           GameData/Generated/Gameplay/Decks/DeckPacks.ndf',
      '           GameData/Generated/Gameplay/Decks/DeckSerializer.ndf',
      '           GameData/Generated/Gameplay/Decks/DivisionRules.ndf',
    ]);
  });

  /** 47 outputs share one fix but split across three reasons; folding only on full agreement repeated the commonest sentence per file. */
  test('states a detail most members share once, and inlines the odd one out', () => {
    const marker = {
      severity: 'note' as const,
      label: 'marker preview target',
      suggestion: 'Preview output will not show in-file ownership markers for this file.',
    };
    const binary = 'Binary output; YMB cannot embed in-file comment markers.';

    const lines = formatFindingGroups([
      { ...marker, subject: 'icons/b.png', detail: binary },
      { ...marker, subject: 'text.csv', detail: 'This file type does not support markers.' },
      { ...marker, subject: 'icons/a.png', detail: binary },
      { ...marker, subject: 'icons/c.png', detail: binary },
    ]);

    expect(lines).toEqual([
      'note     4 marker preview targets: Preview output will not show in-file ownership markers for this file.',
      `           3x ${binary}`,
      '             icons/a.png',
      '             icons/b.png',
      '             icons/c.png',
      '           text.csv  This file type does not support markers.',
    ]);
  });

  test('orders members by line number rather than by digit', () => {
    const finding = {
      severity: 'warning' as const,
      label: 'patch operation',
      subject: 'pack.armor',
      suggestion: 'Delete the operation if it is finished.',
    };
    const lines = formatFindingGroups([
      { ...finding, origin: 'ymb.patch.yaml:12', detail: 'twelve' },
      { ...finding, origin: 'ymb.patch.yaml:9', detail: 'nine' },
      { ...finding, origin: 'ymb.patch.yaml:100', detail: 'hundred' },
    ]);

    expect(lines.slice(1).map((line: string) => line.trim().split('  ')[1])).toEqual([
      'ymb.patch.yaml:9',
      'ymb.patch.yaml:12',
      'ymb.patch.yaml:100',
    ]);
  });

  test('says nothing when there is nothing to report', () => {
    expect(formatFindingGroups([])).toEqual([]);
  });
});
