import { ensure } from '../../errors.ts';
import type { PatchApplication } from '../../types.ts';
import {
  advanceStringState,
  escapeRegExp,
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

export function findNamedBlockByName(text: string, exportName: string): TopLevelBlock | undefined {
  return (
    findTopLevelBlocks(text).find((block) => block.name === exportName) ??
    findTemplateBlockByName(text, exportName) ??
    findBareNamedCollectionBlock(text, exportName) ??
    findBareNamedScalarBlock(text, exportName)
  );
}

export function findTopLevelBlocks(text: string): TopLevelBlock[] {
  const blocks: TopLevelBlock[] = [];
  const headerPattern =
    /^(?:(?:export\s+)?(?:private\s+)?([A-Za-z0-9_]+)\s+is(?:\s+([^\n]+))?|(?:private\s+)?unnamed\s+([^\n]+))$/gm;

  for (const match of text.matchAll(headerPattern)) {
    const start = match.index ?? 0;
    const name = match[1];
    const rawTypeName = match[2] ?? match[3] ?? '';
    if (!name && rawTypeName.length === 0) {
      continue;
    }

    const opener = findNextTopLevelOpener(text, start + match[0].length);
    if (!opener) {
      continue;
    }

    const end = findMatchingDelimiter(
      text,
      opener.index,
      opener.character,
      opener.character === '(' ? ')' : ']',
    );
    blocks.push(
      name
        ? {
            name,
            typeName: rawTypeName.trim(),
            start,
            end: end + 1,
            text: text.slice(start, end + 1),
          }
        : {
            typeName: rawTypeName.trim(),
            start,
            end: end + 1,
            text: text.slice(start, end + 1),
          },
    );
  }

  return blocks;
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

    if (depth !== 1) {
      continue;
    }

    const startOfLine = index === 0 || blockText[index - 1] === '\n';
    if (!startOfLine && blockText[index - 1] !== ' ' && blockText[index - 1] !== '\t') {
      continue;
    }

    const remaining = blockText.slice(index);
    const match = remaining.match(new RegExp(`^\\s*(${escapeRegExp(fieldName)})\\s*=\\s*`));
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
      if (depth === 1 && looksLikeDirectFieldStart(text, index + 1)) {
        return index;
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

function looksLikeDirectFieldStart(text: string, fromIndex: number): boolean {
  for (const line of text.slice(fromIndex).split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.length === 0 || trimmed.startsWith('//')) {
      continue;
    }
    return /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(trimmed);
  }
  return false;
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
  const parsedSelector = parseCollectionSelectorSegment(selectorSegment);
  const entries = findCollectionEntries(collectionText);

  if (parsedSelector.kind === 'index') {
    const entry = entries[parsedSelector.value];
    ensure(entry, 'SelectorError', {
      absolutePath,
      modId: application.mod.config.id,
      modName: application.mod.config.name,
      patchId: application.patch.config.id,
      operationIndex,
      reason: `Collection entry index ${parsedSelector.value} was not found.`,
      suggestion: 'Use a valid collection entry index or a more stable selector.',
    });
    return entry;
  }

  const matches = entries.filter((entry) => {
    if (parsedSelector.kind === 'type') {
      return entry.typeName === parsedSelector.value;
    }

    const actualValue = readNestedPathValue(entry.text, parsedSelector.path.split('.'));
    return actualValue?.trim() === parsedSelector.value;
  });

  ensure(matches.length === 1, 'SelectorError', {
    absolutePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    operationIndex,
    reason:
      matches.length === 0
        ? `Collection selector \`${selectorSegment}\` matched no entries.`
        : `Collection selector \`${selectorSegment}\` matched multiple entries.`,
    suggestion: 'Use a more specific collection selector that resolves to exactly one entry.',
  });

  const matchedEntry = matches[0];
  ensure(matchedEntry, 'SelectorError', {
    absolutePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    operationIndex,
    reason: `Collection selector \`${selectorSegment}\` could not be resolved to exactly one entry.`,
    suggestion: 'Use a more specific collection selector that resolves to exactly one entry.',
  });
  return matchedEntry;
}

function parseCollectionSelectorSegment(
  selectorSegment: string,
):
  | { kind: 'index'; value: number }
  | { kind: 'type'; value: string }
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

  if (selectorBody.startsWith('type:')) {
    return { kind: 'type', value: selectorBody.slice('type:'.length).trim() };
  }

  return { kind: 'type', value: selectorBody };
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

    const nextStringState = advanceStringState(inString, collectionText, index);
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

    if (entryStart === undefined) {
      if (!/\s/.test(char)) {
        entryStart = index;
      }
      continue;
    }

    if (depth === 0 && char === ',') {
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

  const fieldRange = findDirectFieldRange(currentValue, currentSegment);
  if (!fieldRange) {
    return undefined;
  }

  const fieldValue = currentValue.slice(fieldRange.valueStart, fieldRange.valueEnd).trim();
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
  const parsedSelector = parseCollectionSelectorSegment(selectorSegment);
  const entries = findCollectionEntries(collectionText);

  if (parsedSelector.kind === 'index') {
    return entries[parsedSelector.value];
  }

  const matches = entries.filter((entry) => {
    if (parsedSelector.kind === 'type') {
      return entry.typeName === parsedSelector.value;
    }

    const actualValue = readNestedPathValue(entry.text, parsedSelector.path.split('.'));
    return actualValue?.trim() === parsedSelector.value;
  });

  return matches.length === 1 ? matches[0] : undefined;
}
