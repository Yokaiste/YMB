import { ensure } from '../../errors.ts';
import { escapeRegExp } from '../../text-utils.ts';
import type { PatchApplication } from '../../types.ts';
import {
  advanceStringState,
  type StringDelimiter,
  startsLineComment,
  type TopLevelBlock,
} from './shared.ts';

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
  return (
    findNamedBlockPrimary(text, exportName) ??
    findTemplateBlockByName(text, exportName) ??
    findBareNamedCollectionBlock(text, exportName) ??
    findBareNamedScalarBlock(text, exportName)
  );
}

function findNamedBlockPrimary(text: string, exportName: string): TopLevelBlock | undefined {
  const cached = topLevelBlockIndex.get(text);
  if (cached) {
    return cached.find((block) => block.name === exportName);
  }

  // A single lookup is cheaper unscanned, but repeat lookups on one text must not rescan forever.
  if (rememberEarlyExitScan(text)) {
    return findTopLevelBlocks(text).find((block) => block.name === exportName);
  }
  return findTopLevelBlockByName(text, exportName);
}

const earlyExitScanned = new Set<string>();

function rememberEarlyExitScan(text: string): boolean {
  if (earlyExitScanned.has(text)) {
    return true;
  }
  if (earlyExitScanned.size >= BLOCK_INDEX_CAPACITY) {
    const oldest = earlyExitScanned.values().next().value;
    if (oldest !== undefined) {
      earlyExitScanned.delete(oldest);
    }
  }
  earlyExitScanned.add(text);
  return false;
}

interface TopLevelScanState {
  cursor: number;
  depth: number;
  inString: StringDelimiter | undefined;
}

function advanceTopLevelScanState(text: string, state: TopLevelScanState, stop: number): void {
  let depth = state.depth;
  let inString = state.inString;
  let inLineComment = false;

  for (let index = state.cursor; index < stop; index += 1) {
    const char = text[index];
    if (char === '\n') {
      inLineComment = false;
      continue;
    }
    if (inLineComment) {
      continue;
    }
    if (!inString && startsLineComment(char ?? '', text[index + 1])) {
      inLineComment = true;
      index += 1;
      continue;
    }

    const nextStringState = advanceStringState(inString, text, index);
    if (nextStringState !== inString) {
      inString = nextStringState;
      continue;
    }
    if (inString) {
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
    } else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
    }
  }

  state.cursor = stop;
  state.depth = depth;
  state.inString = inString;
}

function findTopLevelBlockByName(text: string, exportName: string): TopLevelBlock | undefined {
  const headerPattern = new RegExp(
    String.raw`(?:export\s+)?(?:private\s+)?\b${escapeRegExp(exportName)}\s+is\b`,
    'g',
  );
  const state: TopLevelScanState = { cursor: 0, depth: 0, inString: undefined };

  for (const match of text.matchAll(headerPattern)) {
    const start = match.index ?? 0;
    advanceTopLevelScanState(text, state, start);

    if (state.depth !== 0 || state.inString) {
      continue;
    }

    const header = readTopLevelBlockHeader(text, start + match[0].length);
    if (!header || header.typeName.length === 0) {
      continue;
    }

    const end = findMatchingDelimiter(
      text,
      header.opener.index,
      header.opener.character,
      header.opener.character === '(' ? ')' : ']',
    );
    return {
      name: exportName,
      typeName: header.typeName,
      start,
      end: end + 1,
      text: text.slice(start, end + 1),
    };
  }

  return undefined;
}

const BLOCK_INDEX_CAPACITY = 8;

const topLevelBlockIndex = new Map<string, TopLevelBlock[]>();

/**
 * Seed the top-level index before applying a sequence of edits. Subsequent
 * top-level replacements can then carry the index forward without rescanning
 * the complete (potentially very large) NDF file.
 */
export function primeTopLevelBlockIndex(text: string): void {
  findTopLevelBlocks(text);
}

/** Carry a cached top-level index across one complete-block edit. */
export function registerTopLevelTextEdit(
  previousText: string,
  nextText: string,
  start: number,
  end: number,
  replacement: string,
): void {
  const previousBlocks = topLevelBlockIndex.get(previousText);
  if (!previousBlocks || previousText === nextText) {
    return;
  }

  const delta = replacement.length - (end - start);
  const insertedBlocks = scanTopLevelBlocks(replacement).map((block) => ({
    ...block,
    start: block.start + start,
    end: block.end + start,
  }));
  const nextBlocks: TopLevelBlock[] = [];

  for (const block of previousBlocks) {
    // An insertion at a block boundary preserves the existing block. A
    // replacement that overlaps it drops it in favor of the locally rescanned
    // replacement blocks.
    if (block.start < end && block.end > start) {
      continue;
    }
    if (block.start >= end) {
      nextBlocks.push({ ...block, start: block.start + delta, end: block.end + delta });
    } else {
      nextBlocks.push(block);
    }
  }
  nextBlocks.push(...insertedBlocks);
  nextBlocks.sort((left, right) => left.start - right.start);
  rememberTopLevelBlockIndex(nextText, nextBlocks);
}

export function findTopLevelBlocks(text: string): TopLevelBlock[] {
  const cached = topLevelBlockIndex.get(text);
  if (cached) {
    topLevelBlockIndex.delete(text);
    topLevelBlockIndex.set(text, cached);
    return cached;
  }

  const blocks = scanTopLevelBlocks(text);
  rememberTopLevelBlockIndex(text, blocks);
  return blocks;
}

function rememberTopLevelBlockIndex(text: string, blocks: TopLevelBlock[]): void {
  if (topLevelBlockIndex.has(text)) {
    topLevelBlockIndex.delete(text);
  }
  if (topLevelBlockIndex.size >= BLOCK_INDEX_CAPACITY) {
    const oldest = topLevelBlockIndex.keys().next().value;
    if (oldest !== undefined) {
      topLevelBlockIndex.delete(oldest);
    }
  }
  topLevelBlockIndex.set(text, blocks);
}

function skipInsignificant(text: string, fromIndex: number): number {
  let index = fromIndex;
  let inLineComment = false;
  for (; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\n') {
      inLineComment = false;
      continue;
    }
    if (inLineComment) {
      continue;
    }
    if (startsLineComment(character ?? '', text[index + 1])) {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (character === ' ' || character === '\t' || character === '\r') {
      continue;
    }
    break;
  }
  return index;
}

function isIdentifierCharacter(character: string | undefined): boolean {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    character === '_'
  );
}

function readTopLevelBlockHeader(
  text: string,
  fromIndex: number,
): { typeName: string; opener: { index: number; character: '(' | '[' } } | undefined {
  const typeStart = skipInsignificant(text, fromIndex);
  let index = typeStart;
  while (isIdentifierCharacter(text[index])) {
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

function scanTopLevelBlocks(text: string): TopLevelBlock[] {
  const blocks: TopLevelBlock[] = [];
  const matches = [...text.matchAll(TOP_LEVEL_HEADER_PATTERN)];
  const cleanHeaderStarts = collectTopLevelCleanIndexes(
    text,
    matches.map((match) => match.index ?? 0),
  );
  for (const match of matches) {
    const start = match.index ?? 0;
    if (!cleanHeaderStarts.has(start)) {
      continue;
    }
    const name = match[1];
    const header = readTopLevelBlockHeader(text, start + match[0].length);
    if (!header || header.typeName.length === 0) {
      continue;
    }

    const end = findMatchingDelimiter(
      text,
      header.opener.index,
      header.opener.character,
      header.opener.character === '(' ? ')' : ']',
    );
    blocks.push(
      name
        ? {
            name,
            typeName: header.typeName,
            start,
            end: end + 1,
            text: text.slice(start, end + 1),
          }
        : {
            typeName: header.typeName,
            start,
            end: end + 1,
            text: text.slice(start, end + 1),
          },
    );
  }

  return blocks;
}

function collectTopLevelCleanIndexes(text: string, candidateIndexes: number[]): Set<number> {
  const clean = new Set<number>();
  if (candidateIndexes.length === 0) {
    return clean;
  }

  const pending = [...candidateIndexes].sort((left, right) => left - right);
  const lastCandidate = pending.at(-1);
  if (lastCandidate === undefined) return clean;
  let pendingIndex = 0;
  let depth = 0;
  let inString: StringDelimiter | undefined;
  let inLineComment = false;

  for (let index = 0; index <= lastCandidate; index += 1) {
    while (pendingIndex < pending.length && pending[pendingIndex] === index) {
      if (depth === 0 && !inString && !inLineComment) {
        clean.add(index);
      }
      pendingIndex += 1;
    }

    const char = text[index] ?? '';
    const next = text[index + 1];
    if (char === '\n') {
      inLineComment = false;
      continue;
    }
    if (inLineComment) {
      continue;
    }
    if (!inString && startsLineComment(char, next)) {
      inLineComment = true;
      index += 1;
      continue;
    }
    const nextStringState = advanceStringState(inString, text, index);
    if (nextStringState !== inString) {
      inString = nextStringState;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
    }
  }

  return clean;
}

function findBareNamedCollectionBlock(text: string, name: string): TopLevelBlock | undefined {
  const match = new RegExp(`^${escapeRegExp(name)}\\s+is\\s*$`, 'm').exec(text);
  if (!match || match.index === undefined) {
    return undefined;
  }

  const openIndex = text.indexOf('[', match.index + match[0].length);
  if (openIndex === -1) {
    return undefined;
  }

  const end = findMatchingDelimiter(text, openIndex, '[', ']');
  return {
    name,
    typeName: '',
    start: match.index,
    end: end + 1,
    text: text.slice(match.index, end + 1),
  };
}

function findTemplateBlockByName(text: string, name: string): TopLevelBlock | undefined {
  const match = new RegExp(
    `^(?:export\\s+)?(?:private\\s+)?template\\s+${escapeRegExp(name)}\\s*$`,
    'm',
  ).exec(text);
  if (!match || match.index === undefined) {
    return undefined;
  }

  const parametersStart = findNextSignificantIndex(text, match.index + match[0].length);
  if (parametersStart === undefined || text[parametersStart] !== '[') {
    return undefined;
  }

  const parametersEnd = findMatchingDelimiter(text, parametersStart, '[', ']');
  if (parametersEnd === -1) {
    return undefined;
  }

  const headerEnd = text.indexOf('\n', parametersEnd + 1);
  if (headerEnd === -1) {
    return undefined;
  }

  const opener = findNextTopLevelOpener(text, headerEnd + 1);
  if (!opener) {
    return undefined;
  }

  const end = findMatchingDelimiter(
    text,
    opener.index,
    opener.character,
    opener.character === '(' ? ')' : ']',
  );
  if (end === -1) {
    return undefined;
  }

  return {
    name,
    typeName: 'template',
    start: match.index,
    end: end + 1,
    text: text.slice(match.index, end + 1),
  };
}

function findBareNamedScalarBlock(text: string, name: string): TopLevelBlock | undefined {
  const pattern = new RegExp(
    `^(?:export\\s+)?(?:private\\s+)?${escapeRegExp(name)}\\s+is(?:\\s+.+)?$`,
    'gm',
  );

  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start === undefined) {
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

function findNextTopLevelOpener(
  text: string,
  fromIndex: number,
): { index: number; character: '(' | '[' } | undefined {
  let inLineComment = false;

  for (let index = fromIndex; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '\n') {
      inLineComment = false;
      continue;
    }

    if (inLineComment) {
      continue;
    }

    if (startsLineComment(char ?? '', next)) {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === '(' || char === '[') {
      return { index, character: char };
    }

    if (char !== ' ' && char !== '\t' && char !== '\r') {
      return undefined;
    }
  }

  return undefined;
}

function findNextSignificantIndex(text: string, fromIndex: number): number | undefined {
  let inLineComment = false;

  for (let index = fromIndex; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '\n') {
      inLineComment = false;
      continue;
    }

    if (inLineComment) {
      continue;
    }

    if (startsLineComment(char ?? '', next)) {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === ' ' || char === '\t' || char === '\r') {
      continue;
    }

    return index;
  }

  return undefined;
}

export function findMatchingDelimiter(
  text: string,
  startIndex: number,
  openChar: string,
  closeChar: string,
): number {
  let depth = 0;
  let inString: StringDelimiter | undefined;
  let inLineComment = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '\n') {
      inLineComment = false;
      continue;
    }

    if (inLineComment) {
      continue;
    }

    if (!inString && startsLineComment(char ?? '', next)) {
      inLineComment = true;
      index += 1;
      continue;
    }

    const nextStringState = advanceStringState(inString, text, index);
    if (nextStringState !== inString) {
      inString = nextStringState;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === openChar) {
      depth += 1;
    } else if (char === closeChar) {
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

export interface FieldValueRange {
  start: number;
  end: number;
  valueStart: number;
  valueEnd: number;
}

/** Return non-overlapping occurrences of one field at any depth inside a block. */
export function findAllNestedFieldRanges(blockText: string, fieldName: string): FieldValueRange[] {
  const ranges: FieldValueRange[] = [];
  const fieldPattern = new RegExp(`\\s*(${escapeRegExp(fieldName)})\\s*(?:=|is\\b)\\s*`, 'y');
  let depth = 0;
  let inString: StringDelimiter | undefined;
  let inLineComment = false;

  for (let index = 0; index < blockText.length; index += 1) {
    const character = blockText[index];
    const next = blockText[index + 1];

    if (character === '\n') {
      inLineComment = false;
      continue;
    }
    if (inLineComment) {
      continue;
    }
    if (!inString && startsLineComment(character ?? '', next)) {
      inLineComment = true;
      index += 1;
      continue;
    }

    const nextStringState = advanceStringState(inString, blockText, index);
    if (nextStringState !== inString) {
      inString = nextStringState;
      continue;
    }
    if (inString) {
      continue;
    }
    if (character === '(' || character === '[' || character === '{') {
      depth += 1;
      continue;
    }
    if (character === ')' || character === ']' || character === '}') {
      depth -= 1;
      continue;
    }
    if (depth < 1) {
      continue;
    }

    const startsField =
      index === 0 || blockText[index - 1] === '\n' || /[ \t]/.test(blockText[index - 1] ?? '');
    if (!startsField) {
      continue;
    }

    fieldPattern.lastIndex = index;
    const match = fieldPattern.exec(blockText);
    if (!match) {
      continue;
    }

    const valueStart = index + match[0].length;
    const valueEnd = findFieldValueEnd(blockText, valueStart);
    ranges.push({ start: index, end: valueEnd, valueStart, valueEnd });
    index = Math.max(index, valueEnd - 1);
  }

  return ranges;
}

/** Return every MAP tuple value for an exact key at any depth inside a block. */
export function findAllMapEntryRanges(
  blockText: string,
  key: string,
): Array<{ valueStart: number; valueEnd: number }> {
  const ranges: Array<{ valueStart: number; valueEnd: number }> = [];
  let inString: StringDelimiter | undefined;
  let inLineComment = false;

  for (let index = 0; index < blockText.length; index += 1) {
    const character = blockText[index];
    const next = blockText[index + 1];

    if (character === '\n') {
      inLineComment = false;
      continue;
    }
    if (inLineComment) {
      continue;
    }
    if (!inString && startsLineComment(character ?? '', next)) {
      inLineComment = true;
      index += 1;
      continue;
    }

    const nextStringState = advanceStringState(inString, blockText, index);
    if (nextStringState !== inString) {
      inString = nextStringState;
      continue;
    }
    if (inString || character !== '(') {
      continue;
    }

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

export interface TopLevelBlockRewrite {
  block: TopLevelBlock;
  text: string;
}

/** Apply many complete-block rewrites with one string rebuild and preserve the scan index. */
export function applyTopLevelBlockRewrites(text: string, rewrites: TopLevelBlockRewrite[]): string {
  if (rewrites.length === 0) {
    return text;
  }

  const rewriteByStart = new Map(rewrites.map((rewrite) => [rewrite.block.start, rewrite]));
  const parts: string[] = [];
  const nextBlocks: TopLevelBlock[] = [];
  let cursor = 0;
  let delta = 0;

  for (const block of findTopLevelBlocks(text)) {
    const rewrite = rewriteByStart.get(block.start);
    if (!rewrite) {
      nextBlocks.push({ ...block, start: block.start + delta, end: block.end + delta });
      continue;
    }

    parts.push(text.slice(cursor, block.start), rewrite.text);
    cursor = block.end;
    const start = block.start + delta;
    nextBlocks.push({ ...block, start, end: start + rewrite.text.length, text: rewrite.text });
    delta += rewrite.text.length - (block.end - block.start);
  }

  parts.push(text.slice(cursor));
  const nextText = parts.join('');
  rememberTopLevelBlockIndex(nextText, nextBlocks);
  return nextText;
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
  mode: 'direct' | 'deep',
): Map<string, string> {
  const remaining = new Set(fieldNames);
  const values = new Map<string, string>();
  if (remaining.size === 0) {
    return values;
  }

  const fieldPattern = new RegExp(
    `\\s*(${[...remaining]
      .sort((left, right) => right.length - left.length)
      .map(escapeRegExp)
      .join('|')})\\s*(?:=|is\\b)\\s*`,
    'y',
  );
  let depth = 0;
  let inString: StringDelimiter | undefined;
  let inLineComment = false;

  for (let index = 0; index < blockText.length; index += 1) {
    const char = blockText[index];
    const next = blockText[index + 1];

    if (char === '\n') {
      inLineComment = false;
      continue;
    }
    if (inLineComment) {
      continue;
    }
    if (!inString && startsLineComment(char ?? '', next)) {
      inLineComment = true;
      index += 1;
      continue;
    }

    const nextStringState = advanceStringState(inString, blockText, index);
    if (nextStringState !== inString) {
      inString = nextStringState;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      continue;
    }
    if ((mode === 'direct' && depth !== 1) || (mode === 'deep' && depth < 1)) {
      continue;
    }

    const startOfLine = index === 0 || blockText[index - 1] === '\n';
    if (!startOfLine && blockText[index - 1] !== ' ' && blockText[index - 1] !== '\t') {
      continue;
    }

    fieldPattern.lastIndex = index;
    const match = fieldPattern.exec(blockText);
    const fieldName = match?.[1];
    if (!match || !fieldName || !remaining.has(fieldName)) {
      continue;
    }

    const valueStart = index + match[0].length;
    const valueEnd = findFieldValueEnd(blockText, valueStart);
    values.set(fieldName, blockText.slice(valueStart, valueEnd).trim());
    remaining.delete(fieldName);
    if (remaining.size === 0) {
      break;
    }
    if (mode === 'direct') {
      index = Math.max(index, valueEnd - 1);
    }
  }

  return values;
}

function findFieldRange(blockText: string, fieldName: string, mode: 'direct' | 'deep') {
  const fieldPattern = new RegExp(`\\s*(${escapeRegExp(fieldName)})\\s*(?:=|is\\b)\\s*`, 'y');
  let depth = 0;
  let inString: StringDelimiter | undefined;
  let inLineComment = false;

  for (let index = 0; index < blockText.length; index += 1) {
    const char = blockText[index];
    const next = blockText[index + 1];

    if (char === '\n') {
      inLineComment = false;
      continue;
    }

    if (inLineComment) {
      continue;
    }

    if (!inString && startsLineComment(char ?? '', next)) {
      inLineComment = true;
      index += 1;
      continue;
    }

    const nextStringState = advanceStringState(inString, blockText, index);
    if (nextStringState !== inString) {
      inString = nextStringState;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      continue;
    }

    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      continue;
    }

    if ((mode === 'direct' && depth !== 1) || (mode === 'deep' && depth < 1)) {
      continue;
    }

    const startOfLine = index === 0 || blockText[index - 1] === '\n';
    if (!startOfLine && blockText[index - 1] !== ' ' && blockText[index - 1] !== '\t') {
      continue;
    }

    fieldPattern.lastIndex = index;
    const match = fieldPattern.exec(blockText);
    if (!match) {
      continue;
    }

    const start = index;
    const valueStart = index + match[0].length;
    const valueEnd = findFieldValueEnd(blockText, valueStart);
    return { start, end: valueEnd, valueStart, valueEnd };
  }

  return undefined;
}

function findFieldValueEnd(text: string, valueStart: number): number {
  let depth = 1;
  let inString: StringDelimiter | undefined;
  let inLineComment = false;

  for (let index = valueStart; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '\n') {
      if (depth === 1) {
        const currentValueText = text.slice(valueStart, index);
        if (
          looksLikeSiblingStart(text, index + 1, currentValueText) ||
          looksLikeContainerBoundaryAfterScalar(text, index + 1, currentValueText)
        ) {
          return index;
        }
      }
      inLineComment = false;
      continue;
    }

    if (inLineComment) {
      continue;
    }

    if (!inString && startsLineComment(char ?? '', next)) {
      inLineComment = true;
      index += 1;
      continue;
    }

    const nextStringState = advanceStringState(inString, text, index);
    if (nextStringState !== inString) {
      inString = nextStringState;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
    } else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return text.length;
}

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
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
): CollectionEntryRange {
  const resolution = resolveCollectionEntryBySelector(collectionText, selectorSegment);
  ensure(resolution.entry, 'SelectorError', {
    absolutePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    operationIndex,
    reason:
      resolution.failure === 'index'
        ? `Collection entry index \`${selectorSegment}\` was not found.`
        : resolution.failure === 'none'
          ? `Collection selector \`${selectorSegment}\` matched no entries.`
          : `Collection selector \`${selectorSegment}\` matched multiple entries.`,
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
  let inString: StringDelimiter | undefined;
  let inLineComment = false;

  for (let index = innerStart; index < innerEnd; index += 1) {
    const char = collectionText[index] ?? '';
    const next = collectionText[index + 1];

    if (char === '\n') {
      inLineComment = false;
      continue;
    }

    if (inLineComment) {
      continue;
    }

    if (!inString && startsLineComment(char, next)) {
      inLineComment = true;
      index += 1;
      continue;
    }

    const previousStringState = inString;
    inString = advanceStringState(inString, collectionText, index);
    if (previousStringState || inString) {
      if (entryStart === undefined && inString) {
        entryStart = index;
      }
      continue;
    }

    if (entryStart === undefined && !/\s/.test(char)) {
      entryStart = index;
    }

    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      continue;
    }

    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      continue;
    }

    if (entryStart !== undefined && depth === 0 && char === ',') {
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

  const fieldValue = readDirectFieldValue(currentValue, currentSegment);
  if (!fieldValue) {
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
