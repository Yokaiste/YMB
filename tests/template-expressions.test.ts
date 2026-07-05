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
    expect(() => evaluate('1.')).toThrow('Invalid number literal');
    expect(() => evaluate('items[2]', { items: ['a', 'b'] })).toThrow('out of range');
    expect(() => evaluate('stats.rear', { stats: { front: 5 } })).toThrow('has no property');
  });

  test('throws on invalid math operations and helper usage', () => {
    expect(() => evaluate('5 / 0')).toThrow('cannot divide by 0');
    expect(() => evaluate('join(1, ",")')).toThrow('expected an array');
    expect(() => evaluate("numbers([1, 'bad'])")).toThrow('expected a number');
    expect(() => evaluate('range(0, 3, 0)')).toThrow('step must not be 0');
    expect(() => evaluate('cartesian("bad", [1])')).toThrow(
      'expects an array or non-negative integer',
    );
    expect(() => evaluate('unknownHelper(1)')).toThrow('Unknown expression helper');
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
});
