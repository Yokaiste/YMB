import { BUILDER_CONFIG } from './builder-config.ts';

export interface RenderGeneratedBlockOptions {
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

function buildGeneratedBlockMarkers(
  ownerId: string,
  label: string,
): { start: string; end: string } {
  return {
    start: buildGeneratedBlockStartMarker(ownerId, label),
    end: buildGeneratedBlockEndMarker(ownerId, label),
  };
}

function buildGeneratedBlockPattern(ownerId: string, label: string): RegExp {
  const markers = buildGeneratedBlockMarkers(ownerId, label);
  return new RegExp(`${escapeRegExp(markers.start)}[\\s\\S]*?${escapeRegExp(markers.end)}\\r?\\n?`);
}

function appendGeneratedBlock(originalContent: string, generatedBlock: string): string {
  const stripped = originalContent.trimEnd();
  return stripped ? `${stripped}\n${generatedBlock}` : generatedBlock;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
