import { stringifyValue } from './template-expressions/values.ts';
import { evaluateTemplateExpression, isSimpleTemplateReference } from './template-expressions.ts';

export function resolveTemplateValue(value: unknown, variables: Record<string, unknown>): unknown {
  const active = new Set<string>();
  const sources = new WeakMap<object, object>();

  // Resolve only the member being read. Eagerly resolving its entire parent turns
  // valid sibling references (settings.copy -> settings.base) into false cycles.
  function resolve(nested: unknown, path: string[]): unknown {
    if (nested && typeof nested === 'object') {
      const result = Array.isArray(nested) ? new Array(nested.length) : {};
      sources.set(result, nested);
      for (const [key, item] of Object.entries(nested)) {
        Object.defineProperty(result, key, {
          enumerable: true,
          get: () => resolve(item, [...path, key]),
        });
      }
      return result;
    }
    if (typeof nested !== 'string') return nested;
    const key = JSON.stringify(path);
    if (active.has(key)) {
      throw new Error(
        `Circular template variable reference involving "${path.slice(1).join('.')}".`,
      );
    }
    active.add(key);
    try {
      const exactTemplate = readTemplateSegment(nested, 0);
      return exactTemplate && exactTemplate.nextIndex === nested.length
        ? expression(exactTemplate.expression)
        : replaceTemplateExpressions(nested, (text) => materialize(expression(text)));
    } finally {
      active.delete(key);
    }
  }

  function variable(name: string): unknown {
    if (!Object.hasOwn(variables, name)) {
      throw new Error(`Unknown template variable "${name}" in expression.`);
    }
    return resolve(variables[name], ['variable', name]);
  }

  function expression(text: string): unknown {
    const trimmed = text.trim();
    // Bare names retain support for variables named true, false, or null.
    return isSimpleTemplateReference(trimmed)
      ? variable(trimmed)
      : evaluateTemplateExpression(trimmed, variable);
  }

  // Never expose getters to workers/callers. Also reject object/array containment
  // cycles: a scalar alias can return its own parent without revisiting a scalar.
  function materialize(nested: unknown, ancestors = new Set<object>()): unknown {
    if (!nested || typeof nested !== 'object') return nested;
    const source = sources.get(nested) ?? nested;
    if (ancestors.has(source)) {
      throw new Error('Circular template variable reference involving an object or array.');
    }
    const next = new Set(ancestors).add(source);
    return Array.isArray(nested)
      ? nested.map((item) => materialize(item, next))
      : Object.fromEntries(
          Object.entries(nested).map(([key, item]) => [key, materialize(item, next)]),
        );
  }

  return materialize(resolve(value, ['input']));
}

function replaceTemplateExpressions(
  value: string,
  resolveExpression: (expression: string) => unknown,
): string {
  let result = '';
  let cursor = 0;
  while (cursor < value.length) {
    const templateStart = value.indexOf('${', cursor);
    if (templateStart < 0) {
      result += value.slice(cursor);
      break;
    }
    result += value.slice(cursor, templateStart);
    const segment = readTemplateSegment(value, templateStart);
    if (!segment) {
      result += value.slice(templateStart);
      break;
    }
    result += stringifyValue(resolveExpression(segment.expression));
    cursor = segment.nextIndex;
  }
  return result;
}

function readTemplateSegment(
  value: string,
  startIndex: number,
): { expression: string; nextIndex: number } | undefined {
  if (value[startIndex] !== '$' || value[startIndex + 1] !== '{') {
    return undefined;
  }

  let index = startIndex + 2;
  let quote: '"' | "'" | undefined;

  while (index < value.length) {
    const char = value[index];
    if (!char) {
      break;
    }

    if (quote) {
      if (char === '\\') {
        index += 2;
        continue;
      }

      if (char === quote) {
        quote = undefined;
      }

      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      index += 1;
      continue;
    }

    if (char === '}') {
      return {
        expression: value.slice(startIndex + 2, index),
        nextIndex: index + 1,
      };
    }

    index += 1;
  }

  throw new Error(`Unterminated template expression in "${value}".`);
}
