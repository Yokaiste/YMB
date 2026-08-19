import { stringifyValue } from './template-expressions/values.ts';
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

/**
 * One reading for `${name}` and `${name + 1}` alike. They used to disagree on the
 * case that matters: the compound form refused an unknown name while the bare form
 * substituted empty text, so a typo wrote an empty NDF value and the build passed.
 */
function resolveVariable(
  name: string,
  variables: Record<string, unknown>,
  resolvingKeys: Set<string>,
): unknown {
  if (!Object.hasOwn(variables, name)) {
    throw new Error(`Unknown template variable "${name}" in expression.`);
  }

  if (resolvingKeys.has(name)) {
    throw new Error(`Circular template variable reference involving "${name}".`);
  }

  const nextResolvingKeys = new Set(resolvingKeys);
  nextResolvingKeys.add(name);
  return resolveTemplateValue(variables[name], variables, nextResolvingKeys);
}

function resolveTemplateExpression(
  expression: string,
  variables: Record<string, unknown>,
  resolvingKeys: Set<string>,
): unknown {
  const trimmedExpression = expression.trim();
  // A bare name is read as a variable rather than parsed, so a variable spelled
  // `true`, `false`, or `null` still resolves to its own value instead of to the
  // literal the expression grammar reserves.
  if (isSimpleTemplateReference(trimmedExpression)) {
    return resolveVariable(trimmedExpression, variables, resolvingKeys);
  }

  return evaluateTemplateExpression(trimmedExpression, (identifier) =>
    resolveVariable(identifier, variables, resolvingKeys),
  );
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

    result += stringifyValue(
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
