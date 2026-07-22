import { describe, expect, test } from 'bun:test';
import { tryMergeGeneratedBlocks } from '../src/generated-block-merge.ts';

describe('generated block merge', () => {
  test('applies when only the current script block changes', () => {
    const current = [
      'header',
      '// YMB GENERATED BLOCK START | patches/core.ts',
      '// Source: patches/core.ts',
      'core',
      '// YMB GENERATED BLOCK END | patches/core.ts',
      '',
      '// YMB GENERATED BLOCK START | patches/variant.ts',
      '// Source: patches/variant.ts',
      'zombie-old',
      '// YMB GENERATED BLOCK END | patches/variant.ts',
      '',
      'footer',
      '',
    ].join('\n');
    const next = current.replace('zombie-old', 'zombie-new');

    const result = tryMergeGeneratedBlocks(current, next, 'patches/variant.ts');
    expect(result).toEqual({
      kind: 'applied',
      content: next,
    });
  });

  test('rejects changes to a foreign generated block', () => {
    const current = [
      'header',
      '// YMB GENERATED BLOCK START | patches/core.ts',
      '// Source: patches/core.ts',
      'core-old',
      '// YMB GENERATED BLOCK END | patches/core.ts',
      '',
      'footer',
      '',
    ].join('\n');
    const next = current.replace('core-old', 'core-new');

    const result = tryMergeGeneratedBlocks(current, next, 'patches/variant.ts');
    expect(result.kind).toBe('conflict');
    if (result.kind !== 'conflict') {
      return;
    }
    expect(result.details).toContain('Foreign generated block: patches/core.ts');
  });

  test('applies changes delegated to configured script owners', () => {
    const current = [
      'header',
      '// YMB GENERATED BLOCK START | patches/core.ts',
      '// Source: patches/core.ts',
      'core-old',
      '// YMB GENERATED BLOCK END | patches/core.ts',
      '',
      '// YMB GENERATED BLOCK START | patches/variant.ts',
      '// Source: patches/variant.ts',
      'variant-old',
      '// YMB GENERATED BLOCK END | patches/variant.ts',
      '',
    ].join('\n');
    const next = current.replace('core-old', 'core-new').replace('variant-old', 'variant-new');

    expect(
      tryMergeGeneratedBlocks(current, next, ['patches/core.ts', 'patches/variant.ts']),
    ).toEqual({ kind: 'applied', content: next });
  });

  test('falls back when text outside generated blocks changes', () => {
    const current = [
      'header',
      '// YMB GENERATED BLOCK START | patches/core.ts',
      '// Source: patches/core.ts',
      'core',
      '// YMB GENERATED BLOCK END | patches/core.ts',
      '',
      'footer',
      '',
    ].join('\n');
    const next = current.replace('header', 'new-header');

    expect(tryMergeGeneratedBlocks(current, next, 'patches/core.ts')).toEqual({
      kind: 'unsupported',
    });
  });
});
