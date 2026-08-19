import type { CooperativeYieldController } from '../../async.ts';
import { ensure, YmbError } from '../../errors.ts';
import {
  advanceStringState,
  CHAR_CLOSE_BRACE,
  CHAR_CLOSE_BRACKET,
  CHAR_CLOSE_PAREN,
  CHAR_COMMA,
  CHAR_DOUBLE_QUOTE,
  CHAR_LINE_FEED,
  CHAR_OPEN_BRACE,
  CHAR_OPEN_BRACKET,
  CHAR_OPEN_PAREN,
  CHAR_SINGLE_QUOTE,
  CHAR_SLASH,
  CHAR_SPACE,
  isClosingDelimiter,
  isIdentifierCode,
  isOpeningDelimiter,
  isWhitespaceCode,
  type StringDelimiter,
  startsLineComment,
  toLowerAsciiCode,
} from './chars.ts';

/** Also guards replace outputs, script outputs, and every tracked file YMB reads. */
export function isNdfPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.ndf');
}

const VALIDATION_YIELD_INTERVAL = 4096;

const CHAR_TILDE = 126;
const CHARS_CONTINUING_EXPRESSION = new Set(
  [...'!%&*+-./:<=>?^|~'].map((character) => character.charCodeAt(0)),
);

/**
 * `group` is a closed delimiter or string: an infix operator may continue it, a `(`
 * starts a new entry. `token` is a bare scalar with no closing delimiter, so its end
 * shows only at the whitespace after it -- and a `(` may continue that one, because
 * `TFoo` and its parameter block are routinely written on separate lines.
 */
type CollectionEntryEnd = 'none' | 'token' | 'group';

interface CollectionValidationState {
  pendingSeparator: CollectionEntryEnd;
  /** Start of the bare scalar being read, if any. */
  bareTokenStart: number | undefined;
}

/** Parallel stacks: the collection state belongs to the `[` frame that opened it. */
interface NdfValidationState {
  openDelimiters: number[];
  collections: (CollectionValidationState | undefined)[];
  collection: CollectionValidationState | undefined;
  inString: StringDelimiter | undefined;
  inLineComment: boolean;
}

/**
 * Only a failure needs a line and column, so they are counted from the offset
 * on the way out rather than maintained on every character of the file.
 */
function describePosition(text: string, index: number): string {
  let line = 1;
  let lineStart = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === CHAR_LINE_FEED) {
      line += 1;
      lineStart = cursor + 1;
    }
  }
  return `line ${line}, column ${index - lineStart + 1}`;
}

export function validateNdf(text: string, absolutePath: string): void {
  const state = createNdfValidationState();
  for (let index = 0; index < text.length; index += 1) {
    advanceNdfValidation(state, text, index, absolutePath);
  }
  finalizeNdfValidation(state, absolutePath);
}

export async function validateNdfCooperative(
  text: string,
  absolutePath: string,
  yieldController: CooperativeYieldController,
): Promise<void> {
  const state = createNdfValidationState();
  for (let index = 0; index < text.length; index += 1) {
    if (index % VALIDATION_YIELD_INTERVAL === 0) {
      await yieldController.maybeYield();
    }
    advanceNdfValidation(state, text, index, absolutePath);
  }
  finalizeNdfValidation(state, absolutePath);
}

function createNdfValidationState(): NdfValidationState {
  return {
    openDelimiters: [],
    collections: [],
    collection: undefined,
    inString: undefined,
    inLineComment: false,
  };
}

function advanceNdfValidation(
  state: NdfValidationState,
  text: string,
  index: number,
  absolutePath: string,
): void {
  const code = text.charCodeAt(index);

  if (code === CHAR_LINE_FEED) {
    state.inLineComment = false;
    if (!state.inString && state.collection?.bareTokenStart !== undefined) {
      endBareCollectionToken(state, text, index);
    }
    return;
  }

  if (state.inLineComment) {
    return;
  }

  // Guarding on the character before calling keeps the string and comment
  // helpers off the path taken by the overwhelming majority of characters.
  if (code === CHAR_SLASH && !state.inString && startsLineComment(text, index)) {
    state.inLineComment = true;
    return;
  }

  if (code === CHAR_DOUBLE_QUOTE || code === CHAR_SINGLE_QUOTE) {
    const nextStringState = advanceStringState(state.inString, text, index);
    if (nextStringState !== state.inString) {
      const previousStringState = state.inString;
      if (!previousStringState) {
        // An opening quote begins an entry like any other token, and is the one entry
        // start that never reaches the check below.
        assertCollectionSeparator(state, text, index, code, absolutePath);
      }
      state.inString = nextStringState;
      if (previousStringState && !state.inString) {
        markCollectionEntryComplete(state, 'group');
      }
      return;
    }
  }

  if (state.inString) {
    return;
  }

  const currentCollection = state.collection;
  if (currentCollection) {
    if (code === CHAR_COMMA) {
      currentCollection.pendingSeparator = 'none';
      currentCollection.bareTokenStart = undefined;
      return;
    }
    // Both helpers below open by testing exactly these fields. Most characters
    // of a collection fail both, so testing here saves the call.
    if (code <= CHAR_SPACE || code > 127 ? isWhitespaceCode(code) : false) {
      if (currentCollection.bareTokenStart !== undefined) {
        endBareCollectionToken(state, text, index);
      }
    } else if (code !== CHAR_CLOSE_BRACKET) {
      if (currentCollection.pendingSeparator !== 'none') {
        assertCollectionSeparator(state, text, index, code, absolutePath);
      }
      if (!isOpeningDelimiter(code) && !isClosingDelimiter(code)) {
        currentCollection.bareTokenStart ??= index;
      }
    }
  }

  if (isOpeningDelimiter(code)) {
    state.openDelimiters.push(code);
    const collection =
      code === CHAR_OPEN_BRACKET
        ? { pendingSeparator: 'none' as const, bareTokenStart: undefined }
        : undefined;
    state.collections.push(collection);
    state.collection = collection;
    return;
  }

  if (isClosingDelimiter(code)) {
    const previous = state.openDelimiters.pop();
    state.collections.pop();
    state.collection = state.collections[state.collections.length - 1];
    const matches =
      (previous === CHAR_OPEN_PAREN && code === CHAR_CLOSE_PAREN) ||
      (previous === CHAR_OPEN_BRACKET && code === CHAR_CLOSE_BRACKET) ||
      (previous === CHAR_OPEN_BRACE && code === CHAR_CLOSE_BRACE);

    // `ensure` builds its context eagerly, so the message stays inside the
    // failure branch: this runs once per delimiter in the file.
    if (!matches) {
      throw new YmbError('ParserError', {
        absolutePath,
        reason: `Unbalanced delimiter \`${String.fromCharCode(code)}\` at ${describePosition(text, index)}.`,
        suggestion:
          'Fix the surrounding NDF syntax so parentheses, brackets, and braces are balanced.',
      });
    }

    markCollectionEntryComplete(state, 'group');
  }
}

function finalizeNdfValidation(state: NdfValidationState, absolutePath: string): void {
  ensure(state.openDelimiters.length === 0, 'ParserError', {
    absolutePath,
    reason: 'NDF text ends with unbalanced delimiters.',
    suggestion: 'Fix the surrounding NDF syntax so parentheses, brackets, and braces are balanced.',
  });
}

function markCollectionEntryComplete(state: NdfValidationState, end: CollectionEntryEnd): void {
  const currentCollection = state.collection;
  if (currentCollection) {
    currentCollection.pendingSeparator = end;
    currentCollection.bareTokenStart = undefined;
  }
}

/**
 * An infix operator is a bare token too, and the operand after it belongs to the same
 * entry - `MobilePosition - CameraPosition` is one value, not three.
 */
function endBareCollectionToken(state: NdfValidationState, text: string, index: number): void {
  const currentCollection = state.collection;
  const tokenStart = currentCollection?.bareTokenStart;
  if (currentCollection === undefined || tokenStart === undefined) {
    return;
  }

  currentCollection.bareTokenStart = undefined;
  if (endsCollectionEntry(text, tokenStart, index)) {
    currentCollection.pendingSeparator = 'token';
  }
}

/** The token is read in place: every bare scalar in the file passes through here. */
function endsCollectionEntry(text: string, start: number, end: number): boolean {
  if (end <= start) {
    return false;
  }
  // A token that still ends in an operator is mid-expression, whether the operator
  // stands alone (`Width : float`) or is glued to the name (`HasMaxVision: bool`).
  if (CHARS_CONTINUING_EXPRESSION.has(text.charCodeAt(end - 1))) {
    return false;
  }
  return !isCollectionEntryContinuationWord(text, start, end);
}

function assertCollectionSeparator(
  state: NdfValidationState,
  text: string,
  index: number,
  code: number,
  absolutePath: string,
): void {
  const currentCollection = state.collection;
  if (!currentCollection || currentCollection.pendingSeparator === 'none') {
    return;
  }

  if (continuesCollectionEntry(currentCollection.pendingSeparator, text, index, code)) {
    currentCollection.pendingSeparator = 'none';
    return;
  }
  throw new YmbError('ParserError', {
    absolutePath,
    reason: `Missing collection separator before \`${String.fromCharCode(code)}\` at ${describePosition(text, index)}.`,
    suggestion: 'Add a comma between top-level collection entries so generated NDF stays valid.',
  });
}

function continuesCollectionEntry(
  end: Exclude<CollectionEntryEnd, 'none'>,
  text: string,
  index: number,
  code: number,
): boolean {
  if (startsCollectionExpressionOperatorWord(text, index)) {
    return true;
  }
  if (end === 'group') {
    return CHARS_CONTINUING_EXPRESSION.has(code);
  }
  // `TFoo` on one line and its `(...)` block on the next is one entry, and so is
  // `MAP` followed by its `[...]`. A `~` is not: it opens a reference, which is a
  // new entry rather than an operator continuing the previous one.
  if (isOpeningDelimiter(code)) {
    return true;
  }
  if (startsCollectionEntryChainingWord(text, index)) {
    return true;
  }
  return code !== CHAR_TILDE && CHARS_CONTINUING_EXPRESSION.has(code);
}

// Word-form infix operators continue an expression like the symbolic ones above; vanilla relies on it
// (CommonData/Fx/Bank/@Evaluable.ndf: `sat[length[a - b] div maxDistance]`).
const NDF_OPERATOR_WORDS = ['div', 'mod', 'and', 'or', 'xor', 'in'] as const;

/**
 * Keywords that chain more words into one entry rather than starting a new one, so
 * neither ends an entry nor needs a comma in front of it. Vanilla Fx banks are full
 * of `private parInitialSize is Template_Param_Float( DefaultValue = 10 ),` - four
 * whitespace-separated tokens making up a single collection entry.
 */
const NDF_ENTRY_CHAINING_WORDS = [
  'is',
  'private',
  'public',
  'export',
  'unnamed',
  'template',
  'map',
  'nil',
] as const;

function startsCollectionExpressionOperatorWord(text: string, index: number): boolean {
  return startsAnyWord(text, index, NDF_OPERATOR_WORDS);
}

function startsCollectionEntryChainingWord(text: string, index: number): boolean {
  return startsAnyWord(text, index, NDF_ENTRY_CHAINING_WORDS);
}

function isCollectionEntryContinuationWord(text: string, start: number, end: number): boolean {
  return (
    matchesAnyWord(text, start, end - start, NDF_OPERATOR_WORDS) ||
    matchesAnyWord(text, start, end - start, NDF_ENTRY_CHAINING_WORDS)
  );
}

function startsAnyWord(text: string, index: number, words: readonly string[]): boolean {
  if (index > 0 && isIdentifierCode(text.charCodeAt(index - 1))) {
    return false;
  }
  for (const word of words) {
    if (matchesWord(text, index, word) && !isIdentifierCode(text.charCodeAt(index + word.length))) {
      return true;
    }
  }
  return false;
}

/** Whether exactly `length` characters from `index` spell one of the words. */
function matchesAnyWord(
  text: string,
  index: number,
  length: number,
  words: readonly string[],
): boolean {
  for (const word of words) {
    if (word.length === length && matchesWord(text, index, word)) {
      return true;
    }
  }
  return false;
}

/**
 * Case-insensitive comparison against a lowercase ASCII keyword, read straight
 * out of the file. Every character of every collection in a build reaches this,
 * so it neither allocates a run of the text nor closes over anything.
 */
function matchesWord(text: string, index: number, word: string): boolean {
  for (let offset = 0; offset < word.length; offset += 1) {
    if (toLowerAsciiCode(text.charCodeAt(index + offset)) !== word.charCodeAt(offset)) {
      return false;
    }
  }
  return true;
}
