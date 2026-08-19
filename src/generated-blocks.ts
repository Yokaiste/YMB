import type {
  BuildScriptGeneratedBlock,
  BuildScriptGeneratedBlockMarkers,
  BuildScriptGeneratedBlockOptions,
} from 'ymb/api';
import { BUILDER_CONFIG } from './builder-config.ts';

type RenderGeneratedBlockOptions = BuildScriptGeneratedBlockOptions;

export function renderGeneratedBlock({
  ownerId,
  blocks,
  title,
  sourcePath,
}: RenderGeneratedBlockOptions): string {
  const markers = buildGeneratedBlockMarkers(ownerId);
  const lines = [
    markers.start,
    ...(title ? [`// ${title}`] : []),
    ...(sourcePath ? [`// Source: ${sourcePath}`] : []),
    '',
    ...blocks,
    markers.end,
    '',
  ];

  return lines.join('\n');
}

export function upsertGeneratedBlock(
  originalContent: string,
  generatedBlock: string,
  ownerId: string,
): string {
  const blockPattern = buildGeneratedBlockPattern(ownerId);
  if (blockPattern.test(originalContent)) {
    // A function replacer keeps `$&`, `$'`, and other `$` sequences in generated
    // NDF literal instead of letting `String.replace` expand them.
    return originalContent.replace(blockPattern, () => generatedBlock);
  }

  return appendGeneratedBlock(originalContent, generatedBlock);
}

export function buildGeneratedBlockStartMarker(ownerId: string): string {
  return `// ${BUILDER_CONFIG.generatedBlockLabel} GENERATED BLOCK START | ${ownerId}`;
}

export function buildGeneratedBlockEndMarker(ownerId: string): string {
  return `// ${BUILDER_CONFIG.generatedBlockLabel} GENERATED BLOCK END | ${ownerId}`;
}

export function buildGeneratedBlockMarkers(ownerId: string): BuildScriptGeneratedBlockMarkers {
  return {
    start: buildGeneratedBlockStartMarker(ownerId),
    end: buildGeneratedBlockEndMarker(ownerId),
  };
}

function buildGeneratedBlockPattern(ownerId: string): RegExp {
  const markers = buildGeneratedBlockMarkers(ownerId);
  return new RegExp(
    `^[ \\t]*${RegExp.escape(markers.start)}[\\s\\S]*?^[ \\t]*${RegExp.escape(markers.end)}\\r?\\n?`,
    'm',
  );
}

/**
 * A marker line runs from its own indentation to its own terminator. `\s*` spans line
 * breaks and `^` sits between the `\r` and `\n` of a CRLF break, so the block used to
 * start a character early and strip left a bare `\r` behind.
 */
const GENERATED_BLOCK_SCAN_PATTERN =
  /^([ \t]*\/\/ [^\n\r]*GENERATED BLOCK START \| ([^\n\r]+))\r?\n([\s\S]*?)^[ \t]*\/\/ [^\n\r]*GENERATED BLOCK END \| \2\r?\n?/gm;

type GeneratedBlockRange = BuildScriptGeneratedBlock;

export function listGeneratedBlocks(text: string): GeneratedBlockRange[] {
  const ranges: GeneratedBlockRange[] = [];
  for (const match of text.matchAll(GENERATED_BLOCK_SCAN_PATTERN)) {
    const fullText = match[0];
    const id = match[2];
    const start = match.index;
    if (fullText === undefined || id === undefined || start === undefined) {
      continue;
    }
    const sourcePath = extractGeneratedBlockSourcePath(fullText);
    ranges.push({
      id,
      fullText,
      innerText: match[3] ?? '',
      ...(sourcePath ? { sourcePath } : {}),
      start,
      end: start + fullText.length,
    });
  }
  return ranges;
}

export function hasGeneratedBlockMarkers(text: string): boolean {
  return text.includes('GENERATED BLOCK START | ') || text.includes('GENERATED BLOCK END | ');
}

export function stripGeneratedBlocks(text: string): string {
  const ranges = listGeneratedBlocks(text);
  if (ranges.length === 0) {
    return text;
  }
  const parts: string[] = [];
  let lastIndex = 0;
  for (const range of ranges) {
    parts.push(text.slice(lastIndex, range.start));
    lastIndex = range.end;
  }
  parts.push(text.slice(lastIndex));
  return parts.join('');
}

function extractGeneratedBlockSourcePath(blockText: string): string | undefined {
  return blockText.match(/^\s*\/\/ Source: (.+)$/m)?.[1];
}

function appendGeneratedBlock(originalContent: string, generatedBlock: string): string {
  const stripped = originalContent.trimEnd();
  return stripped ? `${stripped}\n${generatedBlock}` : generatedBlock;
}
