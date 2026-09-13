import { describe, expect, test } from 'bun:test';
import { buildJsonError } from '../src/cli/json-output.ts';
import { YmbError } from '../src/errors.ts';
import { validateNdf, validateNdfCooperative } from '../src/patch/ndf/validate.ts';
import {
  createRuntimeResponseError,
  serializeRuntimeError,
} from '../src/scripts/runtime-shared.ts';
import { SCRIPT_NDF_TOOLS } from '../src/scripts/tools.ts';

const cases = [
  [
    'misplaced object',
    'Root is T(Children = [Child()])',
    'Root is T(Children = [] Child(),)',
    'ndf.expected_assignment',
  ],
  ['missing assignment', 'Root is T(Value = 42)', 'Root is T(Value 42)', 'ndf.expected_assignment'],
  ['missing value', 'Root is T(Value = nil)', 'Root is T(Value = )', 'ndf.expected_value'],
  [
    'unfinished expression',
    'Root is T(Value = 2 + 3)',
    'Root is T(Value = 2 + )',
    'ndf.expected_value',
  ],
  ['extra comma', 'Values is [1, 2,]', 'Values is [1,,2]', 'ndf.expected_value'],
  ['leading comma', 'Values is [1]', 'Values is [,1]', 'ndf.expected_value'],
  ['missing comma', 'Values is [A(), B()]', 'Values is [A() B()]', 'ndf.expected_token'],
  ['missing root binding', 'Root is T()', 'Root T()', 'ndf.expected_declaration'],
  ['unfinished string', 'Value is "sample"', 'Value is "sample', 'ndf.unclosed_string'],
  ['unfinished comment', '/* sample */ Value is 1', '/* sample', 'ndf.unclosed_comment'],
  [
    'missing template body binding',
    'template Build[A:int = 1] is T(Value = <A>)',
    'template Build[A:int = 1] T(Value = <A>)',
    'ndf.expected_token',
  ],
  [
    'missing template reference end',
    'Root is T(Value = <Parameter>)',
    'Root is T(Value = <Parameter)',
    'ndf.expected_token',
  ],
  ['unclosed object', 'Root is T(Value = 1)', 'Root is T(Value = 1', 'ndf.expected_token'],
  [
    'mismatched delimiters',
    'Root is T(Values = [])',
    'Root is T(Values = [)',
    'ndf.expected_value',
  ],
] as const;

describe('NDF syntax validation', () => {
  test.each(cases)('%s', async (_name, valid, invalid, code) => {
    const tools = SCRIPT_NDF_TOOLS;
    expect(tools.validate(valid).ok).toBe(true);
    await validateNdfCooperative(valid, 'sample.ndf', { async maybeYield() {} });
    const result = tools.validate(invalid, 'sample.ndf');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Invalid fixture was accepted.');
    expect(result.error).toMatchObject({
      category: 'ParserError',
      code,
      absolutePath: 'sample.ndf',
    });
    expect(result.error.suggestion.length).toBeGreaterThan(0);
    const error = await validateNdfCooperative(invalid, 'sample.ndf', {
      async maybeYield() {},
    }).catch((error) => error);
    expect(error).toBeInstanceOf(YmbError);
    expect(error.context).toMatchObject({
      code,
      line: result.error.line,
      column: result.error.column,
      offset: result.error.offset,
    });
  });

  test('accepts scoped declarations, type metadata and expressions without knowing game types', () => {
    validateNdf(
      `/* Comments can contain unmatched delimiters: ( ] " */
template Build[
  Items: LIST<UnknownType>[required, GroupBy = 'sample'] = [],
  Count: int[>=0] = 2,
] is UnknownContainer(
  ExpectedType: float3
  private Nested is OtherType(Value = -<Count> + 2)
  Items = <Items> + [Nested, Named is OtherType()]
  Pair = ('left', Nested.Value)
  Color = RGBA[1, 2, 3, 4]
  Ref = $/Namespace//Object
  Position = [-<Items>[0] * 2, 0.]
  Weight = (1 - sat[length[Position] div 2]) * 3
  Value = <Count> > 1 ? Nested : nil
  Identity = GUID:{12345678-1234-1234-1234-123456789abc}
)
unnamed Build()
`,
      'sample.ndf',
    );
  });

  test('preserves structured locations through worker transport, JSON and the public script tool', () => {
    const text = 'Root is T(\r\n\tCaption = "界"\r\n\tChildren = []\r\n\tChild()\r\n)';
    const offset = text.indexOf('()', text.indexOf('Child()'));
    let error: unknown;
    try {
      validateNdf(text, 'sample.ndf');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(YmbError);
    if (!(error instanceof YmbError)) throw error;
    const context = { code: 'ndf.expected_assignment', line: 4, column: 7, offset };
    expect(error.context).toMatchObject(context);
    const transported = createRuntimeResponseError(
      serializeRuntimeError(error, {
        ...error.context,
        absolutePath: 'generate.ts',
        modId: 'sample',
      }),
      error.context,
    );
    expect(buildJsonError('build', transported).errors).toMatchObject([
      { ...context, path: 'sample.ndf', sourcePath: 'generate.ts', modId: 'sample' },
    ]);
    expect(SCRIPT_NDF_TOOLS.validate(text, 'sample.ndf')).toMatchObject({
      ok: false,
      error: context,
    });
    expect(error.message).toContain('sample.ndf:4:7');
    expect(error.context.details?.at(-1)?.trim()).toBe('^');
  });

  test('yields during a large single object and still checks its last member', async () => {
    let yields = 0;
    const text = `Root is T(Values = [${'Child(Value = 1),'.repeat(2000)}] Missing = )`;
    const error = await validateNdfCooperative(text, 'sample.ndf', {
      async maybeYield() {
        yields++;
      },
    }).catch((error) => error);
    expect(yields).toBeGreaterThan(1);
    expect(error.context.code).toBe('ndf.expected_value');
    expect(error.context.offset).toBe(text.length - 1);
  });

  test('reports excessive nesting as a diagnostic instead of exhausting the stack', () => {
    for (const nested of [
      (depth: number) => `Root is ${'T(Value = '.repeat(depth)}1${')'.repeat(depth)}`,
      (depth: number) =>
        `template Build[Items: ${'LIST<'.repeat(depth)}T${'>'.repeat(depth)}] is T()`,
    ]) {
      expect(SCRIPT_NDF_TOOLS.validate(nested(20)).ok).toBe(true);
      expect(SCRIPT_NDF_TOOLS.validate(nested(300))).toMatchObject({
        ok: false,
        error: { code: 'ndf.nesting_limit', category: 'ParserError' },
      });
    }
  });
});
