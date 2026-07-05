import { createHash } from 'node:crypto';
import path from 'node:path';
import { YmbError } from '../../errors.ts';
import { renderOriginalSnippetComments as renderSharedOriginalSnippetComments } from '../../markers.ts';
import type { PatchApplication, Selector } from '../../types.ts';

export interface TopLevelBlock {
  name?: string;
  typeName: string;
  start: number;
  end: number;
  text: string;
}

export interface PatchMarkerContext {
  operation: 'add' | 'copy' | 'modify' | 'remove';
  selector: Selector;
  application: PatchApplication;
  absolutePath: string;
  operationIndex: number;
}

export type StringDelimiter = '"' | "'";

function isStringDelimiter(char: string): char is StringDelimiter {
  return char === '"' || char === "'";
}

function isEscapedCharacter(text: string, index: number): boolean {
  return text[index - 1] === '\\';
}

export function startsLineComment(char: string, next: string | undefined): boolean {
  return char === '/' && next === '/';
}

export function advanceStringState(
  current: StringDelimiter | undefined,
  text: string,
  index: number,
): StringDelimiter | undefined {
  const char = text[index] ?? '';
  if (!isStringDelimiter(char)) {
    return current;
  }

  if (!current) {
    return char;
  }

  return current === char && !isEscapedCharacter(text, index) ? undefined : current;
}

export function normalizeSnippetIndentation(snippet: string, baseIndent: string): string {
  const lines = snippet.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[0]?.trim() === '') {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') {
    lines.pop();
  }

  if (lines.length === 0) {
    return baseIndent;
  }

  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  const commonIndent =
    nonEmptyLines.length === 0
      ? 0
      : Math.min(...nonEmptyLines.map((line) => countLeadingIndent(line)));

  return lines
    .map((line) => {
      if (line.trim().length === 0) {
        return baseIndent;
      }
      return `${baseIndent}${line.slice(Math.min(commonIndent, countLeadingIndent(line)))}`;
    })
    .join('\n');
}

function countLeadingIndent(value: string): number {
  const match = value.match(/^[ \t]*/);
  return match?.[0].length ?? 0;
}

export function readLineIndent(text: string, index: number): string {
  const lineStart = text.lastIndexOf('\n', index - 1);
  const sliceStart = lineStart === -1 ? 0 : lineStart + 1;
  const leadingWhitespace = text.slice(sliceStart, index).match(/^[ \t]*/);
  return leadingWhitespace?.[0] ?? '';
}

export function wrapAddedSnippetWithMarkers(
  snippet: string,
  indent: string,
  markerContext: PatchMarkerContext,
): string {
  return wrapSnippetWithMarkers(snippet, indent, markerContext);
}

export function createMarkerContext(
  operation: 'add' | 'copy' | 'modify' | 'remove',
  selector: Selector,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
): PatchMarkerContext {
  return {
    operation,
    selector,
    application,
    absolutePath,
    operationIndex,
  };
}

export function wrapSnippetWithMarkers(
  snippet: string,
  indent: string,
  markerContext: PatchMarkerContext,
): string {
  const payload = JSON.stringify(createMarkerPayload(markerContext));
  const label = markerContext.operation.toUpperCase();
  return `${indent}// YMB-${label}-START ${payload}\n${snippet}\n${indent}// YMB-${label}-END ${payload}`;
}

export function wrapModifiedSnippetWithMarkers(
  snippet: string,
  originalSnippet: string,
  indent: string,
  markerContext: PatchMarkerContext,
): string {
  const payload = JSON.stringify(createMarkerPayload(markerContext));
  const originalCommentBlock = renderOriginalSnippetComments(originalSnippet, indent);
  return `${indent}// YMB-MODIFY-START ${payload}\n${originalCommentBlock}\n${snippet}\n${indent}// YMB-MODIFY-END ${payload}`;
}

export function wrapRemovedSnippetWithMarkers(
  originalSnippet: string,
  indent: string,
  markerContext: PatchMarkerContext,
): string {
  const payload = JSON.stringify(createMarkerPayload(markerContext));
  const originalCommentBlock = renderOriginalSnippetComments(originalSnippet, indent);
  return `${indent}// YMB-REMOVE-START ${payload}\n${originalCommentBlock}\n${indent}// YMB-REMOVE-END ${payload}`;
}

function renderOriginalSnippetComments(originalSnippet: string, indent: string): string {
  return renderSharedOriginalSnippetComments(originalSnippet, indent, 'inline.ndf');
}

export function ensureMarkerBlockEndsBeforeFollowingToken(
  markerBlock: string,
  followingCharacter: string | undefined,
): string {
  if (!followingCharacter || followingCharacter === '\n') {
    return markerBlock;
  }
  return `${markerBlock}\n`;
}

function createMarkerPayload(markerContext: PatchMarkerContext) {
  const selector = formatSelector(markerContext.selector);
  const seed = [
    markerContext.operation,
    markerContext.application.mod.config.id,
    markerContext.application.patch.config.id,
    markerContext.absolutePath,
    markerContext.operationIndex,
    selector,
  ].join('|');
  return {
    id: createHash('sha256').update(seed).digest('hex').slice(0, 12),
    patchId: markerContext.application.patch.config.id,
  };
}

function formatSelector(selector: Selector): string {
  if (selector.by === 'match') {
    return `${selector.kind}:${selector.by}:${JSON.stringify(selector.where ?? {})}`;
  }
  return `${selector.kind}:${selector.by}:${String(selector.value ?? '')}`;
}

export function replaceRange(
  text: string,
  start: number,
  end: number,
  replacement: string,
): string {
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}

export function trimOuterWhitespace(value: string): string {
  return value.replace(/^\s+|\s+$/g, '');
}

export function preserveOuterWhitespace(originalValue: string, replacementCore: string): string {
  const leadingMatch = originalValue.match(/^\s*/);
  const trailingMatch = originalValue.match(/\s*$/);
  const leading = leadingMatch?.[0] ?? '';
  const trailing = trailingMatch?.[0] ?? '';
  return `${leading}${replacementCore}${trailing}`;
}

export function removeRange(text: string, start: number, end: number): string {
  const normalizedEnd = text[end] === '\n' ? end + 1 : end;
  return `${text.slice(0, start)}${text.slice(normalizedEnd)}`;
}

export function formatNdfValue(value: unknown): string {
  if (isRawNdfValue(value)) {
    return stripLineComments(value.$raw);
  }

  if (typeof value === 'string') {
    if (
      /^[$~]?\//.test(value) ||
      /^GUID:\{/.test(value) ||
      /^[A-Za-z_][A-Za-z0-9_./]*$/.test(value)
    ) {
      return value;
    }

    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    return `${quote}${value}${quote}`;
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }

  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => formatNdfValue(entry)).join(', ')}]`;
  }

  if (value && typeof value === 'object') {
    const lines = Object.entries(value).map(
      ([key, nested]) => `    ${key} = ${formatNdfValue(nested)}`,
    );
    return `(\n${lines.join('\n')}\n)`;
  }

  if (value === null || value === undefined) {
    return 'Nil';
  }

  return String(value);
}

export function isRawNdfValue(value: unknown): value is { $raw: string } {
  return (
    typeof value === 'object' && value !== null && '$raw' in value && typeof value.$raw === 'string'
  );
}

export function stripLineComments(text: string): string {
  let output = '';
  let inString: StringDelimiter | undefined;
  let inLineComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        output += char;
      }
      continue;
    }

    if (!inString && startsLineComment(char ?? '', next)) {
      inLineComment = true;
      index += 1;
      continue;
    }

    output += char;
    inString = advanceStringState(inString, text, index);
  }

  return output;
}

export function selectorError(
  selector: Selector,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  reason: string,
): YmbError {
  return new YmbError('SelectorError', {
    absolutePath: path.resolve(absolutePath),
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    operationIndex,
    reason: `${reason} Selector \`${selector.kind}:${selector.by}\` is not supported here.`,
    suggestion: 'Use a selector kind and `by` mode supported by this operation.',
  });
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
