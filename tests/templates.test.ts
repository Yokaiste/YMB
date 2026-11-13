import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { createDefaultBuilderProjectConfig } from '../src/builder-config.ts';
import { createTemplateVariables, resolveTemplateValue } from '../src/templates.ts';
import type { BuilderContext } from '../src/types.ts';

const planeSlotExpression = ['${', 'planeCap', '}'].join('');
const planeSlotLabelExpression = ['Planes: ${', 'planeCap', '}'].join('');
const planeCapExpression = ['${', 'planeCap', '}'].join('');
const missingVariableExpression = ['${', 'deckSlotCount * missingValue', '}'].join('');
const nameExpression = ['${', 'name', '}'].join('');
const prefixedNameExpression = ['prefix-${', 'name', '}'].join('');
const missingExpression = ['${', 'missing', '}'].join('');
const prefixedMissingExpression = ['prefix-${', 'missing', '}'].join('');
const slotTextExpression = ['${', 'slotText', '}'].join('');
const circularExpression = ['${', 'loopA', '}'].join('');
const offmapGridExpression = [
  '${',
  `join(cartesian(planeCap / 3, 3, "( [{left}, {right}], ~/DummyOffMapPanel )"), ",\\n")`,
  '}',
].join('');
const offmapGridBlockExpression = [
  'GridElements = MAP\n[\n${',
  `join(cartesian(planeCap / 3, 3, "( [{left}, {right}], ~/DummyOffMapPanel )"), ",\\n")`,
  '}\n]',
].join('');

describe('template resolution', () => {
  test('resolves sibling members, computed indexes, aliases, and helper inputs without parent cycles', () => {
    const variables = {
      settings: {
        base: [3, 5, 7],
        copy: '${settings.base}',
        double: '${settings.base[1] * 2}',
        total: '${sum(settings.copy)}',
        rows: [{ size: 4 }, { size: '${settings.rows[0].size + 2}' }],
      },
      alias: '${settings}',
      selected: 'copy',
    };
    const expected = {
      base: [3, 5, 7],
      copy: [3, 5, 7],
      double: 10,
      total: 15,
      rows: [{ size: 4 }, { size: 6 }],
    };
    expect(resolveTemplateValue('${settings}', variables)).toEqual(expected);
    expect(resolveTemplateValue('${alias[selected]}', variables)).toEqual([3, 5, 7]);
    expect(resolveTemplateValue('${pluck(settings.rows, "size")}', variables)).toEqual([4, 6]);
    expect(resolveTemplateValue('value=${settings.copy}', variables)).toBe('value=[3,5,7]');
    expect(structuredClone(resolveTemplateValue('${settings}', variables))).toEqual(expected);
    expect(variables.settings.copy).toBe('${settings.base}');
  });

  test('rejects real nested cycles and inaccessible members', () => {
    for (const settings of [
      { a: '${settings.a}' },
      { a: '${settings.b}', b: '${settings.a}' },
      { a: '${settings}' },
      { a: ['${settings.a}'] },
      { a: 'value=${settings}' },
    ]) {
      expect(() => resolveTemplateValue('${settings}', { settings })).toThrow(
        /Circular template variable/,
      );
    }
    expect(() => resolveTemplateValue('${settings.missing}', { settings: { a: 1 } })).toThrow(
      /no property/,
    );
    expect(() => resolveTemplateValue('${settings.toString}', { settings: {} })).toThrow(
      /no property/,
    );
    expect(() => resolveTemplateValue('${settings[2]}', { settings: [1] })).toThrow(/out of range/);
  });

  test('extracts fields from records without pairing separate lists', () => {
    const rows = [
      { rate: 0, label: 'none' },
      { rate: 3, label: 'more' },
    ];
    expect(resolveTemplateValue("${pluck(rows, 'rate')}", { rows })).toEqual([0, 3]);
    expect(resolveTemplateValue("${join(pluck(rows, 'label'), ', ')}", { rows })).toBe(
      'none, more',
    );
    expect(resolveTemplateValue("${pluck(rows, 'rate')}", { rows: [] })).toEqual([]);
    for (const invalid of [[{}], [null], [[1]], [Object.create({ rate: 1 })]]) {
      expect(() => resolveTemplateValue("${pluck(rows, 'rate')}", { rows: invalid })).toThrow();
    }
  });
  test('keeps simple variable substitution behavior', () => {
    expect(resolveTemplateValue(nameExpression, { name: 'SAMPLE' })).toBe('SAMPLE');
    expect(resolveTemplateValue(prefixedNameExpression, { name: 'SAMPLE' })).toBe('prefix-SAMPLE');
  });

  test('refuses an unknown variable in either spelling', () => {
    // A bare `${missing}` used to substitute empty text while the same typo
    // inside an expression was refused, so a mistyped name wrote an empty value
    // and the build still passed.
    expect(() => resolveTemplateValue(missingExpression, {})).toThrow();
    expect(() => resolveTemplateValue(prefixedMissingExpression, {})).toThrow();
    expect(() => resolveTemplateValue(missingVariableExpression, { deckSlotCount: 80 })).toThrow();
  });

  test('reads a variable named after an expression keyword rather than the literal', () => {
    // A bare name is resolved as a variable, so these never reach the grammar
    // that reserves them.
    expect(resolveTemplateValue(['${', 'null', '}'].join(''), { null: 7 })).toBe(7);
    expect(resolveTemplateValue(['${', 'true', '}'].join(''), { true: 'yes' })).toBe('yes');
  });

  test('evaluates arithmetic expressions with exact-value typing', () => {
    expect(
      resolveTemplateValue(planeSlotExpression, {
        planeCap: 99,
      }),
    ).toBe(99);
    expect(
      resolveTemplateValue(planeSlotLabelExpression, {
        planeCap: 99,
      }),
    ).toBe('Planes: 99');
  });

  test('resolves helper expressions through other variables', () => {
    expect(
      resolveTemplateValue(slotTextExpression, {
        deckSlotCount: 5,
        slotText: "${join(range(1, deckSlotCount + 1), ', ')}",
      }),
    ).toBe('1, 2, 3, 4, 5');
    expect(
      resolveTemplateValue(planeCapExpression, {
        planeCap: 99,
      }),
    ).toBe(99);
  });

  test('renders cartesian grid helpers through template substitution', () => {
    expect(
      resolveTemplateValue(offmapGridExpression, {
        planeCap: 6,
      }),
    ).toBe(
      [
        '( [0, 0], ~/DummyOffMapPanel ),',
        '( [0, 1], ~/DummyOffMapPanel ),',
        '( [0, 2], ~/DummyOffMapPanel ),',
        '( [1, 0], ~/DummyOffMapPanel ),',
        '( [1, 1], ~/DummyOffMapPanel ),',
        '( [1, 2], ~/DummyOffMapPanel )',
      ].join('\n'),
    );
  });

  test('renders cartesian helper output inside larger template strings', () => {
    expect(
      resolveTemplateValue(offmapGridBlockExpression, {
        planeCap: 6,
      }),
    ).toBe(
      [
        'GridElements = MAP',
        '[',
        '( [0, 0], ~/DummyOffMapPanel ),',
        '( [0, 1], ~/DummyOffMapPanel ),',
        '( [0, 2], ~/DummyOffMapPanel ),',
        '( [1, 0], ~/DummyOffMapPanel ),',
        '( [1, 1], ~/DummyOffMapPanel ),',
        '( [1, 2], ~/DummyOffMapPanel )',
        ']',
      ].join('\n'),
    );
  });

  test('resolves arrays, objects, indexing, and conditional expressions recursively', () => {
    expect(
      resolveTemplateValue(
        {
          summary: '${stats.frontArmor + stats.bonuses[1]}',
          label: "Armor ${stats.frontArmor >= 6 ? stats.tags[0] : 'Reserve'}",
          slots: '${concat(range(0, 2), repeat(9, 2))}',
          totals: {
            count: '${len(stats.tags)}',
            score: '${sum(stats.bonuses)}',
          },
        },
        {
          stats: {
            frontArmor: 6,
            bonuses: [2, 4],
            tags: ['Elite', 'Shock'],
          },
        },
      ),
    ).toEqual({
      summary: 10,
      label: 'Armor Elite',
      slots: [0, 1, 9, 9],
      totals: {
        count: 2,
        score: 6,
      },
    });
  });

  test('does not expose inherited object properties as variables', () => {
    const inheritedSimpleExpression = ['${', 'toString', '}'].join('');
    const inheritedCompoundExpression = ['${', 'constructor + 1', '}'].join('');
    const ownVariables = Object.fromEntries([
      ['toString', 'owned'],
      ['constructor', 4],
    ]);

    expect(() => resolveTemplateValue(inheritedSimpleExpression, {})).toThrow();
    expect(() => resolveTemplateValue(inheritedCompoundExpression, {})).toThrow();
    expect(resolveTemplateValue(inheritedSimpleExpression, ownVariables)).toBe('owned');
    expect(resolveTemplateValue(inheritedCompoundExpression, ownVariables)).toBe(5);
  });

  test('throws on circular simple variable references', () => {
    expect(() =>
      resolveTemplateValue(circularExpression, {
        loopA: '${loopB}',
        loopB: '${loopA}',
      }),
    ).toThrow();
  });

  test('throws on unterminated template expressions', () => {
    expect(() => resolveTemplateValue('prefix-${name', { name: 'SAMPLE' })).toThrow();
  });

  test('creates built-in template variables and applies patch precedence', () => {
    const builderConfig = createDefaultBuilderProjectConfig();
    builderConfig.mods = {
      sample_pack: {
        patches: { 'balance.armor': { variables: { tuning: { base: 9 } } } },
      },
    };
    const context: BuilderContext = {
      ymbRoot: 'D:\\Mods\\InstalledMod\\YMB',
      builderConfigPath: 'D:\\Mods\\InstalledMod\\YMB\\ymb.config.yaml',
      builderConfig,
      modRoot: 'D:\\Mods\\InstalledMod',
      modsRoot: 'D:\\Mods\\InstalledMod\\YMB\\mods',
      gameDataRoot: 'D:\\Mods\\InstalledMod\\GameData',
      commonDataRoot: 'D:\\Mods\\InstalledMod\\CommonData',
      buildRoot: 'D:\\Mods\\InstalledMod\\YMB\\.ymb-build',
      buildOutputRoot: 'D:\\Mods\\InstalledMod\\YMB\\.ymb-build\\output',
      buildCacheRoot: 'D:\\Mods\\InstalledMod\\YMB\\.ymb-build\\cache',
      conflictPreviewRoot: 'D:\\Mods\\InstalledMod\\YMB\\.ymb-build\\conflicts',
      stateRoot: 'D:\\Mods\\InstalledMod\\YMB\\.ymb-state',
      operationLockRoot: 'D:\\Mods\\InstalledMod\\YMB\\.ymb-operation-lock',
      stateTransactionRoot: 'D:\\Mods\\InstalledMod\\YMB\\.ymb-state-transaction',
    };

    const variables = createTemplateVariables(
      context,
      {
        config: {
          id: 'sample_pack',
          name: 'Sample Pack',
          description: 'Source mod description',
          dependsOn: [],
          priority: 0,
          allowWriteToModifiedFiles: false,
          enabled: true,
          scripts: [],
          tempPaths: [],
          version: 1,
          variables: {
            sharedValue: 'mod',
          },
        },
      },
      {
        config: {
          id: 'balance.armor',
          name: 'Armor Tweaks',
          description: 'Patch description',
          enabled: true,
          scope: 'prod',
          dependsOn: [],
          files: [],
          targets: [],
          optional: false,
          scripts: [],
          tempPaths: [],
          version: 1,
          variables: {
            sharedValue: 'patch',
            tuning: { base: 2, doubled: '${tuning.base * 2}', independent: 5 },
          },
        },
      },
    );

    expect(variables.modRootName).toBe(path.basename(context.modRoot));
    expect(variables.modId).toBe('sample_pack');
    expect(variables.modName).toBe('Sample Pack');
    expect(variables.patchId).toBe('balance.armor');
    expect(variables.patchName).toBe('Armor Tweaks');
    expect(variables.sharedValue).toBe('patch');
    expect(variables.tuning).toEqual({ base: 9, doubled: 18, independent: 5 });
  });
});
