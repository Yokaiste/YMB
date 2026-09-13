import type { Token, TokenType } from './types.ts';

const multiCharacterTokenTypes = ['==', '!=', '<=', '>=', '&&', '||'] as const;
const singleCharacterTokenTypes = [
  '(',
  ')',
  '[',
  ']',
  ',',
  '.',
  '?',
  ':',
  '+',
  '-',
  '*',
  '/',
  '%',
  '!',
  '<',
  '>',
] as const;

export function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < expression.length) {
    const nextToken = readNextToken(expression, index);
    if (nextToken) {
      if (nextToken.token) {
        tokens.push(nextToken.token);
      }
      index = nextToken.nextIndex;
      continue;
    }

    const char = expression[index];
    throw new Error(
      `Invalid template expression "${expression}": Unexpected character \`${char}\`.`,
    );
  }

  tokens.push({ type: 'eof' });
  return tokens;
}

function readNextToken(
  expression: string,
  index: number,
): { token?: Token; nextIndex: number } | undefined {
  const char = expression[index];
  if (!char) {
    return undefined;
  }

  if (isWhitespace(char)) {
    return { nextIndex: index + 1 };
  }

  const multiCharacterToken = readMultiCharacterToken(expression, index);
  if (multiCharacterToken) {
    return { token: { type: multiCharacterToken.type }, nextIndex: multiCharacterToken.nextIndex };
  }

  if (isSingleCharacterToken(char)) {
    return { token: { type: char }, nextIndex: index + 1 };
  }

  if (char === '"' || char === "'") {
    const { value, nextIndex } = readStringToken(expression, index, char);
    return { token: { type: 'string', value }, nextIndex };
  }

  if (isDigit(char)) {
    const { value, nextIndex } = readNumberToken(expression, index);
    return { token: { type: 'number', value }, nextIndex };
  }

  if (isIdentifierStart(char)) {
    const { value, nextIndex } = readIdentifierToken(expression, index);
    return { token: { type: 'identifier', value }, nextIndex };
  }

  return undefined;
}

function readMultiCharacterToken(
  expression: string,
  index: number,
):
  | { type: Extract<TokenType, '==' | '!=' | '<=' | '>=' | '&&' | '||'>; nextIndex: number }
  | undefined {
  const nextTwoCharacters = expression.slice(index, index + 2);
  if (isMultiCharacterToken(nextTwoCharacters)) {
    return { type: nextTwoCharacters, nextIndex: index + 2 };
  }
  return undefined;
}

function readStringToken(expression: string, startIndex: number, quote: '"' | "'") {
  let index = startIndex + 1;
  let value = '';

  while (index < expression.length) {
    const char = expression[index];
    if (!char) {
      break;
    }

    if (char === '\\') {
      const escaped = expression[index + 1];
      if (escaped === undefined) {
        throw new Error(
          `Invalid template expression "${expression}": Unterminated escape sequence in string literal.`,
        );
      }
      value += decodeEscapeSequence(escaped);
      index += 2;
      continue;
    }

    if (char === quote) {
      return { value, nextIndex: index + 1 };
    }

    value += char;
    index += 1;
  }

  throw new Error(
    `Invalid template expression "${expression}": Unterminated string literal starting with ${quote}.`,
  );
}

function decodeEscapeSequence(value: string): string {
  switch (value) {
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    case '\\':
      return '\\';
    case '"':
      return '"';
    case "'":
      return "'";
    default:
      return value;
  }
}

function readNumberToken(expression: string, startIndex: number) {
  let index = startIndex;
  while (index < expression.length && isDigit(expression[index] ?? '')) {
    index += 1;
  }

  if (expression[index] === '.') {
    if (!isDigit(expression[index + 1] ?? '')) {
      throw new Error(
        `Invalid template expression "${expression}": Invalid number literal \`${expression.slice(
          startIndex,
          index + 1,
        )}\`.`,
      );
    }

    index += 1;
    while (index < expression.length && isDigit(expression[index] ?? '')) {
      index += 1;
    }
  }

  return { value: expression.slice(startIndex, index), nextIndex: index };
}

function readIdentifierToken(expression: string, startIndex: number) {
  let index = startIndex + 1;
  while (index < expression.length && isIdentifierPart(expression[index] ?? '')) {
    index += 1;
  }
  return { value: expression.slice(startIndex, index), nextIndex: index };
}

function isSingleCharacterToken(
  char: string,
): char is Exclude<
  TokenType,
  'identifier' | 'number' | 'string' | 'eof' | '==' | '!=' | '<=' | '>=' | '&&' | '||'
> {
  return singleCharacterTokenTypes.includes(char as (typeof singleCharacterTokenTypes)[number]);
}

function isMultiCharacterToken(value: string): value is (typeof multiCharacterTokenTypes)[number] {
  return multiCharacterTokenTypes.includes(value as (typeof multiCharacterTokenTypes)[number]);
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function isDigit(char: string): boolean {
  return /[0-9]/.test(char);
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_]/.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char);
}
