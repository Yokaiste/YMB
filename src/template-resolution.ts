import { evaluateTemplateExpression, isSimpleTemplateReference } from './template-expressions.ts';

export function resolveTemplateValue(
  value: unknown,
  variables: Record<string, unknown>,
  resolvingKeys = new Set<string>(),
): unknown {
  if (typeof value === 'string') {
    const exactTemplate = readTemplateSegment(value, 0);
    if (exactTemplate && exactTemplate.nextIndex === value.length) {
      return resolveTemplateExpression(exactTemplate.expression, variables, resolvingKeys);
    }

    return replaceTemplateExpressions(value, variables, resolvingKeys);
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplateValue(item, variables, new Set(resolvingKeys)));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        resolveTemplateValue(nested, variables, new Set(resolvingKeys)),
      ]),
    );
  }

  return value;
}

function resolveVariableReference(
  key: string,
  variables: Record<string, unknown>,
  resolvingKeys: Set<string>,
): unknown {
  if (!(key in variables)) {
    return '';
  }

  if (resolvingKeys.has(key)) {
    throw new Error(`Circular template variable reference involving "${key}".`);
  }

  const nextResolvingKeys = new Set(resolvingKeys);
  nextResolvingKeys.add(key);
  return resolveTemplateValue(variables[key], variables, nextResolvingKeys);
}

function resolveTemplateExpression(
  expression: string,
  variables: Record<string, unknown>,
  resolvingKeys: Set<string>,
): unknown {
  const trimmedExpression = expression.trim();
  if (isSimpleTemplateReference(trimmedExpression)) {
    return resolveVariableReference(trimmedExpression, variables, resolvingKeys);
  }

  return evaluateTemplateExpression(trimmedExpression, (identifier) =>
    resolveExpressionIdentifier(identifier, variables, resolvingKeys),
  );
}

function resolveExpressionIdentifier(
  identifier: string,
  variables: Record<string, unknown>,
  resolvingKeys: Set<string>,
): unknown {
  if (!(identifier in variables)) {
    throw new Error(`Unknown template variable "${identifier}" in expression.`);
  }

  if (resolvingKeys.has(identifier)) {
    throw new Error(`Circular template variable reference involving "${identifier}".`);
  }

  const nextResolvingKeys = new Set(resolvingKeys);
  nextResolvingKeys.add(identifier);
  return resolveTemplateValue(variables[identifier], variables, nextResolvingKeys);
}

function stringifyTemplateResult(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function replaceTemplateExpressions(
  value: string,
  variables: Record<string, unknown>,
  resolvingKeys: Set<string>,
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

    result += stringifyTemplateResult(
      resolveTemplateExpression(segment.expression, variables, resolvingKeys),
    );
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
