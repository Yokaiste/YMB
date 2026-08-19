import { beforeEach, describe, expect, test } from 'bun:test';
import { createNdfTextBuffer } from '../src/patch/ndf/buffer.ts';
import { getNdfScanCacheStatsForTests, resetNdfScanCachesForTests } from '../src/patch/ndf/scan.ts';

const source = `export Descriptor_Unit_A is TEntityDescriptor
(
    FrontArmor = 1
)

export Descriptor_Unit_B is TEntityDescriptor
(
    FrontArmor = 2
)

export Descriptor_Unit_C is TEntityDescriptor
(
    FrontArmor = 3
)
`;

/** Applies the same edits to a plain string, which is what the buffer replaces. */
function spliceText(text: string, start: number, end: number, replacement: string): string {
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}

describe('the text buffer a target is applied to', () => {
  beforeEach(() => {
    resetNdfScanCachesForTests();
  });

  test('a run of edits produces exactly what splicing the string would have', () => {
    const buffer = createNdfTextBuffer(source);
    let expected = source;

    for (const name of ['Descriptor_Unit_B', 'Descriptor_Unit_A', 'Descriptor_Unit_C']) {
      const block = buffer.blocks().find((candidate) => candidate.name === name);
      expect(block).toBeDefined();
      if (!block) return;
      const rewritten = block.text.replace('FrontArmor', 'SideArmor');
      expected = spliceText(expected, block.start, block.end, rewritten);
      buffer.replaceTopLevelRange(block.start, block.end, rewritten);
    }

    expect(buffer.text()).toBe(expected);
  });

  test('an edit that changes a block length leaves the later blocks addressable', () => {
    const buffer = createNdfTextBuffer(source);
    const first = buffer.blocks()[0];
    expect(first?.name).toBe('Descriptor_Unit_A');
    if (!first) return;

    // Longer than what it replaces, so every following block moves.
    buffer.replaceTopLevelRange(
      first.start,
      first.end,
      `export Descriptor_Unit_A is TEntityDescriptor\n(\n    FrontArmor = 1\n    Extra = 'padding padding padding'\n)`,
    );

    const last = buffer.blocks().at(-1);
    expect(last?.name).toBe('Descriptor_Unit_C');
    if (!last) return;
    expect(buffer.text().slice(last.start, last.end)).toBe(last.text);
  });

  test('an insertion keeps the block list in file order', () => {
    const buffer = createNdfTextBuffer(source);
    const second = buffer.blocks()[1];
    if (!second) return;

    buffer.replaceTopLevelRange(
      second.start,
      second.start,
      'export Descriptor_Unit_New is TEntityDescriptor\n(\n    FrontArmor = 9\n)\n\n',
    );

    expect(buffer.blocks().map((block) => block.name)).toEqual([
      'Descriptor_Unit_A',
      'Descriptor_Unit_New',
      'Descriptor_Unit_B',
      'Descriptor_Unit_C',
    ]);
    const starts = buffer.blocks().map((block) => block.start);
    expect([...starts].sort((left, right) => left - right)).toEqual(starts);
  });

  test('reads answer from the pieces, including across a splice', () => {
    const buffer = createNdfTextBuffer(source);
    const first = buffer.blocks()[0];
    if (!first) return;
    buffer.replaceTopLevelRange(
      first.start,
      first.end,
      'export Renamed_Unit is TEntityDescriptor\n(\n)',
    );

    // A needle spanning the seam between the replacement and what follows it.
    expect(buffer.includes('Renamed_Unit')).toBe(true);
    expect(buffer.includes(')\n\nexport Descriptor_Unit_B')).toBe(true);
    expect(buffer.includes('Descriptor_Unit_A')).toBe(false);
    expect(buffer.slice(0, 6)).toBe('export');
    expect(buffer.length).toBe(buffer.text().length);
  });

  test('indentation is read without joining the file', () => {
    const buffer = createNdfTextBuffer(`Outer\n(\n        Inner = 1\n)\n`);
    expect(buffer.readLineIndent(buffer.text().indexOf('Inner'))).toBe('        ');
  });

  test('the text it was built from is not left indexed beside its result', () => {
    const buffer = createNdfTextBuffer(source);
    const first = buffer.blocks()[0];
    if (!first) return;
    buffer.replaceTopLevelRange(
      first.start,
      first.end,
      'export Renamed_Unit is TEntityDescriptor\n(\n)',
    );
    buffer.text();

    // Keeping both would pin two full copies of a file that can be tens of
    // megabytes, which is what the entry cap exists to prevent.
    expect(getNdfScanCacheStatsForTests().entries).toBe(1);
  });
});
