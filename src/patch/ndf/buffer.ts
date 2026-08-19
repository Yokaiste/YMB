import {
  findNamedBlockByName,
  findTopLevelBlocks,
  forgetTopLevelBlockIndex,
  registerTopLevelBlockIndex,
  scanTopLevelBlocks,
} from './scan.ts';
import type { TopLevelBlock } from './shared.ts';

/**
 * The text of one NDF file mid-edit, kept as the pieces it is made of. A splice
 * costs the size of the edit, not the size of the file, and the join happens once
 * when somebody asks. Selection resolves through the carried block list, so a run
 * of operations never asks.
 */
export function createNdfTextBuffer(baseText: string): NdfTextBuffer {
  return new NdfTextBuffer(baseText, findTopLevelBlocks(baseText));
}

export class NdfTextBuffer {
  /** Concatenating these in order is the current text. */
  private pieces: string[];
  /** Start offset of each piece. Rebuilt after every splice. */
  private pieceStarts: number[];
  private currentLength: number;
  private blockList: readonly TopLevelBlock[];
  private flattenedText: string | undefined;
  private readonly baseText: string;

  constructor(baseText: string, blocks: readonly TopLevelBlock[]) {
    this.pieces = [baseText];
    this.pieceStarts = [0];
    this.currentLength = baseText.length;
    // Held, not copied. Every edit builds a fresh list rather than writing into
    // this one, and a script tool that makes a single edit per call would
    // otherwise copy a file's whole block list on the way in.
    this.blockList = blocks;
    this.flattenedText = baseText;
    this.baseText = baseText;
  }

  get length(): number {
    return this.currentLength;
  }

  /** The top-level blocks of the current text, in the order the file declares them. */
  blocks(): readonly TopLevelBlock[] {
    return this.blockList;
  }

  /** Cached until the next splice, and handed to the scan index with its block list. */
  text(): string {
    if (this.flattenedText === undefined) {
      this.flattenedText = this.pieces.join('');
      this.pieces = [this.flattenedText];
      this.pieceStarts = [0];
      // The text this buffer was built from is superseded, and callers advance
      // to the result immediately. Leaving both indexed would pin two full
      // copies of a file that can be tens of megabytes.
      forgetTopLevelBlockIndex(this.baseText);
      registerTopLevelBlockIndex(this.flattenedText, this.blockList);
    }
    return this.flattenedText;
  }

  endsWithNewline(): boolean {
    return this.charCodeAt(this.currentLength - 1) === 10;
  }

  charCodeAt(index: number): number {
    if (index < 0 || index >= this.currentLength) {
      return Number.NaN;
    }
    const pieceIndex = this.findPiece(index);
    const piece = this.pieces[pieceIndex];
    const pieceStart = this.pieceStarts[pieceIndex];
    return piece === undefined || pieceStart === undefined
      ? Number.NaN
      : piece.charCodeAt(index - pieceStart);
  }

  /** A span of the current text, built from the pieces it crosses. */
  slice(start: number, end: number): string {
    const from = Math.max(0, Math.min(start, this.currentLength));
    const to = Math.max(from, Math.min(end, this.currentLength));
    if (from === to) {
      return '';
    }

    const parts: string[] = [];
    for (let pieceIndex = this.findPiece(from); pieceIndex < this.pieces.length; pieceIndex += 1) {
      const piece = this.pieces[pieceIndex];
      const pieceStart = this.pieceStarts[pieceIndex];
      if (piece === undefined || pieceStart === undefined || pieceStart >= to) {
        break;
      }
      parts.push(
        piece.slice(Math.max(0, from - pieceStart), Math.min(piece.length, to - pieceStart)),
      );
    }
    return parts.length === 1 ? (parts[0] ?? '') : parts.join('');
  }

  /** Each splice seam is searched too, since a match may straddle one. */
  includes(needle: string): boolean {
    if (needle.length === 0) {
      return true;
    }
    // A one-character needle cannot straddle anything, and `slice(-0)` would
    // read a whole piece back rather than nothing.
    const seamReach = needle.length - 1;
    let previousPiece: string | undefined;
    for (const piece of this.pieces) {
      if (piece.includes(needle)) {
        return true;
      }
      if (
        seamReach > 0 &&
        previousPiece !== undefined &&
        `${previousPiece.slice(-seamReach)}${piece.slice(0, seamReach)}`.includes(needle)
      ) {
        return true;
      }
      previousPiece = piece;
    }
    return false;
  }

  /** The indentation of the line `index` sits on, without reading the whole file. */
  readLineIndent(index: number): string {
    let lineStart = index;
    while (lineStart > 0 && this.charCodeAt(lineStart - 1) !== 10) {
      lineStart -= 1;
    }
    const leadingWhitespace = this.slice(lineStart, index).match(/^[ \t]*/);
    return leadingWhitespace?.[0] ?? '';
  }

  /**
   * The range is always whole top-level blocks or a point between two, which is what
   * lets the block list shift rather than be rebuilt.
   */
  replaceTopLevelRange(start: number, end: number, replacement: string): void {
    if (start === end && replacement.length === 0) {
      return;
    }

    this.splice(start, end, replacement);
    const delta = replacement.length - (end - start);
    const insertedBlocks = scanTopLevelBlocks(replacement).map((block) => ({
      ...block,
      start: block.start + start,
      end: block.end + start,
    }));
    // Ordered in, ordered out: everything before the edit, the rescanned replacement,
    // then everything after it shifted.
    const nextBlocks: TopLevelBlock[] = [];
    let insertedYet = false;
    for (const block of this.blockList) {
      if (block.end <= start) {
        nextBlocks.push(block);
        continue;
      }
      if (!insertedYet) {
        nextBlocks.push(...insertedBlocks);
        insertedYet = true;
      }
      // An insertion at a block boundary preserves the existing block. A
      // replacement that overlaps it drops it in favor of the locally rescanned
      // replacement blocks.
      if (block.start >= end) {
        nextBlocks.push({ ...block, start: block.start + delta, end: block.end + delta });
      }
    }
    if (!insertedYet) {
      nextBlocks.push(...insertedBlocks);
    }
    this.blockList = nextBlocks;
  }

  private splice(start: number, end: number, replacement: string): void {
    const firstIndex = this.findPiece(start);
    const lastIndex = this.findPiece(end);
    const firstPiece = this.pieces[firstIndex] ?? '';
    const lastPiece = this.pieces[lastIndex] ?? '';
    const firstStart = this.pieceStarts[firstIndex] ?? 0;
    const lastStart = this.pieceStarts[lastIndex] ?? 0;

    const head = firstPiece.slice(0, start - firstStart);
    const tail = lastPiece.slice(end - lastStart);
    const middle = [head, replacement, tail].filter((piece) => piece.length > 0);
    this.pieces.splice(firstIndex, lastIndex - firstIndex + 1, ...middle);

    this.currentLength += replacement.length - (end - start);
    this.reindexPieces();
    this.flattenedText = undefined;
  }

  private reindexPieces(): void {
    this.pieceStarts = new Array(this.pieces.length);
    let offset = 0;
    for (const [index, piece] of this.pieces.entries()) {
      this.pieceStarts[index] = offset;
      offset += piece.length;
    }
  }

  /**
   * Only the forms outside that list -- templates and the bare `Name is ...` spellings
   * -- need the text, so a name the file does not hold anywhere costs no join.
   */
  findNamedBlock(name: string): TopLevelBlock | undefined {
    const indexed = this.blockList.find((block) => block.name === name);
    if (indexed || !this.includes(name)) {
      return indexed;
    }
    return findNamedBlockByName(this.text(), name);
  }

  /** The piece holding `index`, or the last piece when `index` is the end. */
  private findPiece(index: number): number {
    let low = 0;
    let high = this.pieces.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((this.pieceStarts[middle] ?? 0) <= index) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return low;
  }
}
