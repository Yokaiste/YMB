import { isExpressionHelperName } from './helpers.ts';
import { tokenize } from './tokenizer.ts';
import type { BinaryOperator, ExpressionNode, Token, TokenType } from './types.ts';

export class TemplateExpressionParser {
  private readonly tokens: Token[];
  private position = 0;

  constructor(private readonly expression: string) {
    this.tokens = tokenize(expression);
  }

  parse(): ExpressionNode {
    const result = this.parseConditionalExpression();
    this.expect('eof');
    return result;
  }

  private parseConditionalExpression(): ExpressionNode {
    const test = this.parseLogicalOrExpression();
    if (!this.tryConsume('?')) {
      return test;
    }

    const consequent = this.parseConditionalExpression();
    this.expect(':');
    const alternate = this.parseConditionalExpression();
    return { kind: 'conditional', test, consequent, alternate };
  }

  private parseLogicalOrExpression(): ExpressionNode {
    return this.parseBinaryExpression(() => this.parseLogicalAndExpression(), ['||'], 'a logical');
  }

  private parseLogicalAndExpression(): ExpressionNode {
    return this.parseBinaryExpression(() => this.parseEqualityExpression(), ['&&'], 'a logical');
  }

  private parseEqualityExpression(): ExpressionNode {
    return this.parseBinaryExpression(
      () => this.parseComparisonExpression(),
      ['==', '!='],
      'an equality',
    );
  }

  private parseComparisonExpression(): ExpressionNode {
    return this.parseBinaryExpression(
      () => this.parseAdditiveExpression(),
      ['<', '<=', '>', '>='],
      'a comparison',
    );
  }

  private parseAdditiveExpression(): ExpressionNode {
    return this.parseBinaryExpression(
      () => this.parseMultiplicativeExpression(),
      ['+', '-'],
      'an additive',
    );
  }

  private parseMultiplicativeExpression(): ExpressionNode {
    return this.parseBinaryExpression(
      () => this.parseUnaryExpression(),
      ['*', '/', '%'],
      'a multiplicative',
    );
  }

  private parseUnaryExpression(): ExpressionNode {
    if (this.match('+') || this.match('-') || this.match('!')) {
      const operator = this.consume().type;
      if (operator !== '+' && operator !== '-' && operator !== '!') {
        throw this.syntaxError(`Expected a unary operator but found \`${operator}\`.`);
      }
      return {
        kind: 'unary',
        operator,
        argument: this.parseUnaryExpression(),
      };
    }

    return this.parsePostfixExpression();
  }

  private parsePostfixExpression(): ExpressionNode {
    let node = this.parsePrimaryExpression();

    while (true) {
      if (node.kind === 'identifier' && this.tryConsume('(')) {
        node = this.finishCallExpression(node.name);
        continue;
      }

      if (this.tryConsume('[')) {
        const property = this.parseConditionalExpression();
        this.expect(']');
        node = { kind: 'member', object: node, property };
        continue;
      }

      if (this.tryConsume('.')) {
        const propertyToken = this.expect('identifier');
        node = {
          kind: 'member',
          object: node,
          property: { kind: 'literal', value: propertyToken.value ?? '' },
        };
        continue;
      }

      return node;
    }
  }

  private parsePrimaryExpression(): ExpressionNode {
    const token = this.peek();

    if (token.type === 'number') {
      this.consume();
      return { kind: 'literal', value: Number(token.value) };
    }

    if (token.type === 'string') {
      this.consume();
      return { kind: 'literal', value: token.value ?? '' };
    }

    if (token.type === 'identifier') {
      this.consume();
      const identifier = token.value ?? '';
      if (identifier === 'true') {
        return { kind: 'literal', value: true };
      }
      if (identifier === 'false') {
        return { kind: 'literal', value: false };
      }
      if (identifier === 'null') {
        return { kind: 'literal', value: null };
      }
      return { kind: 'identifier', name: identifier };
    }

    if (token.type === '(') {
      this.consume();
      const inner = this.parseConditionalExpression();
      this.expect(')');
      return inner;
    }

    if (token.type === '[') {
      return this.parseArrayLiteral();
    }

    throw this.syntaxError(`Unexpected token \`${token.type}\`.`);
  }

  private finishCallExpression(identifier: string): ExpressionNode {
    const args: ExpressionNode[] = [];
    if (!this.match(')')) {
      do {
        args.push(this.parseConditionalExpression());
      } while (this.tryConsume(','));
    }
    this.expect(')');

    if (!isExpressionHelperName(identifier)) {
      throw this.syntaxError(`Unknown expression helper \`${identifier}()\`.`);
    }

    return { kind: 'call', callee: identifier, args };
  }

  private parseArrayLiteral(): ExpressionNode {
    this.expect('[');
    const elements: ExpressionNode[] = [];
    if (!this.match(']')) {
      do {
        elements.push(this.parseConditionalExpression());
      } while (this.tryConsume(','));
    }
    this.expect(']');
    return { kind: 'array', elements };
  }

  private parseBinaryExpression(
    parseOperand: () => ExpressionNode,
    operators: readonly BinaryOperator[],
    operatorCategory: string,
  ): ExpressionNode {
    let left = parseOperand();

    while (this.matchAny(operators)) {
      const operator = this.consumeOneOf(
        operators,
        `Expected ${operatorCategory} operator but found`,
      );
      left = {
        kind: 'binary',
        operator,
        left,
        right: parseOperand(),
      };
    }

    return left;
  }

  private peek(): Token {
    return this.tokens[this.position] ?? { type: 'eof' };
  }

  private consume(): Token {
    const token = this.peek();
    this.position += 1;
    return token;
  }

  private expect(type: TokenType): Token {
    const token = this.peek();
    if (token.type !== type) {
      throw this.syntaxError(`Expected \`${type}\` but found \`${token.type}\`.`);
    }
    return this.consume();
  }

  private match(type: TokenType): boolean {
    return this.peek().type === type;
  }

  private matchAny(types: readonly TokenType[]): boolean {
    return types.some((type) => this.match(type));
  }

  private tryConsume(type: TokenType): boolean {
    if (!this.match(type)) {
      return false;
    }
    this.consume();
    return true;
  }

  private consumeOneOf<Type extends TokenType>(
    types: readonly Type[],
    expectedMessage: string,
  ): Type {
    const token = this.consume().type;
    if (types.includes(token as Type)) {
      return token as Type;
    }
    throw this.syntaxError(`${expectedMessage} \`${token}\`.`);
  }

  private syntaxError(message: string): Error {
    return new Error(`Invalid template expression "${this.expression}": ${message}`);
  }
}
