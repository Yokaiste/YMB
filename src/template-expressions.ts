import { evaluateExpressionNode } from './template-expressions/evaluator.ts';
import { TemplateExpressionParser } from './template-expressions/parser.ts';
import type { IdentifierResolver } from './template-expressions/types.ts';

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isSimpleTemplateReference(expression: string): boolean {
  return identifierPattern.test(expression.trim());
}

export function evaluateTemplateExpression(
  expression: string,
  resolveIdentifier: IdentifierResolver,
): unknown {
  const parser = new TemplateExpressionParser(expression);
  const ast = parser.parse();
  return evaluateExpressionNode(ast, resolveIdentifier);
}
