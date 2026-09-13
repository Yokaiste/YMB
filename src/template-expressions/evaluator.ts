import { applyBinaryOperator } from './binary-operators.ts';
import { invokeExpressionHelper } from './helpers.ts';
import type { ExpressionNode, IdentifierResolver } from './types.ts';
import type { BinaryExpressionNode, CallExpressionNode, MemberExpressionNode } from './values.ts';
import { coerceNumber, isTruthy, readMemberValue } from './values.ts';

export function evaluateExpressionNode(
  node: ExpressionNode,
  resolveIdentifier: IdentifierResolver,
): unknown {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'identifier':
      return resolveIdentifier(node.name);
    case 'array':
      return node.elements.map((element) => evaluateExpressionNode(element, resolveIdentifier));
    case 'unary':
      return evaluateUnaryExpression(node, resolveIdentifier);
    case 'binary':
      return evaluateBinaryExpression(node, resolveIdentifier);
    case 'conditional':
      return evaluateConditionalExpression(node, resolveIdentifier);
    case 'call':
      return evaluateCallExpression(node, resolveIdentifier);
    case 'member':
      return resolveMemberExpression(node, resolveIdentifier);
  }
}

function evaluateBinaryExpression(
  node: BinaryExpressionNode,
  resolveIdentifier: IdentifierResolver,
): unknown {
  switch (node.operator) {
    case '&&':
      return evaluateLogicalAndExpression(node, resolveIdentifier);
    case '||':
      return evaluateLogicalOrExpression(node, resolveIdentifier);
    default:
      return applyBinaryOperator(
        node.operator,
        evaluateExpressionNode(node.left, resolveIdentifier),
        evaluateExpressionNode(node.right, resolveIdentifier),
      );
  }
}

function evaluateCallExpression(
  node: CallExpressionNode,
  resolveIdentifier: IdentifierResolver,
): unknown {
  const args = node.args.map((arg) => evaluateExpressionNode(arg, resolveIdentifier));
  return invokeExpressionHelper(node.callee, args);
}

function resolveMemberExpression(
  node: MemberExpressionNode,
  resolveIdentifier: IdentifierResolver,
): unknown {
  const target = evaluateExpressionNode(node.object, resolveIdentifier);
  const property = evaluateExpressionNode(node.property, resolveIdentifier);
  return readMemberValue(target, property);
}

function evaluateUnaryExpression(
  node: Extract<ExpressionNode, { kind: 'unary' }>,
  resolveIdentifier: IdentifierResolver,
): unknown {
  const value = evaluateExpressionNode(node.argument, resolveIdentifier);
  if (node.operator === '+') {
    return coerceNumber(value, 'operand of unary `+`');
  }
  if (node.operator === '-') {
    return -coerceNumber(value, 'operand of unary `-`');
  }
  return !isTruthy(value);
}

function evaluateConditionalExpression(
  node: Extract<ExpressionNode, { kind: 'conditional' }>,
  resolveIdentifier: IdentifierResolver,
): unknown {
  return isTruthy(evaluateExpressionNode(node.test, resolveIdentifier))
    ? evaluateExpressionNode(node.consequent, resolveIdentifier)
    : evaluateExpressionNode(node.alternate, resolveIdentifier);
}

function evaluateLogicalAndExpression(
  node: BinaryExpressionNode,
  resolveIdentifier: IdentifierResolver,
): unknown {
  const left = evaluateExpressionNode(node.left, resolveIdentifier);
  return isTruthy(left) ? evaluateExpressionNode(node.right, resolveIdentifier) : left;
}

function evaluateLogicalOrExpression(
  node: BinaryExpressionNode,
  resolveIdentifier: IdentifierResolver,
): unknown {
  const left = evaluateExpressionNode(node.left, resolveIdentifier);
  return isTruthy(left) ? left : evaluateExpressionNode(node.right, resolveIdentifier);
}
