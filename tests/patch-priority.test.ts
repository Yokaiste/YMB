import { afterEach, describe, expect, test } from 'bun:test';
import { YmbError } from '../src/errors.ts';
import {
  createSimpleDiff,
  resolvePrioritizedModId,
  sanitizeFileName,
  setPatchPriorityResolverForTests,
  toAlphaLabel,
} from '../src/patch-priority.ts';
import { createTestBuilderContext, createTestPatchApplication } from './helpers/planner.ts';

const stdinTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const stdoutTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

afterEach(() => {
  restoreDescriptor(process.stdin, 'isTTY', stdinTtyDescriptor);
  restoreDescriptor(process.stdout, 'isTTY', stdoutTtyDescriptor);
});

describe('patch priority prompts', () => {
  test('fails fast when patch priority selection is required in a non-interactive terminal', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });

    const failure = await resolvePrioritizedModId(
      createTestBuilderContext(),
      'GameData/Generated/Test.ndf',
      'BaseText',
      [
        createContribution('alpha_pack', 'Alpha Pack', 'patch.alpha', 'AlphaText'),
        createContribution('bravo_pack', 'Bravo Pack', 'patch.bravo', 'BravoText'),
      ],
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(YmbError);
    const ymbError = failure as YmbError;
    expect(ymbError.context.reason).toContain('requires an interactive terminal');
    // The durable fix is layering config, so the error has to name the competing
    // mods and point at it instead of only asking for a terminal.
    expect(ymbError.context.reason).toContain('2 source mods');
    expect(ymbError.context.suggestion).toContain('allowWriteToModifiedFiles');
    expect(ymbError.context.details).toEqual([
      'alpha_pack (Alpha Pack) | patches: patch.alpha',
      'bravo_pack (Bravo Pack) | patches: patch.bravo',
    ]);
  });

  test('never asks when one mod is the only contributor', async () => {
    setPatchPriorityResolverForTests(() => {
      throw new Error('The resolver must not run for a single contributor.');
    });
    try {
      const modId = await resolvePrioritizedModId(
        createTestBuilderContext(),
        'GameData/Generated/Test.ndf',
        'BaseText',
        [
          createContribution('alpha_pack', 'Alpha Pack', 'patch.one', 'AlphaText'),
          createContribution('alpha_pack', 'Alpha Pack', 'patch.two', 'AlphaText'),
        ],
      );

      expect(modId).toBe('alpha_pack');
    } finally {
      setPatchPriorityResolverForTests(undefined);
    }
  });

  test('offers one choice per mod, sorted, with that mod every patch listed', async () => {
    const requests: string[][] = [];
    setPatchPriorityResolverForTests(async (request) => {
      requests.push(
        request.options.map((option) => `${option.modId}:${option.patchIds.join('+')}`),
      );
      return request.options[1]?.modId ?? '';
    });
    try {
      const modId = await resolvePrioritizedModId(
        createTestBuilderContext(),
        'GameData/Generated/Test.ndf',
        'BaseText',
        [
          createContribution('bravo_pack', 'Bravo Pack', 'patch.bravo', 'BravoText'),
          createContribution('alpha_pack', 'Alpha Pack', 'patch.alpha', 'AlphaText'),
          createContribution('alpha_pack', 'Alpha Pack', 'patch.extra', 'AlphaText'),
          // A repeat of a patch already recorded must not list it twice.
          createContribution('alpha_pack', 'Alpha Pack', 'patch.alpha', 'AlphaText'),
        ],
      );

      expect(requests).toEqual([['alpha_pack:patch.alpha+patch.extra', 'bravo_pack:patch.bravo']]);
      expect(modId).toBe('bravo_pack');
    } finally {
      setPatchPriorityResolverForTests(undefined);
    }
  });
});

describe('patch priority preview naming', () => {
  test('labels run past Z into two letters', () => {
    expect(toAlphaLabel(0)).toBe('A');
    expect(toAlphaLabel(25)).toBe('Z');
    expect(toAlphaLabel(26)).toBe('AA');
    expect(toAlphaLabel(27)).toBe('AB');
    expect(toAlphaLabel(51)).toBe('AZ');
    expect(toAlphaLabel(52)).toBe('BA');
  });

  test('keeps a usable file name for any target path', () => {
    expect(sanitizeFileName('GameData/Generated/Units.ndf')).toBe('GameData_Generated_Units.ndf');
    // Nothing survives sanitizing, and an empty name would be a hidden `.diff.md`.
    expect(sanitizeFileName('///')).toBe('target');
    expect(sanitizeFileName('')).toBe('target');
    expect(sanitizeFileName('/leading/and/trailing/')).toBe('leading_and_trailing');
  });
});

describe('patch priority preview diff', () => {
  test('shows only the span that differs, with the line it starts on', () => {
    expect(createSimpleDiff('a\nb\nc\n', 'a\nB\nc\n', 'alpha_pack')).toBe(
      '--- base\n+++ alpha_pack\n@@ line 2 @@\n-b\n+B',
    );
  });

  test('shows an addition with no removed lines, and a removal with none added', () => {
    expect(createSimpleDiff('a\n', 'a\nb\n', 'alpha_pack')).toBe(
      '--- base\n+++ alpha_pack\n@@ line 2 @@\n+b',
    );
    expect(createSimpleDiff('a\nb\n', 'a\n', 'alpha_pack')).toBe(
      '--- base\n+++ alpha_pack\n@@ line 2 @@\n-b',
    );
  });

  test('reports identical output rather than an empty diff', () => {
    expect(createSimpleDiff('a\nb\n', 'a\nb\n', 'alpha_pack')).toBe(
      '--- base\n+++ alpha_pack\n(no textual differences)',
    );
  });

  test('handles a change on the very first line and one on the very last', () => {
    expect(createSimpleDiff('a\nb\n', 'A\nb\n', 'alpha_pack')).toBe(
      '--- base\n+++ alpha_pack\n@@ line 1 @@\n-a\n+A',
    );
    expect(createSimpleDiff('a\nb\n', 'a\nB\n', 'alpha_pack')).toBe(
      '--- base\n+++ alpha_pack\n@@ line 2 @@\n-b\n+B',
    );
  });

  test('replaces the whole of a file that shares nothing with the base', () => {
    expect(createSimpleDiff('a', 'z', 'alpha_pack')).toBe(
      '--- base\n+++ alpha_pack\n@@ line 1 @@\n-a\n+z',
    );
    expect(createSimpleDiff('', 'z', 'alpha_pack')).toBe(
      '--- base\n+++ alpha_pack\n@@ line 1 @@\n-\n+z',
    );
  });
});

function createContribution(
  modId: string,
  modName: string,
  patchId: string,
  previewContent: string,
) {
  return {
    application: createTestPatchApplication({ modId, modName, patchId }),
    targetRelativePath: 'GameData/Generated/Test.ndf',
    hasScripts: false,
    previewContent,
  };
}

function restoreDescriptor(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
    return;
  }

  Reflect.deleteProperty(target, key);
}
