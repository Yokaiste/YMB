import { describe, expect, test } from 'bun:test';
import { evaluateTemplateExpression } from '../src/template-expressions.ts';

function evaluate(expression: string, variables: Record<string, unknown> = {}): unknown {
  return evaluateTemplateExpression(expression, (identifier) => {
    if (!(identifier in variables)) {
      throw new Error(`Unknown template variable "${identifier}" in expression.`);
    }
    return variables[identifier];
  });
}

describe('template expression parser', () => {
  test('supports precedence, comparisons, logical operators, and conditionals', () => {
    expect(evaluate('2 + 3 * 4')).toBe(14);
    expect(evaluate('8 > 3 && 2 < 5')).toBe(true);
    expect(evaluate("4 >= 5 ? 'large' : 'small'")).toBe('small');
    expect(evaluate("'A' + (enabled ? '-On' : '-Off')", { enabled: true })).toBe('A-On');
  });

  test('supports array literals, object properties, and indexed access', () => {
    expect(
      evaluate('stats.armor.front + bonuses[1]', {
        stats: {
          armor: {
            front: 7,
          },
        },
        bonuses: [1, 4],
      }),
    ).toBe(11);
    expect(evaluate('labels[len(labels) - 1]', { labels: ['alpha', 'bravo', 'charlie'] })).toBe(
      'charlie',
    );
    expect(evaluate("stats['frontArmor']", { stats: { frontArmor: 9 } })).toBe(9);
    expect(evaluate("'line\\nnext'")).toBe('line\nnext');
  });

  test('supports collection helpers for common generation patterns', () => {
    expect(evaluate('repeat(1, 4)')).toEqual([1, 1, 1, 1]);
    expect(evaluate("join(range(1, 5), ', ')")).toBe('1, 2, 3, 4');
    expect(evaluate('concat(range(0, 2), repeat(5, 2))')).toEqual([0, 1, 5, 5]);
    expect(evaluate('numbers([0, 0.25, 1, 1.5, 2])')).toEqual([0, 0.25, 1, 1.5, 2]);
    expect(evaluate('integers([0, 0.25, 1, 1.5, 2])')).toEqual([0, 1, 2]);
    expect(evaluate('nonNegativeNumbers([-2, -0.5, 0, 0.25, 1])')).toEqual([0, 0.25, 1]);
    expect(evaluate('integers(nonNegativeNumbers([-2, -0.5, 0, 1, 1.5, 2]))')).toEqual([0, 1, 2]);
    expect(evaluate('sum([2, 4, 6])')).toBe(12);
    expect(evaluate('len(range(0, 5))')).toBe(5);
    expect(
      evaluate("cartesian(2, ['A', 'B'], '({left}, {right}, {leftIndex}, {rightIndex}, {index})')"),
    ).toEqual(['(0, A, 0, 0, 0)', '(0, B, 0, 1, 1)', '(1, A, 1, 0, 2)', '(1, B, 1, 1, 3)']);
  });

  test('short-circuits logical operators and conditional branches', () => {
    expect(evaluate('false && missing')).toBe(false);
    expect(evaluate('true || missing')).toBe(true);
    expect(evaluate("enabled ? 'ready' : missing", { enabled: true })).toBe('ready');
  });

  test('throws on invalid literals and unsupported member reads', () => {
    expect(() => evaluate('1.')).toThrow();
    expect(() => evaluate('items[2]', { items: ['a', 'b'] })).toThrow();
    expect(() => evaluate('stats.rear', { stats: { front: 5 } })).toThrow();
  });

  test('throws on invalid math operations and helper usage', () => {
    expect(() => evaluate('5 / 0')).toThrow();
    expect(() => evaluate('join(1, ",")')).toThrow();
    expect(() => evaluate("numbers([1, 'bad'])")).toThrow();
    expect(() => evaluate('range(0, 3, 0)')).toThrow();
    expect(() => evaluate('cartesian("bad", [1])')).toThrow();
    expect(() => evaluate('unknownHelper(1)')).toThrow();
  });

  test('compares arrays and objects by value', () => {
    expect(evaluate('[1, 2] == [1, 2]')).toBe(true);
    expect(evaluate('stats == expected', { stats: { front: 5 }, expected: { front: 5 } })).toBe(
      true,
    );
    expect(evaluate('stats != expected', { stats: { front: 5 }, expected: { front: 6 } })).toBe(
      true,
    );
  });

  test('caps generating helpers instead of exhausting memory', () => {
    expect(() => evaluate('repeat(1, 1000000)')).toThrow();
    expect(() => evaluate('range(0, 1000000000)')).toThrow();
    expect(() => evaluate('range(1000000000, 0, -1)')).toThrow();
    expect(() => evaluate('cartesian(1000, 1000)')).toThrow();
    expect(() => evaluate('concat(repeat(1, 100000), [2])')).toThrow();
    expect(() => evaluate('range(9007199254740992, 9007199254740994, 1)')).toThrow();
    expect(evaluate('len(range(0, 100000))')).toBe(100000);
  });

  test('rejects prototype-chain member reads on objects', () => {
    expect(() => evaluate('stats.__proto__', { stats: { front: 5 } })).toThrow();
    expect(() => evaluate('stats.constructor', { stats: { front: 5 } })).toThrow();
    expect(() => evaluate("stats['toString']", { stats: { front: 5 } })).toThrow();
  });

  test('names the character an expression could not be read past', () => {
    expect(() => evaluate('1 # 2')).toThrow();
    expect(() => evaluate('value @ 2', { value: 1 })).toThrow();
  });

  test('reports a string literal that never closes', () => {
    expect(() => evaluate("'unterminated")).toThrow("Unterminated string literal starting with '");
    expect(() => evaluate('"unterminated')).toThrow();
    // The closing quote is consumed by the escape, so the literal runs off the end.
    expect(() => evaluate("'trailing escape\\")).toThrow();
  });

  test('decodes escape sequences and passes unknown ones through', () => {
    expect(evaluate("'tab\\there'")).toBe('tab\there');
    expect(evaluate("'return\\rhere'")).toBe('return\rhere');
    expect(evaluate("'back\\\\slash'")).toBe('back\\slash');
    expect(evaluate('"quote\\"inside"')).toBe('quote"inside');
    expect(evaluate("'quote\\'inside'")).toBe("quote'inside");
    // Nothing to decode, so the character stands for itself rather than failing.
    expect(evaluate("'literal\\q'")).toBe('literalq');
  });

  test('rejects a modulo by zero the same way division does', () => {
    expect(() => evaluate('5 % 0')).toThrow();
    expect(evaluate('7 % 3')).toBe(1);
  });

  test('indexes strings and rejects the indexes that cannot land', () => {
    expect(evaluate('name[0]', { name: 'alpha' })).toBe('a');
    expect(() => evaluate('name[5]', { name: 'alpha' })).toThrow();
    expect(() => evaluate('items[0 - 1]', { items: ['a'] })).toThrow();
    expect(() => evaluate('items[0.5]', { items: ['a'] })).toThrow();
    expect(() => evaluate('count[0]', { count: 5 })).toThrow();
  });

  test('counts down when `range()` is given a negative step', () => {
    expect(evaluate('range(5, 1, -1)')).toEqual([5, 4, 3, 2]);
    expect(evaluate('range(0, 5, -1)')).toEqual([]);
    expect(() => evaluate('range()')).toThrow();
    expect(() => evaluate('range(1, 2, 3, 4)')).toThrow();
  });

  test('concatenates with `+` as soon as either side is text', () => {
    expect(evaluate("'count: ' + 4")).toBe('count: 4');
    expect(evaluate("4 + ' items'")).toBe('4 items');
    expect(evaluate("'value: ' + missing", { missing: undefined })).toBe('value: ');
    expect(evaluate("'value: ' + nothing", { nothing: null })).toBe('value: ');
    expect(evaluate("'stats: ' + stats", { stats: { front: 5 } })).toBe('stats: {"front":5}');
    expect(evaluate("'on: ' + enabled", { enabled: true })).toBe('on: true');
    expect(() => evaluate('enabled + 1', { enabled: true })).toThrow();
  });

  test('refuses to order values that have no order', () => {
    expect(() => evaluate('enabled < 2', { enabled: true })).toThrow();
    expect(() => evaluate('1 >= items', { items: [1] })).toThrow();
    expect(evaluate("'alpha' < 'bravo'")).toBe(true);
  });
});
