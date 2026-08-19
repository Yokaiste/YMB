import { afterEach, describe, expect, test } from 'bun:test';
import { runList, runValidate } from '../src/engine/commands.ts';
import { toUnmatchedFilterFinding } from '../src/report/findings.ts';
import { collectUnmatchedSelectionFilters } from '../src/selection-filter.ts';
import type { SelectionInput } from '../src/types.ts';
import {
  cleanupTempRoots,
  createAbstractBuilderWorkspace,
  summaryText,
} from './helpers/abstract-builder.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  await cleanupTempRoots(tempRoots);
});

const baseSelection: SelectionInput = {
  scope: 'prod',
  modFilters: [],
  patchFilters: [],
  dryRun: true,
  verbose: false,
  yes: false,
};

const mods = [
  { id: 'sample_mod', name: 'Sample Mod' },
  { id: 'addon', name: 'Addon Pack' },
];

describe('selection filters that match nothing', () => {
  test('an exact id or display name is a match, in any case', () => {
    expect(collectUnmatchedSelectionFilters('--mod', ['SAMPLE_MOD', 'Addon Pack'], mods)).toEqual(
      [],
    );
  });

  test('a near miss matches nothing at all, because comparison is exact', () => {
    const unmatched = collectUnmatchedSelectionFilters('--mod', ['sample'], mods);

    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]?.value).toBe('sample');
    expect(unmatched[0]?.availableIds).toEqual(['addon', 'sample_mod']);
  });

  test('no filters means no report, not "every name is missing"', () => {
    expect(collectUnmatchedSelectionFilters('--mod', [], mods)).toEqual([]);
  });

  test('a filter naming nothing is reported once per bad value', () => {
    const unmatched = collectUnmatchedSelectionFilters(
      '--patch',
      ['a.typo', 'b.typo'],
      [{ id: 'sample_mod.armor', name: 'Armor' }],
    );

    expect(unmatched.map((entry) => entry.value)).toEqual(['a.typo', 'b.typo']);
  });

  test('the finding names the bad value and what YMB did find', () => {
    const finding = toUnmatchedFilterFinding({
      option: '--mod',
      value: 'nope',
      availableIds: ['addon', 'sample_mod'],
    });

    expect(finding.severity).toBe('warning');
    expect(finding.subject).toBe('--mod nope');
    expect(finding.detail).toContain('No source mod answers to `nope`');
    expect(finding.suggestion).toContain('`addon`, `sample_mod`');
  });

  test('too many names to list points at `list` instead of printing all of them', () => {
    const finding = toUnmatchedFilterFinding({
      option: '--patch',
      value: 'nope',
      availableIds: Array.from({ length: 30 }, (_, index) => `patch_${index}`),
    });

    expect(finding.detail).toContain('No patch answers to `nope`');
    expect(finding.suggestion).toContain('the 30 names `list` prints');
    expect(finding.suggestion).not.toContain('patch_0');
  });

  test('a project with nothing to select says so rather than listing an empty set', () => {
    const finding = toUnmatchedFilterFinding({ option: '--mod', value: 'nope', availableIds: [] });

    expect(finding.suggestion).toContain('YMB found nothing to select at all');
  });
});

describe('commands report a filter that narrowed the run to nothing', () => {
  async function createTempBuilder(): Promise<string> {
    return (await createAbstractBuilderWorkspace(tempRoots)).builderPath;
  }

  test('`list` warns instead of printing an empty list that looks like success', async () => {
    const builderPath = await createTempBuilder();
    const lines = await runList(builderPath, { ...baseSelection, modFilters: ['sample-pack'] });

    expect(lines.join('\n')).toContain('No source mod answers to `sample-pack`');
    // The listing itself is unchanged: `list` shows what exists, filtered or not.
    expect(lines.some((line) => line.startsWith('mod | sample_pack'))).toBe(true);
  });

  test('`validate` counts it as a warning and still succeeds', async () => {
    const builderPath = await createTempBuilder();
    const lines = await runValidate(builderPath, {
      ...baseSelection,
      patchFilters: ['balance.armour'],
    });

    expect(lines.join('\n')).toContain('No patch answers to `balance.armour`');
    expect(summaryText(lines)).toContain('1 warning');
  });

  test('a filter that matches reports nothing', async () => {
    const builderPath = await createTempBuilder();
    const lines = await runList(builderPath, { ...baseSelection, modFilters: ['sample_pack'] });

    expect(lines.join('\n')).not.toContain('answers to');
  });
});
