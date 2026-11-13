import type { BinaryOperator } from './types.ts';
import {
  assertNever,
  coerceComparable,
  coerceNumber,
  expressionValuesEqual,
  stringifyValue,
} from './values.ts';

type NonLogicalBinaryOperator = Exclude<BinaryOperator, '&&' | '||'>;

export function applyBinaryOperator(
  operator: NonLogicalBinaryOperator,
  left: unknown,
  right: unknown,
): unknown {
  switch (operator) {
    case '+':
      return addExpressionValues(left, right);
    case '-':
      return coerceNumber(left, 'left side of `-`') - coerceNumber(right, 'right side of `-`');
    case '*':
      return coerceNumber(left, 'left side of `*`') * coerceNumber(right, 'right side of `*`');
    case '/':
      return divideExpressionValues(left, right);
    case '%':
      return moduloExpressionValues(left, right);
    case '<':
      return (
        coerceComparable(left, 'left side of `<`') < coerceComparable(right, 'right side of `<`')
      );
    case '<=':
      return (
        coerceComparable(left, 'left side of `<=`') <= coerceComparable(right, 'right side of `<=`')
      );
    case '>':
      return (
        coerceComparable(left, 'left side of `>`') > coerceComparable(right, 'right side of `>`')
      );
    case '>=':
      return (
        coerceComparable(left, 'left side of `>=`') >= coerceComparable(right, 'right side of `>=`')
      );
    case '==':
      return expressionValuesEqual(left, right);
    case '!=':
      return !expressionValuesEqual(left, right);
    default:
      return assertNever(operator);
  }
}

function addExpressionValues(left: unknown, right: unknown): unknown {
  if (typeof left === 'string' || typeof right === 'string') {
    return `${stringifyValue(left)}${stringifyValue(right)}`;
  }
  return coerceNumber(left, 'left side of `+`') + coerceNumber(right, 'right side of `+`');
}

function divideExpressionValues(left: unknown, right: unknown): number {
  const numerator = coerceNumber(left, 'left side of `/`');
  const denominator = coerceNumber(right, 'right side of `/`');
  if (denominator === 0) {
    throw new Error('Template expression cannot divide by 0.');
  }
  return numerator / denominator;
}

function moduloExpressionValues(left: unknown, right: unknown): number {
  const numerator = coerceNumber(left, 'left side of `%`');
  const denominator = coerceNumber(right, 'right side of `%`');
  if (denominator === 0) {
    throw new Error('Template expression cannot apply `%` with a right side of 0.');
  }
  return numerator % denominator;
}
