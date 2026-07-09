import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { createTemplateVariables, resolveTemplateValue } from '../src/templates.ts';
import type { BuilderContext } from '../src/types.ts';

const planeSlotExpression = ['${', 'planeCap', '}'].join('');
const planeSlotLabelExpression = ['Planes: ${', 'planeCap', '}'].join('');
const planeCapExpression = ['${', 'planeCap', '}'].join('');
const missingVariableExpression = ['${', 'deckSlotCount * missingValue', '}'].join('');
const nameExpression = ['${', 'name', '}'].join('');
const prefixedNameExpression = ['prefix-${', 'name', '}'].join('');
const missingExpression = ['${', 'missing', '}'].join('');
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
  test('keeps simple variable substitution behavior', () => {
    expect(resolveTemplateValue(nameExpression, { name: 'YSM' })).toBe('YSM');
    expect(resolveTemplateValue(prefixedNameExpression, { name: 'YSM' })).toBe('prefix-YSM');
    expect(resolveTemplateValue(missingExpression, {})).toBe('');
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

  test('throws on unknown expression variables', () => {
    expect(() => resolveTemplateValue(missingVariableExpression, { deckSlotCount: 80 })).toThrow(
      'Unknown template variable "missingValue"',
    );
  });

  test('throws on circular simple variable references', () => {
    expect(() =>
      resolveTemplateValue(circularExpression, {
        loopA: '${loopB}',
        loopB: '${loopA}',
      }),
    ).toThrow('Circular template variable reference involving "loopA"');
  });

  test('throws on unterminated template expressions', () => {
    expect(() => resolveTemplateValue('prefix-${name', { name: 'YSM' })).toThrow(
      'Unterminated template expression',
    );
  });

  test('creates built-in template variables and applies patch precedence', () => {
    const context: BuilderContext = {
      ymbRoot: 'D:\\Mods\\InstalledMod\\YMB',
      modRoot: 'D:\\Mods\\InstalledMod',
      modsRoot: 'D:\\Mods\\InstalledMod\\YMB\\mods',
      gameDataRoot: 'D:\\Mods\\InstalledMod\\GameData',
      commonDataRoot: 'D:\\Mods\\InstalledMod\\CommonData',
      buildRoot: 'D:\\Mods\\InstalledMod\\YMB\\.ymb-build',
      stateRoot: 'D:\\Mods\\InstalledMod\\YMB\\.ymb-state',
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
          targets: [],
          scripts: [],
          tempPaths: [],
          version: 1,
          variables: {
            sharedValue: 'patch',
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
  });
});
