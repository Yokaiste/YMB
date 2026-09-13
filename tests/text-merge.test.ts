import { describe, expect, test } from 'bun:test';
import type { CooperativeYieldController } from '../src/async.ts';
import { createDefaultBuilderProjectConfig } from '../src/builder-config.ts';
import {
  describeTextChanges,
  describeTextChangesCooperative,
  formatLineEditRange,
  resolveTextMergeBudgets,
  type TextMergeContributor,
  tryMergeTextContributionsCooperative,
} from '../src/text-merge.ts';

const immediateYieldController: CooperativeYieldController = {
  maybeYield: async () => undefined,
};

const defaultSettings = createDefaultBuilderProjectConfig().settings;
const defaultBudgets = resolveTextMergeBudgets(defaultSettings);

function mergeText(baseText: string, contributors: TextMergeContributor[]) {
  return tryMergeTextContributionsCooperative(
    baseText,
    contributors,
    immediateYieldController,
    defaultBudgets,
  );
}

describe('text merge', () => {
  test('merges disjoint replacements against the same base', async () => {
    const result = await mergeText('alpha\nbeta\ngamma\n', [
      {
        id: 'left',
        label: 'left',
        content: 'alpha\nBETA\ngamma\n',
      },
      {
        id: 'right',
        label: 'right',
        content: 'alpha\nbeta\nGAMMA\n',
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.content).toBe('alpha\nBETA\nGAMMA\n');
  });

  test('treats inherited edits as duplicates instead of conflicts', async () => {
    const result = await mergeText('alpha\nbeta\ngamma\n', [
      {
        id: 'left',
        label: 'left',
        content: 'ALPHA\nbeta\ngamma\n',
      },
      {
        id: 'right',
        label: 'right',
        content: 'ALPHA\nbeta\nGAMMA\n',
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.content).toBe('ALPHA\nbeta\nGAMMA\n');
  });

  test('rejects overlapping replacements', async () => {
    const result = await mergeText('alpha\nbeta\ngamma\n', [
      {
        id: 'left',
        label: 'left',
        content: 'alpha\nLEFT\ngamma\n',
      },
      {
        id: 'right',
        label: 'right',
        content: 'alpha\nRIGHT\ngamma\n',
      },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'conflict') {
      return;
    }

    expect(result.conflict.existing.contributorLabel).toBe('left');
    expect(formatLineEditRange(result.conflict.incoming)).toBe('line 2');
  });

  test('rejects two insertions at the same anchor', async () => {
    const result = await mergeText('alpha\ngamma\n', [
      {
        id: 'left',
        label: 'left',
        content: 'alpha\nbeta\ngamma\n',
      },
      {
        id: 'right',
        label: 'right',
        content: 'alpha\nomega\ngamma\n',
      },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'conflict') {
      return;
    }

    expect(formatLineEditRange(result.conflict.existing)).toBe('line 2 insertion');
  });

  test('allows inherited insertion growth at the same anchor', async () => {
    const result = await mergeText('alpha\n', [
      {
        id: 'left',
        label: 'left',
        content: 'alpha\nbeta\n',
      },
      {
        id: 'right',
        label: 'right',
        content: 'alpha\nbeta\ngamma\n',
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.content).toBe('alpha\nbeta\ngamma\n');
  });

  test('fails fast when a same-file diff would exceed the protected merge budget', async () => {
    const baseLines = Array.from({ length: 8000 }, (_, index) => `base-${index}\n`).join('');
    const nextLines = Array.from({ length: 8000 }, (_, index) => `next-${index}\n`).join('');
    const result = await mergeText(baseLines, [
      {
        id: 'large',
        label: 'large',
        content: nextLines,
      },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'budget_exceeded') {
      return;
    }

    expect(result.budget.changedBaseLines).toBe(8000);
    expect(result.budget.changedNextLines).toBe(8000);
    expect(result.budget.estimatedWork).toBe(64_000_000);
  });

  test('diffs large full-file rewrites without retaining a quadratic Myers trace', async () => {
    const baseLines = Array.from({ length: 3000 }, (_, index) => `base-${index}\n`).join('');
    const nextLines = Array.from({ length: 3000 }, (_, index) => `next-${index}\n`).join('');
    const result = await mergeText(baseLines, [
      {
        id: 'rewrite',
        label: 'rewrite',
        content: nextLines,
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.content).toBe(nextLines);
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0]).toMatchObject({ start: 0, end: 3000 });
  });

  test('allows large one-sided insertions because they do not require quadratic diff work', async () => {
    const insertedLines = Array.from({ length: 20000 }, (_, index) => `line-${index}\n`).join('');
    const result = await mergeText('', [
      {
        id: 'insert',
        label: 'insert',
        content: insertedLines,
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.content).toBe(insertedLines);
  });

  test('fails fast when a generic merge input exceeds the absolute text-size cap', async () => {
    const largeText = 'x'.repeat(4_200_000);
    const result = await mergeText('', [
      {
        id: 'oversized',
        label: 'oversized',
        content: largeText,
      },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'budget_exceeded') {
      return;
    }

    expect(result.budget.estimatedWork).toBe(4_200_000);
  });

  test('enforces absolute size caps in UTF-8 bytes', async () => {
    const largeText = '€'.repeat(1_400_000);
    const result = await mergeText('', [
      {
        id: 'oversized-unicode',
        label: 'oversized-unicode',
        content: largeText,
      },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'budget_exceeded') {
      return;
    }

    expect(result.budget.estimatedWork).toBe(4_200_000);
  });

  test('preserves CRLF text when edits are disjoint', async () => {
    const result = await mergeText('alpha\r\nbeta\r\ngamma\r\n', [
      {
        id: 'left',
        label: 'left',
        content: 'alpha\r\nBETA\r\ngamma\r\n',
      },
      {
        id: 'right',
        label: 'right',
        content: 'alpha\r\nbeta\r\nGAMMA\r\n',
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.content).toBe('alpha\r\nBETA\r\nGAMMA\r\n');
  });

  test('the merge budget is whatever the builder settings say it is', () => {
    const baseText = 'alpha\nbeta\ngamma\n';
    const nextText = 'ALPHA\nBETA\nGAMMA\n';
    const contributor = { id: 'left', label: 'left' };
    const describeUnder = (mergeMaxEstimatedDiffWork: number) =>
      describeTextChanges(
        baseText,
        nextText,
        contributor,
        resolveTextMergeBudgets({ ...defaultSettings, mergeMaxEstimatedDiffWork }),
      );

    // This diff costs exactly 9, so 9 is the smallest setting that still admits
    // it and 8 is the largest that refuses.
    expect(describeUnder(8).ok).toBe(false);
    expect(describeUnder(9).ok).toBe(true);
  });

  test('allows callers to apply a stricter protected budget for non-critical diff work', () => {
    const result = describeTextChanges(
      'alpha\nbeta\ngamma\n',
      'ALPHA\nBETA\nGAMMA\n',
      {
        id: 'marker',
        label: 'marker',
      },
      {
        ...defaultBudgets,
        maxEstimatedDiffWork: 1,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'budget_exceeded') {
      return;
    }

    expect(result.budget.changedBaseLines).toBe(3);
    expect(result.budget.changedNextLines).toBe(3);
    expect(result.budget.estimatedWork).toBe(9);
  });

  test('linear-space sync and cooperative diffs reconstruct varied repeated-line inputs', async () => {
    let seed = 0x5eed1234;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };

    for (let sample = 0; sample < 200; sample += 1) {
      const createText = () =>
        Array.from(
          { length: random() % 13 },
          () => `${String.fromCharCode(65 + (random() % 5))}\n`,
        ).join('');
      const baseText = createText();
      const nextText = createText();
      const contributor = { id: 'sample', label: 'sample' };
      const syncResult = describeTextChanges(baseText, nextText, contributor, defaultBudgets);
      const cooperativeResult = await describeTextChangesCooperative(
        baseText,
        nextText,
        contributor,
        immediateYieldController,
        defaultBudgets,
      );
      const mergedResult = await mergeText(baseText, [{ ...contributor, content: nextText }]);

      expect(syncResult.ok).toBe(true);
      expect(cooperativeResult.ok).toBe(true);
      expect(mergedResult.ok).toBe(true);
      if (syncResult.ok && cooperativeResult.ok && mergedResult.ok) {
        expect(cooperativeResult.edits).toEqual(syncResult.edits);
        expect(mergedResult.content).toBe(nextText);
        expect(mergedResult.edits).toEqual(syncResult.edits);
      }
    }
  });

  test('keeps a lone carriage return inside its line instead of dropping the text before it', async () => {
    // A merge rebuilds the file from its split lines, so treating a bare `\r` as a
    // line break silently deleted everything ahead of it from a live game file.
    const baseText = 'alpha\rstill alpha\nbeta\n';
    const result = await mergeText(baseText, [
      { id: 'left', label: 'left', content: 'alpha\rstill alpha\nBETA\n' },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.content).toBe('alpha\rstill alpha\nBETA\n');
  });
});
