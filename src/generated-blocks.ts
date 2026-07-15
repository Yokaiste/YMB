import { BUILDER_CONFIG } from './builder-config.ts';
import { escapeRegExp } from './text-utils.ts';

interface RenderGeneratedBlockOptions {
  ownerId: string;
  blocks: string[];
  title?: string;
  sourcePath?: string;
  label?: string;
}

export function renderGeneratedBlock({
  ownerId,
  blocks,
  title,
  sourcePath,
  label = BUILDER_CONFIG.generatedBlockLabel,
}: RenderGeneratedBlockOptions): string {
  const markers = buildGeneratedBlockMarkers(ownerId, label);
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
  label: string = BUILDER_CONFIG.generatedBlockLabel,
): string {
  const blockPattern = buildGeneratedBlockPattern(ownerId, label);
  if (blockPattern.test(originalContent)) {
    return originalContent.replace(blockPattern, generatedBlock);
  }

  return appendGeneratedBlock(originalContent, generatedBlock);
}

export function buildGeneratedBlockStartMarker(
  ownerId: string,
  label: string = BUILDER_CONFIG.generatedBlockLabel,
): string {
  return `// ${label} GENERATED BLOCK START | ${ownerId}`;
}

export function buildGeneratedBlockEndMarker(
  ownerId: string,
  label: string = BUILDER_CONFIG.generatedBlockLabel,
): string {
  return `// ${label} GENERATED BLOCK END | ${ownerId}`;
}

export function buildGeneratedBlockMarkers(
  ownerId: string,
  label: string = BUILDER_CONFIG.generatedBlockLabel,
): { start: string; end: string } {
  return {
    start: buildGeneratedBlockStartMarker(ownerId, label),
    end: buildGeneratedBlockEndMarker(ownerId, label),
  };
}

function buildGeneratedBlockPattern(ownerId: string, label: string): RegExp {
  const markers = buildGeneratedBlockMarkers(ownerId, label);
  return new RegExp(
    `^[ \\t]*${escapeRegExp(markers.start)}[\\s\\S]*?^[ \\t]*${escapeRegExp(markers.end)}\\r?\\n?`,
    'm',
  );
}

const GENERATED_BLOCK_SCAN_PATTERN =
  /^(\s*\/\/ [^\n\r]*GENERATED BLOCK START \| (.+))\r?\n([\s\S]*?)^\s*\/\/ [^\n\r]*GENERATED BLOCK END \| \2\r?\n?/gm;

interface GeneratedBlockRange {
  id: string;
  fullText: string;
  innerText: string;
  sourcePath?: string | undefined;
  start: number;
  end: number;
}

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
