import { describe, expect, test } from 'bun:test';
import { renderGeneratedBlock } from '../src/generated-blocks.ts';
import { createScriptNdfTools } from '../src/scripts/tools.ts';

const ndf = createScriptNdfTools();

describe('script ndf tools: value parsing', () => {
  test('parses every scalar kind', () => {
    expect(ndf.parseValue('True')).toEqual({ kind: 'bool', value: true, raw: 'True' });
    expect(ndf.parseValue('False')).toEqual({ kind: 'bool', value: false, raw: 'False' });
    expect(ndf.parseValue('-42')).toEqual({ kind: 'int', value: -42, raw: '-42' });
    expect(ndf.parseValue('3.5')).toEqual({ kind: 'float', value: 3.5, raw: '3.5' });
    expect(ndf.parseValue('1.0e3')).toEqual({ kind: 'float', value: 1000, raw: '1.0e3' });
    expect(ndf.parseValue("'Infantry'")).toEqual({
      kind: 'string',
      value: 'Infantry',
      raw: "'Infantry'",
    });
    expect(ndf.parseValue('"Focus"')).toEqual({ kind: 'string', value: 'Focus', raw: '"Focus"' });
    expect(ndf.parseValue('~/Descriptor_Unit')).toEqual({
      kind: 'reference',
      value: '~/Descriptor_Unit',
      raw: '~/Descriptor_Unit',
    });
    expect(ndf.parseValue('NATO')).toEqual({ kind: 'reference', value: 'NATO', raw: 'NATO' });
    expect(ndf.parseValue('(1, 2)')).toEqual({ kind: 'raw', value: '(1, 2)', raw: '(1, 2)' });
  });

  test('parses lists of scalars, including tag and typed entries', () => {
    expect(ndf.parseList("[ 'a', 'b' ]").map((entry) => entry.value)).toEqual(['a', 'b']);
    expect(ndf.parseList('[ 1, 2, 3 ]').map((entry) => entry.kind)).toEqual(['int', 'int', 'int']);
  });
});

describe('script ndf tools: field readers and comments', () => {
  const block = `Descriptor is TFoo
(
    FrontArmor = 5
    Nested = ( Inner = 9 )
    Plain = 1
)`;

  test('reads direct and deep field values', () => {
    expect(ndf.readField(block, 'FrontArmor')).toBe('5');
    expect(ndf.readFieldDeep(block, 'Inner')).toBe('9');
  });

  test('reads the trailing comment of a field, ignoring quoted slashes', () => {
    const commented =
      'Descriptor is TFoo\n(\n    FrontArmor = 5 // ysm-ignore\n    Path = "a//b"\n)';
    expect(ndf.findFieldWithComment(commented, 'FrontArmor')?.trailingComment).toBe('ysm-ignore');
    expect(ndf.findFieldWithComment(commented, 'Path')?.trailingComment).toBeUndefined();
    expect(ndf.findFieldWithComment(block, 'Plain')?.trailingComment).toBeUndefined();
  });

  test('extracts block bodies and collection ranges', () => {
    expect(ndf.extractBody('TFoo ( Value = 1 )')?.text).toBe('( Value = 1 )');
    expect(ndf.extractCollection('MAP [ (1, 2) ]')?.text).toBe('[ (1, 2) ]');
  });
});

describe('script ndf tools: generated blocks', () => {
  test('lists and strips generated blocks produced by the builder renderer', () => {
    const rendered = renderGeneratedBlock({
      ownerId: 'ysm | decks',
      blocks: ['Descriptor_Deck is TDeck\n(\n)'],
      sourcePath: 'mods/YSM/config/patch/decks',
    });
    const content = `Head is TThing\n(\n)\n\n${rendered}`;

    const blocks = ndf.listGeneratedBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.id).toBe('ysm | decks');
    expect(blocks[0]?.sourcePath).toBe('mods/YSM/config/patch/decks');
    expect(blocks[0]?.innerText).toContain('Descriptor_Deck is TDeck');

    const stripped = ndf.stripGeneratedBlocks(content);
    expect(stripped).toContain('Head is TThing');
    expect(stripped).not.toContain('GENERATED BLOCK');
    expect(stripped).not.toContain('Descriptor_Deck');
    expect(ndf.generatedBlockMarkers('ysm | decks')).toEqual({
      start: '// YMB GENERATED BLOCK START | ysm | decks',
      end: '// YMB GENERATED BLOCK END | ysm | decks',
    });
  });
});

describe('script ndf tools: collection mutation', () => {
  const source = `DivisionRules is TRules
(
    DivisionIds = MAP
    [
        (1, "Alpha"),
        (2, "Bravo"),
    ]
)
`;

  test('inserts a new entry into a named map collection', () => {
    const updated = ndf.insertIntoCollection(source, 'DivisionRules.DivisionIds', {
      $raw: '(3, "Charlie"),',
    });
    expect(updated).toContain('(3, "Charlie"),');
    expect(ndf.assertValid(updated)).toBeUndefined();
  });

  test('is idempotent when the entry already exists', () => {
    const updated = ndf.insertIntoCollection(source, 'DivisionRules.DivisionIds', {
      $raw: '(2, "Bravo"),',
    });
    expect(updated).toBe(source);
  });

  test('honors start and anchor positions', () => {
    const atStart = ndf.insertIntoCollection(
      source,
      'DivisionRules.DivisionIds',
      { $raw: '(0, "Base"),' },
      { position: 'start' },
    );
    expect(atStart.indexOf('(0, "Base"),')).toBeLessThan(atStart.indexOf('(1, "Alpha"),'));
  });

  test('rejects an unknown block with a selector error', () => {
    expect(() =>
      ndf.insertIntoCollection(source, 'MissingBlock.DivisionIds', { $raw: '(9, "X"),' }),
    ).toThrow('was not found');
  });

  test('rejects a path without a field segment', () => {
    expect(() => ndf.insertIntoCollection(source, 'DivisionRules', { $raw: '(9, "X"),' })).toThrow(
      'top-level block and at least one field',
    );
  });
});
