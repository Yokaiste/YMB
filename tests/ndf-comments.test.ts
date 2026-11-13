import { describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { splitTrailingComment, stripComments } from '../src/patch/ndf/comments.ts';
import { insertCollectionEntryByPath } from '../src/patch/ndf/core.ts';
import {
  extractFirstCollectionRange,
  extractFirstParenthesizedRange,
  findCollectionEntries,
  findNamedBlockByName,
  findObjectBlocks,
  findTopLevelBlocks,
  readDirectFieldValue,
  readNumericDefinitions,
} from '../src/patch/ndf/scan.ts';
import { validateNdf } from '../src/patch/ndf/validate.ts';
import { parseNdfScalar } from '../src/patch/ndf/values.ts';
import { application, applyPatchTarget } from './helpers/ndf.ts';

describe('NDF block comments', () => {
  test('edits include public modifiers and comments between declaration tokens', async () => {
    const source = 'public /* visibility */ Real /* name */ is Thing(Value = 1)\n';
    expect(() => validateNdf(source, 'fixture.ndf')).not.toThrow();
    expect(findNamedBlockByName(source, 'Real')?.text).toBe(source.trimEnd());
    const output = await applyPatchTarget(
      source,
      {
        file: 'GameData/Fixture.ndf',
        operations: [{ op: 'remove', selector: { kind: 'object', by: 'name', value: 'Real' } }],
      },
      application,
      'GameData/Fixture.ndf',
    );
    expect(() => validateNdf(output, 'fixture.ndf')).not.toThrow();
    expect(findTopLevelBlocks(output)).toHaveLength(0);
    expect(findNamedBlockByName('public template Example [] is Thing()\n', 'Example')?.text).toBe(
      'public template Example [] is Thing()',
    );
    expect(findNamedBlockByName('public Answer is 4\n', 'Answer')?.text).toBe('public Answer is 4');
  });
  const source = `/*/
Ghost is Thing()
template Hidden [] is Thing()
HiddenScalar is 9
HiddenList is
[
]
Unbalanced is Thing( ] "
*/
Real is /* ( */ Thing /* ) */ (
    Value = 1 /* )
FakeField = 90
*/
    Items = [ /* , ( ] */ 2, Child(Value = 3), ]
)
`;

  test('validation, indexes and fallback readers ignore the same comment contents', () => {
    expect(() => validateNdf(source, 'fixture.ndf')).not.toThrow();
    expect(findTopLevelBlocks(source).map((block) => block.name)).toEqual(['Real']);
    expect(findObjectBlocks(source).map((block) => block.typeName)).toEqual(['Thing', 'Child']);
    for (const name of ['Ghost', 'Hidden', 'HiddenScalar', 'HiddenList']) {
      expect(findNamedBlockByName(source, name)).toBeUndefined();
    }
    const real = findNamedBlockByName(source, 'Real');
    assert.ok(real);
    expect(readDirectFieldValue(real.text, 'FakeField')).toBeUndefined();
    expect(splitTrailingComment(readDirectFieldValue(real.text, 'Value') ?? '').code).toBe('1');
    expect(
      findCollectionEntries(readDirectFieldValue(real.text, 'Items') ?? '').map(
        (entry) => entry.text,
      ),
    ).toEqual(['2', 'Child(Value = 3)']);
    expect(readNumericDefinitions('/*\nGhost is 9\n*/\nReal is 2\n')).toEqual({ Real: 2 });
  });

  test('edits retain block comments and never modify a commented-out field', async () => {
    const output = await applyPatchTarget(
      source,
      {
        file: 'GameData/Fixture.ndf',
        operations: [
          { op: 'modify', selector: { kind: 'field', by: 'path', value: 'Real.Value' }, value: 4 },
        ],
      },
      application,
      'GameData/Fixture.ndf',
    );
    expect(() => validateNdf(output, 'fixture.ndf')).not.toThrow();
    expect(output).toContain('Value = 4 /* )\nFakeField = 90\n*/');
    expect(findNamedBlockByName(output, 'Ghost')).toBeUndefined();
  });

  test('body and collection extraction ignore delimiters in strings and comments', () => {
    const text = `/* ( [ */ "( [" Thing(Value = [1, 2])`;
    const body = extractFirstParenthesizedRange(text);
    const collection = extractFirstCollectionRange(text);
    assert.ok(body && collection);
    expect(text.slice(body.start, body.end)).toBe('(Value = [1, 2])');
    expect(text.slice(collection.start, collection.end)).toBe('[1, 2]');
  });

  test('collection appends ignore multiline comments after the existing separator', () => {
    const source = 'Root is Thing(Items = [1, /* multiline\n ] ( ,\n */\n])\n';
    const output = insertCollectionEntryByPath(source, 'Root.Items', '2');
    expect(() => validateNdf(output, 'fixture.ndf')).not.toThrow();
    expect(
      findCollectionEntries(readDirectFieldValue(output, 'Items') ?? '').map((entry) => entry.text),
    ).toEqual(['1', '2']);
  });

  test('comment stripping preserves string contents, line endings and token boundaries', () => {
    const result = stripComments(
      'A/* note */is 1\r\n/* multiline\r\ncomment */B is "/* keep */" // remove\r\n',
    );
    expect(result).toBe('A is 1\r\n\r\nB is "/* keep */" \r\n');
    expect(splitTrailingComment('1 /* note */ + 2').code).toBe('1 /* note */ + 2');
    expect(splitTrailingComment('1 /* note */ // second').trailingComment).toBe(
      '/* note */ // second',
    );
  });
});

test('scalar parsing decodes escaped strings and ignores comments around values', () => {
  expect(parseNdfScalar("'can\\'t'")).toMatchObject({ kind: 'string', value: "can't" });
  expect(parseNdfScalar('"a\\\\b"')).toMatchObject({ kind: 'string', value: 'a\\b' });
  expect(parseNdfScalar('/* before */ 2 /* after */')).toMatchObject({ kind: 'int', value: 2 });
  expect(parseNdfScalar("'one' + 'two'").kind).toBe('raw');
  expect(parseNdfScalar('9007199254740993').kind).toBe('raw');
  expect(parseNdfScalar('1e999').kind).toBe('raw');
  expect(parseNdfScalar('1e3')).toMatchObject({ kind: 'float', value: 1000 });
});
