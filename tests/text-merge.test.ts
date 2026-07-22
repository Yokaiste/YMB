import { describe, expect, test } from 'bun:test';
import {
  describeTextChanges,
  formatLineEditRange,
  tryMergeTextContributions,
} from '../src/text-merge.ts';

describe('text merge', () => {
  test('merges disjoint replacements against the same base', () => {
    const result = tryMergeTextContributions('alpha\nbeta\ngamma\n', [
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

  test('treats inherited edits as duplicates instead of conflicts', () => {
    const result = tryMergeTextContributions('alpha\nbeta\ngamma\n', [
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

  test('rejects overlapping replacements', () => {
    const result = tryMergeTextContributions('alpha\nbeta\ngamma\n', [
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

  test('rejects two insertions at the same anchor', () => {
    const result = tryMergeTextContributions('alpha\ngamma\n', [
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

  test('allows inherited insertion growth at the same anchor', () => {
    const result = tryMergeTextContributions('alpha\n', [
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

  test('fails fast when a same-file diff would exceed the protected merge budget', () => {
    const baseLines = Array.from({ length: 8000 }, (_, index) => `base-${index}\n`).join('');
    const nextLines = Array.from({ length: 8000 }, (_, index) => `next-${index}\n`).join('');
    const result = tryMergeTextContributions(baseLines, [
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

    expect(result.budget.changedBaseLines).toBe(0);
    expect(result.budget.changedNextLines).toBe(0);
    expect(result.budget.estimatedWork).toBeGreaterThan(80_000_000);
  });

  test('allows large one-sided insertions because they do not require quadratic diff work', () => {
    const insertedLines = Array.from({ length: 20000 }, (_, index) => `line-${index}\n`).join('');
    const result = tryMergeTextContributions('', [
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

  test('fails fast when a generic merge input exceeds the absolute text-size cap', () => {
    const largeText = 'x'.repeat(4_200_000);
    const result = tryMergeTextContributions('', [
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

  test('preserves CRLF text when edits are disjoint', () => {
    const result = tryMergeTextContributions('alpha\r\nbeta\r\ngamma\r\n', [
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

  test('allows callers to apply a stricter protected budget for non-critical diff work', () => {
    const result = describeTextChanges(
      'alpha\nbeta\ngamma\n',
      'ALPHA\nBETA\nGAMMA\n',
      {
        id: 'marker',
        label: 'marker',
      },
      {
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
});
