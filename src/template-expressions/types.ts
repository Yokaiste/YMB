export type TokenType =
  | 'identifier'
  | 'number'
  | 'string'
  | '('
  | ')'
  | '['
  | ']'
  | ','
  | '.'
  | '?'
  | ':'
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '!'
  | '<'
  | '<='
  | '>'
  | '>='
  | '=='
  | '!='
  | '&&'
  | '||'
  | 'eof';

export interface Token {
  type: TokenType;
  value?: string;
}

export type IdentifierResolver = (name: string) => unknown;

type UnaryOperator = '+' | '-' | '!';

type ArithmeticOperator = '+' | '-' | '*' | '/' | '%';
type ComparisonOperator = '<' | '<=' | '>' | '>=' | '==' | '!=';
type LogicalOperator = '&&' | '||';

export type BinaryOperator = ArithmeticOperator | ComparisonOperator | LogicalOperator;

export type ExpressionNode =
  | { kind: 'literal'; value: unknown }
  | { kind: 'identifier'; name: string }
  | { kind: 'array'; elements: ExpressionNode[] }
  | { kind: 'unary'; operator: UnaryOperator; argument: ExpressionNode }
  | { kind: 'binary'; operator: BinaryOperator; left: ExpressionNode; right: ExpressionNode }
  | {
      kind: 'conditional';
      test: ExpressionNode;
      consequent: ExpressionNode;
      alternate: ExpressionNode;
    }
  | { kind: 'call'; callee: ExpressionHelperName; args: ExpressionNode[] }
  | { kind: 'member'; object: ExpressionNode; property: ExpressionNode };

export type ExpressionHelperName =
  | 'join'
  | 'repeat'
  | 'len'
  | 'concat'
  | 'numbers'
  | 'integers'
  | 'nonNegativeNumbers'
  | 'range'
  | 'sum'
  | 'cartesian';
