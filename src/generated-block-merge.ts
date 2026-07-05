export type GeneratedBlockMergeResult =
  | {
      kind: 'applied';
      content: string;
    }
  | {
      kind: 'conflict';
      reason: string;
      details: string[];
    }
  | {
      kind: 'unsupported';
    };

interface ParsedGeneratedBlock {
  fullText: string;
  sourcePath?: string;
}

const GENERATED_BLOCK_PATTERN =
  /^(\s*\/\/ [^\n\r]*GENERATED BLOCK START \| (.+))\r?\n([\s\S]*?)^\s*\/\/ [^\n\r]*GENERATED BLOCK END \| \2\r?\n?/gm;

export function tryMergeGeneratedBlocks(
  currentText: string,
  nextText: string,
  ownerPath: string,
): GeneratedBlockMergeResult {
  const currentSnapshot = parseGeneratedBlocks(currentText);
  const nextSnapshot = parseGeneratedBlocks(nextText);
  if (!currentSnapshot || !nextSnapshot) {
    return { kind: 'unsupported' };
  }

  if (currentSnapshot.strippedText !== nextSnapshot.strippedText) {
    return { kind: 'unsupported' };
  }

  const foreignChanges = collectChangedBlockIds(currentSnapshot.blocks, nextSnapshot.blocks).filter(
    (id) =>
      !isOwnedBlock(id, currentSnapshot.blocks.get(id), ownerPath) &&
      !isOwnedBlock(id, nextSnapshot.blocks.get(id), ownerPath),
  );
  if (foreignChanges.length > 0) {
    return {
      kind: 'conflict',
      reason: 'Script output modified generated blocks owned by another contributor.',
      details: foreignChanges.map((id) => `Foreign generated block: ${id}`),
    };
  }

  return {
    kind: 'applied',
    content: nextText,
  };
}

function collectChangedBlockIds(
  currentBlocks: Map<string, ParsedGeneratedBlock>,
  nextBlocks: Map<string, ParsedGeneratedBlock>,
): string[] {
  const changedBlockIds: string[] = [];
  for (const id of new Set([...currentBlocks.keys(), ...nextBlocks.keys()])) {
    if (currentBlocks.get(id)?.fullText !== nextBlocks.get(id)?.fullText) {
      changedBlockIds.push(id);
    }
  }
  return changedBlockIds;
}

function parseGeneratedBlocks(
  content: string,
): { strippedText: string; blocks: Map<string, ParsedGeneratedBlock> } | undefined {
  const blocks = new Map<string, ParsedGeneratedBlock>();
  const strippedParts: string[] = [];
  let lastIndex = 0;
  let foundBlock = false;

  for (const match of content.matchAll(GENERATED_BLOCK_PATTERN)) {
    const fullText = match[0];
    const id = match[2];
    const startIndex = match.index;
    if (fullText === undefined || id === undefined || startIndex === undefined) {
      continue;
    }

    foundBlock = true;
    strippedParts.push(content.slice(lastIndex, startIndex));
    lastIndex = startIndex + fullText.length;
    const sourcePath = extractSourcePath(fullText);
    blocks.set(id, {
      fullText,
      ...(sourcePath ? { sourcePath } : {}),
    });
  }

  if (!foundBlock) {
    return undefined;
  }

  strippedParts.push(content.slice(lastIndex));
  return {
    strippedText: strippedParts.join(''),
    blocks,
  };
}

function extractSourcePath(blockText: string): string | undefined {
  const sourceMatch = blockText.match(/^\s*\/\/ Source: (.+)$/m);
  return sourceMatch?.[1];
}

function isOwnedBlock(
  blockId: string,
  block: ParsedGeneratedBlock | undefined,
  ownerPath: string,
): boolean {
  if (!block) {
    return false;
  }
  return (
    blockId === ownerPath || blockId.startsWith(`${ownerPath} |`) || block.sourcePath === ownerPath
  );
}
