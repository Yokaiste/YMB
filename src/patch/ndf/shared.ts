import { createHash } from 'node:crypto';
import path from 'node:path';
import type { BuildScriptNdfBlock } from 'ymb/api';
import { YmbError } from '../../errors.ts';
import { renderOriginalSnippetComments } from '../../markers.ts';
import { normalizeRelativePath, toDisplayPath } from '../../path-utils.ts';
import type { ErrorContext, PatchApplication, Selector } from '../../types.ts';
import { renderLeadingComment, stripLineComments } from './comments.ts';

export type TopLevelBlock = BuildScriptNdfBlock;

export interface PatchMarkerContext {
  operation: 'add' | 'copy' | 'modify' | 'remove';
  /** Absent when adding a new top-level block, which selects nothing. */
  selector: Selector | undefined;
  application: PatchApplication;
  absolutePath: string;
  operationIndex: number;
}

/** Keeps the deep NDF walks from threading application, path, and operation index. */
export type PatchErrorIdentity = Pick<
  ErrorContext,
  | 'absolutePath'
  | 'modId'
  | 'modName'
  | 'patchId'
  | 'operationIndex'
  | 'patchConfigPath'
  | 'operationLine'
>;

/**
 * Config path and line stay optional: a patch written without recorded lines has
 * none, and `describeOperationLocation` falls back to the ordinal.
 */
interface ResolvedPatchErrorIdentity {
  absolutePath: string;
  modId: string;
  modName: string;
  patchId: string;
  operationIndex: number;
  patchConfigPath?: string | undefined;
  operationLine?: number | undefined;
}

export function toPatchErrorIdentity(
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
): ResolvedPatchErrorIdentity {
  return {
    absolutePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    operationIndex,
    patchConfigPath: toPatchConfigDisplayPath(application),
    operationLine: application.operationLines?.[operationIndex],
  };
}

/**
 * The patch config as the reader has to type it back. Shortened here rather than at
 * two dozen call sites, and against the mod's own directory, which the mod knows.
 */
function toPatchConfigDisplayPath(application: PatchApplication): string {
  const withinMod = toDisplayPath(application.patch.configFilePath, application.mod.absolutePath);
  const modPrefix = normalizeRelativePath(application.mod.relativePathFromMods).replace(
    /^\/|\/$/g,
    '',
  );
  // Unshortened means the config does not sit under the mod at all, so there is
  // nothing to prefix it with and the full path is the honest answer.
  if (!modPrefix || withinMod === normalizeRelativePath(application.patch.configFilePath)) {
    return withinMod;
  }
  return `${modPrefix}/${withinMod}`;
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

export function createMarkerContext(
  operation: 'add' | 'copy' | 'modify' | 'remove',
  selector: Selector | undefined,
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
  leadingComment?: string,
): string {
  const payload = JSON.stringify(createMarkerPayload(markerContext));
  const label = markerContext.operation.toUpperCase();
  const commentBlock = renderLeadingComment(leadingComment, indent);
  return `${indent}// YMB-${label}-START ${payload}\n${commentBlock}${snippet}\n${indent}// YMB-${label}-END ${payload}`;
}

export function wrapModifiedSnippetWithMarkers(
  snippet: string,
  originalSnippet: string,
  indent: string,
  markerContext: PatchMarkerContext,
  leadingComment?: string,
): string {
  const payload = JSON.stringify(createMarkerPayload(markerContext));
  const originalCommentBlock = renderOriginalSnippetComments(originalSnippet, indent, 'inline.ndf');
  const commentBlock = renderLeadingComment(leadingComment, indent);
  return `${indent}// YMB-MODIFY-START ${payload}\n${commentBlock}${originalCommentBlock}\n${snippet}\n${indent}// YMB-MODIFY-END ${payload}`;
}

export function wrapRemovedSnippetWithMarkers(
  originalSnippet: string,
  indent: string,
  markerContext: PatchMarkerContext,
  leadingComment?: string,
): string {
  const payload = JSON.stringify(createMarkerPayload(markerContext));
  const originalCommentBlock = renderOriginalSnippetComments(originalSnippet, indent, 'inline.ndf');
  const commentBlock = renderLeadingComment(leadingComment, indent);
  return `${indent}// YMB-REMOVE-START ${payload}\n${commentBlock}${originalCommentBlock}\n${indent}// YMB-REMOVE-END ${payload}`;
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

function formatSelector(selector: Selector | undefined): string {
  if (!selector) return 'top-level';
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
    return stripLineComments(String(value.$raw));
  }

  if (isExplicitStringValue(value)) {
    return quoteNdfString(value.$string);
  }

  if (typeof value === 'string') {
    if (
      /^[$~]?\//.test(value) ||
      /^GUID:\{/.test(value) ||
      /^[A-Za-z_][A-Za-z0-9_./]*$/.test(value)
    ) {
      return value;
    }

    return quoteNdfString(value);
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

/**
 * A template resolving to a single number or boolean hands one over as that type, so
 * scalars are accepted. Anything structured is refused: there is no sensible literal
 * for it, and the alternative emits `( $raw = ... )` into a game file.
 */
export function isRawNdfValue(
  value: unknown,
): value is { $raw: string | number | bigint | boolean } {
  if (typeof value !== 'object' || value === null || !('$raw' in value)) {
    return false;
  }
  const raw = value.$raw;
  if (
    typeof raw === 'string' ||
    typeof raw === 'number' ||
    typeof raw === 'bigint' ||
    typeof raw === 'boolean'
  ) {
    return true;
  }
  throw new YmbError('ConfigError', {
    absolutePath: '',
    reason: `\`$raw\` must hold text or a single number, received ${raw === null ? 'null' : Array.isArray(raw) ? 'a list' : typeof raw}.`,
    suggestion:
      'Give `$raw` the exact NDF snippet as text. To build one from parts, join them into a string first.',
  });
}

function isExplicitStringValue(value: unknown): value is { $string: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    '$string' in value &&
    typeof value.$string === 'string'
  );
}

function quoteNdfString(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  // Backslashes are escaped even when the value holds no quote at all: the scanner
  // reads `\<delimiter>` as escaped, so a value ending in a backslash would swallow
  // its own closing quote and run the string on into the rest of the file.
  const escaped = value.replaceAll('\\', '\\\\').replaceAll(quote, `\\${quote}`);
  return `${quote}${escaped}${quote}`;
}

/**
 * Separate from every other selector failure because its meaning depends on what the
 * operation wanted: for `remove`, not being there is the job already done. Still a
 * `SelectorError`, so an `optional` patch is dropped for it as before.
 */
class MissingNdfTargetError extends YmbError {
  constructor(context: ErrorContext) {
    super('SelectorError', context);
    this.name = 'MissingNdfTargetError';
  }
}

export function isMissingNdfTarget(error: unknown): error is MissingNdfTargetError {
  return error instanceof MissingNdfTargetError;
}

/** `ensure` for the one condition that means "the file does not contain this". */
export function ensureFound(condition: unknown, context: ErrorContext): asserts condition {
  if (!condition) {
    throw new MissingNdfTargetError(context);
  }
}

export function selectorError(
  selector: Selector,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  reason: string,
): YmbError {
  return new YmbError('SelectorError', {
    ...toPatchErrorIdentity(application, path.resolve(absolutePath), operationIndex),
    reason: `${reason} Selector \`${selector.kind}:${selector.by}\` is not supported here.`,
    suggestion: 'Use a selector kind and `by` mode supported by this operation.',
  });
}
