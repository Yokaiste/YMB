import { listGeneratedBlocks } from './generated-blocks.ts';

type GeneratedBlockMergeResult =
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
  const ranges = listGeneratedBlocks(content);
  if (ranges.length === 0) {
    return undefined;
  }

  const blocks = new Map<string, ParsedGeneratedBlock>();
  const strippedParts: string[] = [];
  let lastIndex = 0;
  for (const range of ranges) {
    strippedParts.push(content.slice(lastIndex, range.start));
    lastIndex = range.end;
    blocks.set(range.id, {
      fullText: range.fullText,
      ...(range.sourcePath ? { sourcePath: range.sourcePath } : {}),
    });
  }

  strippedParts.push(content.slice(lastIndex));
  return {
    strippedText: strippedParts.join(''),
    blocks,
  };
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
