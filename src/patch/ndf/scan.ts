import { ensure } from '../../errors.ts';
import {
  advanceNdfLexicalState,
  CHAR_CARRIAGE_RETURN,
  CHAR_COMMA,
  CHAR_LINE_FEED,
  CHAR_SPACE,
  CHAR_TAB,
  createNdfLexicalState,
  isClosingDelimiter,
  isIdentifierCode,
  isOpeningDelimiter,
  isWhitespaceCode,
  startsLineComment,
} from './chars.ts';
import { ensureFound, type PatchErrorIdentity, type TopLevelBlock } from './shared.ts';

export interface CollectionEntryRange {
  start: number;
  end: number;
  separatorStart: number;
  separatorEnd: number;
  text: string;
  typeName?: string;
}

/** Split a dotted selector path without splitting nested field selectors in `[...]`. */
export function splitNdfPath(path: string): string[] {
  const segments: string[] = [];
  let current = '';
  let collectionSelectorDepth = 0;

  for (const character of path) {
    if (character === '[') {
      collectionSelectorDepth += 1;
      current += character;
      continue;
    }

    if (character === ']') {
      collectionSelectorDepth = Math.max(0, collectionSelectorDepth - 1);
      current += character;
      continue;
    }

    if (character === '.' && collectionSelectorDepth === 0) {
      const segment = current.trim();
      if (segment.length > 0) segments.push(segment);
      current = '';
      continue;
    }

    current += character;
  }

  const finalSegment = current.trim();
  if (finalSegment.length > 0) segments.push(finalSegment);
  return segments;
}

export function findNamedBlockByName(text: string, exportName: string): TopLevelBlock | undefined {
  // One indexed scan answers this lookup and every later one on the same text.
  const indexed = findTopLevelBlocks(text).find((block) => block.name === exportName);
  if (indexed) {
    return indexed;
  }

  // Every declaration form the index does not cover spells the name out, so a file
  // without it anywhere holds none of them -- and the question is usually asked about
  // a name that is absent.
  if (!text.includes(exportName)) {
    return undefined;
  }

  return (
    findTemplateBlockByName(text, exportName) ??
    findBareNamedCollectionBlock(text, exportName) ??
    findBareNamedScalarBlock(text, exportName)
  );
}

const BLOCK_INDEX_CAPACITY = 8;

interface TopLevelBlockIndexEntry {
  text: string;
  blocks: readonly TopLevelBlock[];
}

/**
 * Scanned files, most recently used last. A list compared with `===` rather than a
 * Map: hashing the key reads all 58 MB of it, while `===` starts from the pointer
 * identity a caller carrying its text forward already has.
 */
const topLevelBlockIndex: TopLevelBlockIndexEntry[] = [];

function findTopLevelBlockIndexEntry(text: string): number {
  for (let index = topLevelBlockIndex.length - 1; index >= 0; index -= 1) {
    if (topLevelBlockIndex[index]?.text === text) {
      return index;
    }
  }
  return -1;
}

export function forgetTopLevelBlockIndex(text: string): void {
  const index = findTopLevelBlockIndexEntry(text);
  if (index !== -1) {
    topLevelBlockIndex.splice(index, 1);
  }
}

export function findTopLevelBlocks(text: string): readonly TopLevelBlock[] {
  const cachedIndex = findTopLevelBlockIndexEntry(text);
  const cached = topLevelBlockIndex[cachedIndex];
  if (cached) {
    topLevelBlockIndex.splice(cachedIndex, 1);
    topLevelBlockIndex.push(cached);
    return cached.blocks;
  }

  const blocks = scanTopLevelBlocks(text);
  registerTopLevelBlockIndex(text, blocks);
  return blocks;
}

/** For a buffer that already carried its block list across a run of edits. */
export function registerTopLevelBlockIndex(text: string, blocks: readonly TopLevelBlock[]): void {
  forgetTopLevelBlockIndex(text);
  if (topLevelBlockIndex.length >= BLOCK_INDEX_CAPACITY) {
    topLevelBlockIndex.shift();
  }
  topLevelBlockIndex.push({ text, blocks });
}

/** Test seam: the scan index is process-global and keyed by whole file text. */
export function getNdfScanCacheStatsForTests(): { entries: number; retainedChars: number } {
  let retainedChars = 0;
  for (const entry of topLevelBlockIndex) {
    retainedChars += entry.text.length;
  }
  return { entries: topLevelBlockIndex.length, retainedChars };
}

export function resetNdfScanCachesForTests(): void {
  topLevelBlockIndex.length = 0;
}

function skipInsignificant(text: string, fromIndex: number): number {
  let index = fromIndex;
  let inLineComment = false;
  for (; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === CHAR_LINE_FEED) {
      inLineComment = false;
      continue;
    }
    if (inLineComment) {
      continue;
    }
    if (startsLineComment(text, index)) {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (code === CHAR_SPACE || code === CHAR_TAB || code === CHAR_CARRIAGE_RETURN) {
      continue;
    }
    break;
  }
  return index;
}

function readTopLevelBlockHeader(
  text: string,
  fromIndex: number,
): { typeName: string; opener: { index: number; character: '(' | '[' } } | undefined {
  const typeStart = skipInsignificant(text, fromIndex);
  let index = typeStart;
  while (isIdentifierCode(text.charCodeAt(index))) {
    index += 1;
  }
  const typeName = text.slice(typeStart, index);
  const openerIndex = skipInsignificant(text, index);
  const character = text[openerIndex];
  return character === '(' || character === '['
    ? { typeName, opener: { index: openerIndex, character } }
    : undefined;
}

const TOP_LEVEL_HEADER_PATTERN =
  /(?:export\s+)?(?:private\s+)?(?:([A-Za-z0-9_]+)\s+is\b|unnamed\b)/g;

/**
 * One pass: depth is tracked only between blocks, and a resolved header's body is
 * read by `findMatchingDelimiter`, so no character is examined twice.
 */
export function scanTopLevelBlocks(text: string): TopLevelBlock[] {
  const blocks: TopLevelBlock[] = [];
  const headerPattern = new RegExp(TOP_LEVEL_HEADER_PATTERN.source, 'g');
  let match = headerPattern.exec(text);
  let depth = 0;
  const lexicalState = createNdfLexicalState();

  for (let index = 0; index < text.length && match; index += 1) {
    while (match && match.index < index) {
      match = headerPattern.exec(text);
    }
    if (!match) break;

    if (
      match.index === index &&
      depth === 0 &&
      !lexicalState.inString &&
      !lexicalState.inLineComment
    ) {
      const block = readTopLevelBlock(text, index, match[0].length, match[1]);
      if (block) {
        blocks.push(block);
        // The body is balanced, so the walk resumes outside it with the state it
        // had going in.
        index = block.end - 1;
        headerPattern.lastIndex = block.end;
        match = headerPattern.exec(text);
        continue;
      }
    }

    const code = text.charCodeAt(index);
    const lexicalCharacter = advanceNdfLexicalState(lexicalState, text, index);
    if (lexicalCharacter === 'comment-start') index += 1;
    if (lexicalCharacter !== 'code') continue;
    if (isOpeningDelimiter(code)) {
      depth += 1;
    } else if (isClosingDelimiter(code)) {
      depth -= 1;
    }
  }

  return blocks;
}

function readTopLevelBlock(
  text: string,
  start: number,
  headerLength: number,
  name: string | undefined,
): TopLevelBlock | undefined {
  const header = readTopLevelBlockHeader(text, start + headerLength);
  if (!header || header.typeName.length === 0) {
    return undefined;
  }

  const end = findMatchingDelimiter(
    text,
    header.opener.index,
    header.opener.character,
    header.opener.character === '(' ? ')' : ']',
  );
  if (end === -1) {
    return undefined;
  }

  return name
    ? { name, typeName: header.typeName, start, end: end + 1, text: text.slice(start, end + 1) }
    : { typeName: header.typeName, start, end: end + 1, text: text.slice(start, end + 1) };
}

/**
 * Whether an offset is at file top level: depth zero, not inside a string or a line
 * comment. The readers below find their block with a line-anchored regex, which
 * cannot tell a nested declaration written flush against the margin from a real one.
 * Runs only once a regex has matched, and one tracker serves a run of candidates.
 */
function createTopLevelOffsetTracker(text: string): (index: number) => boolean {
  let cursor = 0;
  let depth = 0;
  const lexicalState = createNdfLexicalState();

  return (index: number): boolean => {
    for (; cursor < index; cursor += 1) {
      const code = text.charCodeAt(cursor);
      const lexicalCharacter = advanceNdfLexicalState(lexicalState, text, cursor);
      if (lexicalCharacter === 'comment-start') cursor += 1;
      if (lexicalCharacter !== 'code') continue;
      if (isOpeningDelimiter(code)) {
        depth += 1;
      } else if (isClosingDelimiter(code)) {
        depth -= 1;
      }
    }

    return depth === 0 && !lexicalState.inString && !lexicalState.inLineComment;
  };
}

function isTopLevelOffset(text: string, index: number): boolean {
  return createTopLevelOffsetTracker(text)(index);
}

function findBareNamedCollectionBlock(text: string, name: string): TopLevelBlock | undefined {
  const match = findFirstTopLevelMatch(
    text,
    new RegExp(`^${RegExp.escape(name)}\\s+is\\s*$`, 'gm'),
  );
  if (!match || match.index === undefined) {
    return undefined;
  }

  const openIndex = findNextSignificantIndex(text, match.index + match[0].length);
  if (openIndex === undefined || text[openIndex] !== '[') {
    return undefined;
  }

  const end = findMatchingDelimiter(text, openIndex, '[', ']');
  // An unclosed `[` is not a block. Without this the range comes back as
  // `end: 0` with `start` past it, and a caller replacing that range writes the
  // replacement over the file's head and appends the whole file after it.
  if (end === -1) {
    return undefined;
  }

  return {
    name,
    typeName: '',
    start: match.index,
    end: end + 1,
    text: text.slice(match.index, end + 1),
  };
}

/**
 * `template Name [ parameters ] is TypeName ( body )`, however the file wraps it.
 * Vanilla puts the parameter list and the body opener on either line, so the header
 * is read token by token rather than pinned to line boundaries.
 */
function findTemplateBlockByName(text: string, name: string): TopLevelBlock | undefined {
  return scanTemplateBlocks(text, name)[0];
}

/**
 * Templates stay out of `findTopLevelBlocks`, whose order `@<index>` selectors
 * count, but a caller asking which names a snippet declares needs them.
 */
export function findTemplateBlocks(text: string): TopLevelBlock[] {
  return scanTemplateBlocks(text);
}

const TEMPLATE_HEADER_PATTERN =
  /^[ \t]*(?:export[ \t]+)?(?:private[ \t]+)?template[ \t]+([A-Za-z0-9_]+)\b/gm;

function scanTemplateBlocks(text: string, wantedName?: string): TopLevelBlock[] {
  const blocks: TopLevelBlock[] = [];
  const pattern = new RegExp(TEMPLATE_HEADER_PATTERN.source, 'gm');
  const isTopLevel = createTopLevelOffsetTracker(text);

  for (const match of text.matchAll(pattern)) {
    const name = match[1];
    if (match.index === undefined || name === undefined) {
      continue;
    }
    if (wantedName !== undefined && name !== wantedName) {
      continue;
    }

    const start = match.index + (match[0].length - match[0].trimStart().length);
    // Keep looking rather than giving up: a name nested inside one block may
    // still be declared at the top level further down the file.
    if (!isTopLevel(start)) {
      continue;
    }
    const end = readTemplateBodyEnd(text, match.index + match[0].length);
    if (end === undefined) {
      continue;
    }

    blocks.push({ name, typeName: 'template', start, end, text: text.slice(start, end) });
    if (wantedName !== undefined) {
      break;
    }
  }

  return blocks;
}

/** Offset just past the template body that follows the name at `fromIndex`. */
function readTemplateBodyEnd(text: string, fromIndex: number): number | undefined {
  const index = skipInsignificant(text, fromIndex);
  if (text[index] !== '[') {
    return readTemplateValueEnd(text, index);
  }

  const parametersEnd = findMatchingDelimiter(text, index, '[', ']');
  return parametersEnd === -1 ? undefined : readTemplateValueEnd(text, parametersEnd + 1);
}

/** Skips an optional `is TypeName` and reads the `( ... )` or `[ ... ]` after it. */
function readTemplateValueEnd(text: string, fromIndex: number): number | undefined {
  let index = skipInsignificant(text, fromIndex);
  if (text.startsWith('is', index) && !isIdentifierCode(text.charCodeAt(index + 2))) {
    index = skipInsignificant(text, index + 2);
    while (isIdentifierCode(text.charCodeAt(index))) {
      index += 1;
    }
    index = skipInsignificant(text, index);
  }

  const character = text[index];
  if (character !== '(' && character !== '[') {
    return undefined;
  }
  const end = findMatchingDelimiter(text, index, character, character === '(' ? ')' : ']');
  return end === -1 ? undefined : end + 1;
}

/**
 * `Name is <value>`, all on one line. Separators are spaces and tabs, not `\s`:
 * spanning line breaks let a scalar match swallow the `[` opening the block below.
 */
function findBareNamedScalarBlock(text: string, name: string): TopLevelBlock | undefined {
  const pattern = new RegExp(
    `^(?:export[ \\t]+)?(?:private[ \\t]+)?${RegExp.escape(name)}[ \\t]+is(?:[ \\t]+.+)?$`,
    'gm',
  );

  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    // Keep looking rather than giving up: a name nested inside one block may
    // still be declared at the top level further down the file.
    if (start === undefined || !isTopLevelOffset(text, start)) {
      continue;
    }

    const end = start + match[0].length;
    const nextIndex = findNextSignificantIndex(text, end);
    if (nextIndex !== undefined && (text[nextIndex] === '(' || text[nextIndex] === '[')) {
      continue;
    }

    return {
      name,
      typeName: '',
      start,
      end,
      text: text.slice(start, end),
    };
  }

  return undefined;
}

function findFirstTopLevelMatch(text: string, pattern: RegExp): RegExpMatchArray | undefined {
  const isTopLevel = createTopLevelOffsetTracker(text);
  for (const match of text.matchAll(pattern)) {
    if (match.index !== undefined && isTopLevel(match.index)) {
      return match;
    }
  }
  return undefined;
}

function findNextSignificantIndex(text: string, fromIndex: number): number | undefined {
  const index = skipInsignificant(text, fromIndex);
  return index < text.length ? index : undefined;
}

export function findMatchingDelimiter(
  text: string,
  startIndex: number,
  openChar: string,
  closeChar: string,
): number {
  const openCode = openChar.charCodeAt(0);
  const closeCode = closeChar.charCodeAt(0);
  let depth = 0;
  const lexicalState = createNdfLexicalState();

  for (let index = startIndex; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    const lexicalCharacter = advanceNdfLexicalState(lexicalState, text, index);
    if (lexicalCharacter === 'comment-start') index += 1;
    if (lexicalCharacter !== 'code') continue;

    if (code === openCode) {
      depth += 1;
    } else if (code === closeCode) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

export function findDirectFieldRange(blockText: string, fieldName: string) {
  return findFieldRange(blockText, fieldName, 'direct');
}

export function findNestedFieldRange(blockText: string, fieldName: string) {
  return findFieldRange(blockText, fieldName, 'deep');
}

interface FieldValueRange {
  start: number;
  end: number;
  valueStart: number;
  valueEnd: number;
}

interface FieldMatch extends FieldValueRange {
  name: string;
}

/** `direct` sees only the block's own fields; `deep` also sees nested ones. */
type FieldDepthMode = 'direct' | 'deep';

interface FieldPattern {
  pattern: RegExp;
  /** First characters of the names, to reject a line before running the regex. */
  firstCodes: Set<number>;
}

const FIELD_PATTERN_CACHE_CAPACITY = 64;
const fieldPatternCache = new Map<string, FieldPattern>();

/**
 * Cached: reading 40 fields builds a 40-alternative regex, and a mod doing that per
 * entity builds thousands of identical ones. Stateless, because every caller sets
 * `lastIndex` before exec.
 */
function resolveFieldPattern(fieldNames: readonly string[]): FieldPattern {
  const names = [...fieldNames]
    // Longest first, so `Foo` in the alternation cannot shadow `FooBar`.
    .sort((left, right) => right.length - left.length);
  const cacheKey = names.join('\u0000');
  const cached = fieldPatternCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const resolved: FieldPattern = {
    pattern: new RegExp(`\\s*(${names.map(RegExp.escape).join('|')})\\s*(?:=|is\\b)\\s*`, 'y'),
    firstCodes: new Set(names.map((name) => name.charCodeAt(0))),
  };
  if (fieldPatternCache.size >= FIELD_PATTERN_CACHE_CAPACITY) {
    const oldest = fieldPatternCache.keys().next().value;
    if (oldest !== undefined) fieldPatternCache.delete(oldest);
  }
  fieldPatternCache.set(cacheKey, resolved);
  return resolved;
}

/**
 * One walk for `Name = value` pairs, skipping strings and line comments and tracking
 * depth. `onMatch` returns false to stop. Field values are balanced, so they can be
 * jumped over; pass false to descend into them instead.
 */
function scanFieldMatches(
  blockText: string,
  fieldPattern: FieldPattern,
  mode: FieldDepthMode,
  skipMatchedValue: boolean,
  onMatch: (match: FieldMatch) => boolean,
): void {
  const { pattern, firstCodes } = fieldPattern;
  let depth = 0;
  const lexicalState = createNdfLexicalState();

  for (let index = 0; index < blockText.length; index += 1) {
    const code = blockText.charCodeAt(index);

    const lexicalCharacter = advanceNdfLexicalState(lexicalState, blockText, index);
    if (lexicalCharacter === 'comment-start') index += 1;
    if (lexicalCharacter !== 'code') continue;
    if (isOpeningDelimiter(code)) {
      depth += 1;
      continue;
    }
    if (isClosingDelimiter(code)) {
      depth -= 1;
      continue;
    }
    if (mode === 'direct' ? depth !== 1 : depth < 1) {
      continue;
    }
    // A match may not begin on either half of a CRLF break, or a field reports as
    // starting on the line that opened the body -- and the write goes over the break.
    if (code === CHAR_CARRIAGE_RETURN) {
      continue;
    }

    // A field name starts a line, follows indentation, or opens the body it
    // belongs to - `T(Field = 1)` writes the first field hard against the paren.
    // Anything else is part of a longer token that merely contains the name.
    const previous = blockText.charCodeAt(index - 1);
    if (
      index !== 0 &&
      previous !== CHAR_LINE_FEED &&
      previous !== CHAR_CARRIAGE_RETURN &&
      previous !== CHAR_SPACE &&
      previous !== CHAR_TAB &&
      !isOpeningDelimiter(previous)
    ) {
      continue;
    }

    // The pattern opens with `\s*`, so it can only match a name at the first
    // non-space character from here. Testing that character rejects most lines
    // without running the alternation over them.
    let nameStart = index;
    while (nameStart < blockText.length && isWhitespaceCode(blockText.charCodeAt(nameStart))) {
      nameStart += 1;
    }
    if (!firstCodes.has(blockText.charCodeAt(nameStart))) {
      continue;
    }

    pattern.lastIndex = index;
    const match = pattern.exec(blockText);
    const name = match?.[1];
    if (!match || name === undefined) {
      continue;
    }

    const valueStart = index + match[0].length;
    const valueEnd = findFieldValueEnd(blockText, valueStart);
    if (!onMatch({ name, start: index, end: valueEnd, valueStart, valueEnd })) {
      return;
    }
    if (skipMatchedValue) {
      index = Math.max(index, valueEnd - 1);
    }
  }
}

function toFieldValueRange(match: FieldMatch): FieldValueRange {
  return {
    start: match.start,
    end: match.end,
    valueStart: match.valueStart,
    valueEnd: match.valueEnd,
  };
}

/** Return non-overlapping occurrences of one field at any depth inside a block. */
export function findAllNestedFieldRanges(blockText: string, fieldName: string): FieldValueRange[] {
  const ranges: FieldValueRange[] = [];
  scanFieldMatches(blockText, resolveFieldPattern([fieldName]), 'deep', true, (match) => {
    ranges.push(toFieldValueRange(match));
    return true;
  });
  return ranges;
}

/** Return every MAP tuple value for an exact key at any depth inside a block. */
export function findAllMapEntryRanges(
  blockText: string,
  key: string,
): Array<{ valueStart: number; valueEnd: number }> {
  const ranges: Array<{ valueStart: number; valueEnd: number }> = [];
  const lexicalState = createNdfLexicalState();

  for (let index = 0; index < blockText.length; index += 1) {
    const character = blockText[index];

    const lexicalCharacter = advanceNdfLexicalState(lexicalState, blockText, index);
    if (lexicalCharacter === 'comment-start') index += 1;
    if (lexicalCharacter !== 'code' || character !== '(') continue;

    const keyStart = findNextSignificantIndex(blockText, index + 1);
    if (keyStart === undefined || !blockText.startsWith(key, keyStart)) {
      continue;
    }
    const separatorIndex = findNextSignificantIndex(blockText, keyStart + key.length);
    if (separatorIndex === undefined || blockText[separatorIndex] !== ',') {
      continue;
    }

    const closingIndex = findMatchingDelimiter(blockText, index, '(', ')');
    if (closingIndex < 0) {
      continue;
    }
    ranges.push({ valueStart: separatorIndex + 1, valueEnd: closingIndex });
    index = closingIndex;
  }

  return ranges;
}

export function readDirectFieldValue(blockText: string, fieldName: string): string | undefined {
  const fieldRange = findDirectFieldRange(blockText, fieldName);
  return fieldRange
    ? blockText.slice(fieldRange.valueStart, fieldRange.valueEnd).trim()
    : undefined;
}

export function readNestedFieldValue(blockText: string, fieldName: string): string | undefined {
  const fieldRange = findNestedFieldRange(blockText, fieldName);
  return fieldRange
    ? blockText.slice(fieldRange.valueStart, fieldRange.valueEnd).trim()
    : undefined;
}

export function readDirectFieldValues(
  blockText: string,
  fieldNames: readonly string[],
): Map<string, string> {
  return readFieldValues(blockText, fieldNames, 'direct');
}

export function readNestedFieldValues(
  blockText: string,
  fieldNames: readonly string[],
): Map<string, string> {
  return readFieldValues(blockText, fieldNames, 'deep');
}

function readFieldValues(
  blockText: string,
  fieldNames: readonly string[],
  mode: FieldDepthMode,
): Map<string, string> {
  const remaining = new Set(fieldNames);
  const values = new Map<string, string>();
  if (remaining.size === 0) {
    return values;
  }

  // Deep reads must keep descending into a matched value, because a caller can
  // ask for both an outer field and one nested inside it.
  scanFieldMatches(
    blockText,
    resolveFieldPattern([...remaining]),
    mode,
    mode === 'direct',
    (match) => {
      if (remaining.delete(match.name)) {
        values.set(match.name, blockText.slice(match.valueStart, match.valueEnd).trim());
      }
      return remaining.size > 0;
    },
  );

  return values;
}

function findFieldRange(
  blockText: string,
  fieldName: string,
  mode: FieldDepthMode,
): FieldValueRange | undefined {
  let firstMatch: FieldValueRange | undefined;
  scanFieldMatches(blockText, resolveFieldPattern([fieldName]), mode, false, (match) => {
    firstMatch = toFieldValueRange(match);
    return false;
  });
  return firstMatch;
}

function findFieldValueEnd(text: string, valueStart: number): number {
  let depth = 1;
  const lexicalState = createNdfLexicalState();

  for (let index = valueStart; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    const lexicalCharacter = advanceNdfLexicalState(lexicalState, text, index);
    if (lexicalCharacter === 'line-feed') {
      if (depth === 1) {
        const currentValueText = text.slice(valueStart, index);
        if (
          looksLikeSiblingStart(text, index + 1, currentValueText) ||
          looksLikeContainerBoundaryAfterScalar(text, index + 1, currentValueText)
        ) {
          return index;
        }
      }
      continue;
    }
    if (lexicalCharacter === 'comment-start') index += 1;
    if (lexicalCharacter !== 'code') continue;

    if (isOpeningDelimiter(code)) {
      depth += 1;
    } else if (isClosingDelimiter(code)) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    } else if (depth === 1 && index > valueStart && startsSiblingFieldHere(text, index)) {
      // `T(A = 1 B = 2)` puts the next field on this line. Without this the value
      // of `A` would run to the closing paren and swallow `B`.
      return index;
    }
  }

  return text.length;
}

/** A `Name =` or `Name is` sibling written after this value on the same line. */
function startsSiblingFieldHere(text: string, index: number): boolean {
  const previous = text.charCodeAt(index - 1);
  if (previous !== CHAR_SPACE && previous !== CHAR_TAB) {
    return false;
  }
  SIBLING_FIELD_PATTERN.lastIndex = index;
  return SIBLING_FIELD_PATTERN.test(text);
}

const SIBLING_FIELD_PATTERN = /[A-Za-z_][A-Za-z0-9_]*[ \t]*(?:=[^=]|is[ \t])/y;

function looksLikeSiblingStart(text: string, fromIndex: number, currentValueText: string): boolean {
  const significantLines = readNextSignificantLines(text, fromIndex, 2);
  const firstLine = significantLines[0];
  if (!firstLine) {
    return false;
  }

  if (/^[A-Za-z_][A-Za-z0-9_]*\s*(?:=|is\b)/.test(firstLine)) {
    return true;
  }

  const trimmedValue = currentValueText.trim();
  if (trimmedValue.length === 0 || /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedValue)) {
    return false;
  }

  if (/^[A-Za-z_][A-Za-z0-9_]*\s*[[(]/.test(firstLine)) {
    return true;
  }

  const secondLine = significantLines[1];
  const hasBareIdentifier = /^[A-Za-z_][A-Za-z0-9_]*\s*$/.test(firstLine);
  const nextLineStartsContainer = secondLine !== undefined && /^[[(]/.test(secondLine);
  return hasBareIdentifier && nextLineStartsContainer;
}

function looksLikeContainerBoundaryAfterScalar(
  text: string,
  fromIndex: number,
  currentValueText: string,
): boolean {
  const trimmedValue = currentValueText.trim();
  if (trimmedValue.length === 0) {
    return false;
  }

  const firstLine = readNextSignificantLines(text, fromIndex, 1)[0];
  if (!firstLine) {
    return true;
  }

  if (/^[[(]/.test(firstLine)) {
    return false;
  }

  return /^[)\]}],?/.test(firstLine);
}

function readNextSignificantLines(text: string, fromIndex: number, count: number): string[] {
  const significantLines: string[] = [];
  let lineStart = fromIndex;
  while (lineStart <= text.length && significantLines.length < count) {
    const lineEnd = text.indexOf('\n', lineStart);
    const line = lineEnd === -1 ? text.slice(lineStart) : text.slice(lineStart, lineEnd);
    const trimmed = line.trimStart();
    if (trimmed.length > 0 && !trimmed.startsWith('//')) {
      significantLines.push(trimmed);
    }
    if (lineEnd === -1) {
      break;
    }
    lineStart = lineEnd + 1;
  }
  return significantLines;
}

export function extractFirstParenthesizedRange(value: string) {
  const openIndex = value.indexOf('(');
  if (openIndex === -1) {
    return undefined;
  }

  const closeIndex = findMatchingDelimiter(value, openIndex, '(', ')');
  if (closeIndex === -1) {
    return undefined;
  }

  return { start: openIndex, end: closeIndex + 1 };
}

export function extractFirstCollectionRange(value: string) {
  const openIndex = value.indexOf('[');
  if (openIndex === -1) {
    return undefined;
  }

  const closeIndex = findMatchingDelimiter(value, openIndex, '[', ']');
  if (closeIndex === -1) {
    return undefined;
  }

  return { start: openIndex, end: closeIndex + 1 };
}

export function isCollectionSelectorSegment(segment: string): boolean {
  return segment.startsWith('[') && segment.endsWith(']');
}

export function findCollectionEntryRange(
  collectionText: string,
  selectorSegment: string,
  identity: PatchErrorIdentity,
): CollectionEntryRange {
  const resolution = resolveCollectionEntryBySelector(collectionText, selectorSegment);
  // An index past the end and a selector matching nothing both mean the entry is
  // not in the collection; several matches means the selector cannot say which.
  if (resolution.failure === 'multiple') {
    ensure(resolution.entry, 'SelectorError', {
      ...identity,
      reason: `Collection selector \`${selectorSegment}\` matched multiple entries.`,
      suggestion: 'Use a more specific collection selector that resolves to exactly one entry.',
    });
  }
  ensureFound(resolution.entry, {
    ...identity,
    reason:
      resolution.failure === 'index'
        ? `Collection entry index \`${selectorSegment}\` was not found.`
        : `Collection selector \`${selectorSegment}\` matched no entries.`,
    suggestion:
      resolution.failure === 'index'
        ? 'Use a valid collection entry index or a more stable selector.'
        : 'Use a more specific collection selector that resolves to exactly one entry.',
  });
  return resolution.entry;
}

function resolveCollectionEntryBySelector(
  collectionText: string,
  selectorSegment: string,
): { entry?: CollectionEntryRange; failure?: 'index' | 'none' | 'multiple' } {
  const parsedSelector = parseCollectionSelectorSegment(selectorSegment);
  const entries = findCollectionEntries(collectionText);

  if (parsedSelector.kind === 'index') {
    const entry = entries[parsedSelector.value];
    return entry ? { entry } : { failure: 'index' };
  }

  const matches = entries.filter((entry) => {
    if (parsedSelector.kind === 'type') {
      return entry.typeName !== undefined && parsedSelector.values.includes(entry.typeName);
    }

    // Scalar collection entries (notably NDF references such as ~/Descriptor or
    // $/GFX/Weapon/Descriptor) have no fields or contained type to match.  Treat
    // `value` as their stable identity so patches never need their list position.
    if (parsedSelector.path === 'value') {
      return entry.text.trim() === parsedSelector.value;
    }

    const actualValue = readNestedPathValue(entry.text, splitNdfPath(parsedSelector.path));
    return actualValue?.trim() === parsedSelector.value;
  });

  if (parsedSelector.kind === 'type' && parsedSelector.occurrence !== undefined) {
    const entry = matches[parsedSelector.occurrence];
    return entry ? { entry } : { failure: matches.length === 0 ? 'none' : 'index' };
  }

  const matchedEntry = matches.length === 1 ? matches[0] : undefined;
  return matchedEntry
    ? { entry: matchedEntry }
    : { failure: matches.length === 0 ? 'none' : 'multiple' };
}

function parseCollectionSelectorSegment(
  selectorSegment: string,
):
  | { kind: 'index'; value: number }
  | { kind: 'type'; values: string[]; occurrence?: number }
  | { kind: 'field'; path: string; value: string } {
  const selectorBody = selectorSegment.slice(1, -1).trim();

  if (/^\d+$/.test(selectorBody)) {
    return { kind: 'index', value: Number(selectorBody) };
  }

  if (/^index:\d+$/.test(selectorBody)) {
    return { kind: 'index', value: Number(selectorBody.slice('index:'.length)) };
  }

  const separatorIndex = selectorBody.indexOf('=');
  if (separatorIndex !== -1) {
    return {
      kind: 'field',
      path: selectorBody.slice(0, separatorIndex).trim(),
      value: selectorBody.slice(separatorIndex + 1).trim(),
    };
  }

  const typeBody = selectorBody.startsWith('type:')
    ? selectorBody.slice('type:'.length)
    : selectorBody;
  return parseTypeSelector(typeBody);
}

/** `A|B` spells one entry as a source template or as the class it expands to; `#N` picks among entries a base mod grew. */
function parseTypeSelector(typeBody: string): {
  kind: 'type';
  values: string[];
  occurrence?: number;
} {
  const occurrenceMatch = typeBody.match(/^(.*)#(\d+)$/);
  const values = (occurrenceMatch?.[1] ?? typeBody)
    .split('|')
    .map((typeName) => typeName.trim())
    .filter((typeName) => typeName.length > 0);
  return occurrenceMatch
    ? { kind: 'type', values, occurrence: Number(occurrenceMatch[2]) }
    : { kind: 'type', values };
}

export function findCollectionEntries(collectionText: string): CollectionEntryRange[] {
  const collectionRange = extractFirstCollectionRange(collectionText);
  if (!collectionRange) {
    return [];
  }

  const entries: CollectionEntryRange[] = [];
  const innerStart = collectionRange.start + 1;
  const innerEnd = collectionRange.end - 1;
  let entryStart: number | undefined;
  let depth = 0;
  const lexicalState = createNdfLexicalState();

  for (let index = innerStart; index < innerEnd; index += 1) {
    const code = collectionText.charCodeAt(index);

    const previousStringState = lexicalState.inString;
    const lexicalCharacter = advanceNdfLexicalState(lexicalState, collectionText, index);
    if (lexicalCharacter === 'comment-start') index += 1;
    if (previousStringState || lexicalState.inString) {
      if (entryStart === undefined && lexicalState.inString) {
        entryStart = index;
      }
      continue;
    }
    if (lexicalCharacter !== 'code') continue;

    if (entryStart === undefined && !isWhitespaceCode(code)) {
      entryStart = index;
    }

    if (isOpeningDelimiter(code)) {
      depth += 1;
      continue;
    }

    if (isClosingDelimiter(code)) {
      depth -= 1;
      continue;
    }

    if (entryStart !== undefined && depth === 0 && code === CHAR_COMMA) {
      entries.push(createCollectionEntryRange(collectionText, entryStart, index, index, index + 1));
      entryStart = undefined;
    }
  }

  if (entryStart !== undefined) {
    entries.push(
      createCollectionEntryRange(collectionText, entryStart, innerEnd, innerEnd, innerEnd),
    );
  }

  return entries.filter((entry) => entry.text.length > 0);
}

function createCollectionEntryRange(
  collectionText: string,
  rawStart: number,
  rawEnd: number,
  separatorStart: number,
  separatorEnd: number,
): CollectionEntryRange {
  let start = rawStart;
  let end = rawEnd;

  while (start < end && /\s/.test(collectionText[start] ?? '')) {
    start += 1;
  }

  while (end > start && /\s/.test(collectionText[end - 1] ?? '')) {
    end -= 1;
  }

  const text = collectionText.slice(start, end);
  const typeMatch = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\b/);

  const entryRange: CollectionEntryRange = {
    start,
    end,
    separatorStart,
    separatorEnd,
    text,
  };

  if (typeMatch?.[1]) {
    entryRange.typeName = typeMatch[1];
  }

  return entryRange;
}

export function readNestedPathValue(
  currentValue: string,
  pathSegments: string[],
): string | undefined {
  const [currentSegment, ...remaining] = pathSegments;
  if (!currentSegment) {
    return currentValue.trim();
  }

  if (isCollectionSelectorSegment(currentSegment)) {
    const entry = findCollectionEntryBySelector(currentValue, currentSegment);
    if (!entry) {
      return undefined;
    }
    return remaining.length === 0 ? entry.text.trim() : readNestedPathValue(entry.text, remaining);
  }

  // An empty field value is a value, not a miss, so only a genuine absence stops the walk.
  const fieldValue = readDirectFieldValue(currentValue, currentSegment);
  if (fieldValue === undefined) {
    return undefined;
  }
  if (remaining.length === 0) {
    return fieldValue;
  }

  if (isCollectionSelectorSegment(remaining[0] ?? '')) {
    return readNestedPathValue(fieldValue, remaining);
  }

  const nestedRange = extractFirstParenthesizedRange(fieldValue);
  if (!nestedRange) {
    return undefined;
  }

  return readNestedPathValue(fieldValue.slice(nestedRange.start, nestedRange.end), remaining);
}

function findCollectionEntryBySelector(
  collectionText: string,
  selectorSegment: string,
): CollectionEntryRange | undefined {
  return resolveCollectionEntryBySelector(collectionText, selectorSegment).entry;
}
