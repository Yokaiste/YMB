import type { ExpressionHelperName } from './types.ts';
import {
  asInteger,
  asNonNegativeInteger,
  assertNever,
  coerceArray,
  coerceNumber,
  stringifyValue,
} from './values.ts';

const MAX_GENERATED_ITEMS = 100_000;

function assertGeneratedItemCount(count: number, helperLabel: string): void {
  if (count > MAX_GENERATED_ITEMS) {
    throw new Error(
      `\`${helperLabel}\` would generate ${count} items, above the ${MAX_GENERATED_ITEMS} limit.`,
    );
  }
}

const expressionHelpers = {
  join(value: unknown, separator = ','): string {
    const items = coerceArray(value, 'join() value');
    return items.map((entry) => stringifyValue(entry)).join(String(separator));
  },
  repeat(value: unknown, count: unknown): unknown[] {
    const normalizedCount = asNonNegativeInteger(count, 'repeat() count');
    assertGeneratedItemCount(normalizedCount, 'repeat()');
    return Array.from({ length: normalizedCount }, () => value);
  },
  len(value: unknown): number {
    if (typeof value === 'string' || Array.isArray(value)) {
      return value.length;
    }
    if (value && typeof value === 'object') {
      return Object.keys(value).length;
    }
    throw new Error('`len()` expects a string, array, or object.');
  },
  concat(...values: unknown[]): unknown[] {
    return values.flatMap((value, index) => coerceArray(value, `concat() argument ${index + 1}`));
  },
  numbers(value: unknown): number[] {
    return coerceArray(value, 'numbers() value').map((entry, index) =>
      coerceNumber(entry, `numbers() entry ${index + 1}`),
    );
  },
  integers(value: unknown): number[] {
    return coerceArray(value, 'integers() value').flatMap((entry, index) => {
      const normalized = coerceNumber(entry, `integers() entry ${index + 1}`);
      return Number.isInteger(normalized) ? [normalized] : [];
    });
  },
  nonNegativeNumbers(value: unknown): number[] {
    return expressionHelpers.numbers(value).flatMap((entry) => (entry >= 0 ? [entry] : []));
  },
  range(...args: unknown[]): number[] {
    if (args.length < 1 || args.length > 3) {
      throw new Error('`range()` expects 1, 2, or 3 numeric arguments.');
    }

    const [start, end, step] =
      args.length === 1
        ? [0, asInteger(args[0], 'range() end'), 1]
        : args.length === 2
          ? [asInteger(args[0], 'range() start'), asInteger(args[1], 'range() end'), 1]
          : [
              asInteger(args[0], 'range() start'),
              asInteger(args[1], 'range() end'),
              asInteger(args[2], 'range() step'),
            ];

    if (step === 0) {
      throw new Error('`range()` step must not be 0.');
    }
    assertGeneratedItemCount(Math.ceil(Math.max(0, (end - start) / step)), 'range()');

    const values: number[] = [];
    if (step > 0) {
      for (let current = start; current < end; current += step) {
        values.push(current);
      }
      return values;
    }

    for (let current = start; current > end; current += step) {
      values.push(current);
    }
    return values;
  },
  sum(value: unknown): number {
    return coerceArray(value, 'sum() value').reduce<number>(
      (total, entry, index) => total + coerceNumber(entry, `sum() entry ${index + 1}`),
      0,
    );
  },
  cartesian(leftSource: unknown, rightSource: unknown, template = '[{left}, {right}]'): string[] {
    const leftValues = normalizeCartesianSource(leftSource, 'cartesian() left source');
    const rightValues = normalizeCartesianSource(rightSource, 'cartesian() right source');
    assertGeneratedItemCount(leftValues.length * rightValues.length, 'cartesian()');
    const normalizedTemplate = String(template);
    const output: string[] = [];

    let index = 0;
    for (let leftIndex = 0; leftIndex < leftValues.length; leftIndex += 1) {
      const left = leftValues[leftIndex];
      for (let rightIndex = 0; rightIndex < rightValues.length; rightIndex += 1) {
        const right = rightValues[rightIndex];
        output.push(
          normalizedTemplate.replace(
            /\{(left|right|leftIndex|rightIndex|index)\}/g,
            (_match, placeholder: string) => {
              switch (placeholder) {
                case 'left':
                  return stringifyValue(left);
                case 'right':
                  return stringifyValue(right);
                case 'leftIndex':
                  return String(leftIndex);
                case 'rightIndex':
                  return String(rightIndex);
                case 'index':
                  return String(index);
                default:
                  return '';
              }
            },
          ),
        );
        index += 1;
      }
    }

    return output;
  },
} as const satisfies Record<ExpressionHelperName, (...args: unknown[]) => unknown>;

export function isExpressionHelperName(name: string): name is ExpressionHelperName {
  return name in expressionHelpers;
}

export function invokeExpressionHelper(callee: ExpressionHelperName, args: unknown[]): unknown {
  switch (callee) {
    case 'join':
      return expressionHelpers.join(args[0], args[1] as string | undefined);
    case 'repeat':
      return expressionHelpers.repeat(args[0], args[1]);
    case 'len':
      return expressionHelpers.len(args[0]);
    case 'concat':
      return expressionHelpers.concat(...args);
    case 'numbers':
      return expressionHelpers.numbers(args[0]);
    case 'integers':
      return expressionHelpers.integers(args[0]);
    case 'nonNegativeNumbers':
      return expressionHelpers.nonNegativeNumbers(args[0]);
    case 'range':
      return expressionHelpers.range(...args);
    case 'sum':
      return expressionHelpers.sum(args[0]);
    case 'cartesian':
      return expressionHelpers.cartesian(args[0], args[1], args[2] as string | undefined);
    default:
      return assertNever(callee);
  }
}

function normalizeCartesianSource(value: unknown, label: string): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === 'number') {
    return expressionHelpers.range(asNonNegativeInteger(value, label));
  }

  throw new Error(`\`${label}\` expects an array or non-negative integer.`);
}
