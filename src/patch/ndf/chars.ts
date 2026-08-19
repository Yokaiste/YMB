/**
 * Character primitives the rest of the package is built on, so this module imports
 * none of it back. Every walk reads through `charCodeAt`: indexing with `text[i]`
 * allocates a one-character string per position.
 */

export type StringDelimiter = '"' | "'";

export const CHAR_TAB = 9;
export const CHAR_LINE_FEED = 10;
export const CHAR_CARRIAGE_RETURN = 13;
export const CHAR_SPACE = 32;
export const CHAR_DOUBLE_QUOTE = 34;
export const CHAR_SINGLE_QUOTE = 39;
export const CHAR_OPEN_PAREN = 40;
export const CHAR_CLOSE_PAREN = 41;
export const CHAR_COMMA = 44;
export const CHAR_SLASH = 47;
export const CHAR_OPEN_BRACKET = 91;
const CHAR_BACKSLASH = 92;
export const CHAR_CLOSE_BRACKET = 93;
const CHAR_UNDERSCORE = 95;
export const CHAR_OPEN_BRACE = 123;
export const CHAR_CLOSE_BRACE = 125;

export function isOpeningDelimiter(code: number): boolean {
  return code === CHAR_OPEN_PAREN || code === CHAR_OPEN_BRACKET || code === CHAR_OPEN_BRACE;
}

export function isClosingDelimiter(code: number): boolean {
  return code === CHAR_CLOSE_PAREN || code === CHAR_CLOSE_BRACKET || code === CHAR_CLOSE_BRACE;
}

const NON_ASCII_WHITESPACE = /\s/;

/** Matches `/\s/` exactly, taking the ASCII fast path first. */
export function isWhitespaceCode(code: number): boolean {
  if (code === CHAR_SPACE || (code >= CHAR_TAB && code <= CHAR_CARRIAGE_RETURN)) {
    return true;
  }
  return code > 127 && NON_ASCII_WHITESPACE.test(String.fromCharCode(code));
}

/** `toLowerCase` answers the same but allocates a lowered copy per token of the file. */
export function toLowerAsciiCode(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

export function isIdentifierCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === CHAR_UNDERSCORE
  );
}

/** Only an odd run of backslashes escapes the character after it. */
function isEscapedCharacter(text: string, index: number): boolean {
  let backslashCount = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && text.charCodeAt(cursor) === CHAR_BACKSLASH;
    cursor -= 1
  ) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

export function startsLineComment(text: string, index: number): boolean {
  return text.charCodeAt(index) === CHAR_SLASH && text.charCodeAt(index + 1) === CHAR_SLASH;
}

export function advanceStringState(
  current: StringDelimiter | undefined,
  text: string,
  index: number,
): StringDelimiter | undefined {
  const code = text.charCodeAt(index);
  if (code !== CHAR_DOUBLE_QUOTE && code !== CHAR_SINGLE_QUOTE) {
    return current;
  }

  const delimiter = code === CHAR_DOUBLE_QUOTE ? '"' : "'";
  if (!current) {
    return delimiter;
  }

  return current === delimiter && !isEscapedCharacter(text, index) ? undefined : current;
}

interface NdfLexicalState {
  inString: StringDelimiter | undefined;
  inLineComment: boolean;
}

type NdfLexicalCharacter = 'code' | 'line-feed' | 'comment-start' | 'ignored';

export function createNdfLexicalState(): NdfLexicalState {
  return { inString: undefined, inLineComment: false };
}

/** Advance the shared string/comment state and classify this character for a code walk. */
export function advanceNdfLexicalState(
  state: NdfLexicalState,
  text: string,
  index: number,
): NdfLexicalCharacter {
  if (text.charCodeAt(index) === CHAR_LINE_FEED) {
    state.inLineComment = false;
    return 'line-feed';
  }
  if (state.inLineComment) return 'ignored';
  if (!state.inString && startsLineComment(text, index)) {
    state.inLineComment = true;
    return 'comment-start';
  }

  const nextString = advanceStringState(state.inString, text, index);
  if (nextString !== state.inString) {
    state.inString = nextString;
    return 'ignored';
  }
  return state.inString ? 'ignored' : 'code';
}
