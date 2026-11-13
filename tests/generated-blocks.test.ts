import { describe, expect, test } from 'bun:test';
import {
  buildGeneratedBlockEndMarker,
  buildGeneratedBlockStartMarker,
  listGeneratedBlocks,
  renderGeneratedBlock,
  stripGeneratedBlocks,
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

  test('keeps `$` replacement patterns literal when replacing an owned block', () => {
    const original = [
      'header',
      buildGeneratedBlockStartMarker('owner.ts'),
      'old',
      buildGeneratedBlockEndMarker('owner.ts'),
      '',
    ].join('\n');
    const replacement = renderGeneratedBlock({
      ownerId: 'owner.ts',
      blocks: ["Texture = $/GFX/Icon $& $' $` $$ $1"],
    });

    const updated = upsertGeneratedBlock(original, replacement, 'owner.ts');

    expect(updated).toContain("Texture = $/GFX/Icon $& $' $` $$ $1");
    expect(updated).not.toContain('header\nheader');
  });

  /** `^` sits between the `\r` and `\n` of a CRLF break, so the block used to start a character early and stripping left a bare `\r`. */
  test.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ])('reads a generated block at its own line boundary (%s)', (_label, lineEnding) => {
    for (const indent of ['', '    ']) {
      const block = renderGeneratedBlock({ ownerId: 'owner.ts', blocks: ['new'] })
        .split('\n')
        .map((line) => (line.startsWith('// YMB') ? `${indent}${line}` : line))
        .join(lineEnding);
      const content = `head${lineEnding}${block}tail${lineEnding}`;

      const [range] = listGeneratedBlocks(content);

      expect(range?.id, indent).toBe('owner.ts');
      expect(content.slice(range?.start ?? 0), indent).toStartWith(`${indent}// YMB`);
      expect(stripGeneratedBlocks(content), indent).toBe(`head${lineEnding}tail${lineEnding}`);
    }
  });

  test('returns the generated block as-is when the original content is empty', () => {
    const block = renderGeneratedBlock({
      ownerId: 'owner.ts',
      blocks: ['new'],
    });

    expect(upsertGeneratedBlock('', block, 'owner.ts')).toBe(block);
  });
});
