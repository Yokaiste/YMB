import { describe, expect, test } from 'bun:test';
import {
  buildGeneratedBlockEndMarker,
  buildGeneratedBlockStartMarker,
  renderGeneratedBlock,
  upsertGeneratedBlock,
} from '../src/generated-blocks.ts';

describe('generated blocks helpers', () => {
  test('renders generic YMB generated blocks with source metadata', () => {
    const block = renderGeneratedBlock({
      ownerId: 'patches/sample-pack/generate.ts',
      title: 'Generated summary',
      sourcePath: 'patches/sample-pack/generate.ts',
      blocks: ['export Generated is TSummary', '()'],
    });

    expect(block).toContain('// YMB GENERATED BLOCK START | patches/sample-pack/generate.ts');
    expect(block).toContain('// Generated summary');
    expect(block).toContain('// Source: patches/sample-pack/generate.ts');
    expect(block).toContain('// YMB GENERATED BLOCK END | patches/sample-pack/generate.ts');
  });

  test('replaces an existing owned block without touching surrounding text', () => {
    const original = [
      'header',
      buildGeneratedBlockStartMarker('owner.ts'),
      '// Source: owner.ts',
      'old',
      buildGeneratedBlockEndMarker('owner.ts'),
      '',
      'footer',
      '',
    ].join('\n');
    const replacement = renderGeneratedBlock({
      ownerId: 'owner.ts',
      sourcePath: 'owner.ts',
      blocks: ['new'],
    });

    const updated = upsertGeneratedBlock(original, replacement, 'owner.ts');

    expect(updated).toContain('header');
    expect(updated).toContain('new');
    expect(updated).not.toContain('old');
    expect(updated).toContain('footer');
  });

  test('returns the generated block as-is when the original content is empty', () => {
    const block = renderGeneratedBlock({
      ownerId: 'owner.ts',
      blocks: ['new'],
    });

    expect(upsertGeneratedBlock('', block, 'owner.ts')).toBe(block);
  });
});
