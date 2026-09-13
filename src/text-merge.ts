import type { CooperativeYieldController } from './async.ts';
import type { BuilderProjectSettings } from './builder-config.ts';

export interface TextMergeContributor {
  id: string;
  label: string;
  content: string;
}

export interface TextLineEdit {
  start: number;
  end: number;
  newLines: string[];
  contributorId: string;
  contributorLabel: string;
}

interface TextMergeConflict {
  existing: TextLineEdit;
  incoming: TextLineEdit;
}

interface TextMergeBudgetExceeded {
  contributorLabel: string;
  changedBaseLines: number;
  changedNextLines: number;
  estimatedWork: number;
}

type TextMergeBudgetFailure = {
  ok: false;
  reason: 'budget_exceeded';
  budget: TextMergeBudgetExceeded;
};

type TextMergeResult =
  | {
      ok: true;
      content: string;
      edits: TextLineEdit[];
    }
  | { ok: false; reason: 'conflict'; conflict: TextMergeConflict }
  | TextMergeBudgetFailure;

type TextChangeDescriptionResult =
  | {
      ok: true;
      edits: TextLineEdit[];
    }
  | TextMergeBudgetFailure;

export interface TextChangeBudgetOptions {
  maxEstimatedDiffWork: number;
  maxTextBytesPerSide: number;
  maxTextBytesCombined: number;
}

interface DiffOperation {
  kind: 'equal' | 'insert' | 'delete';
  value: string;
}

/**
 * The diff is written once, as a generator that pauses at fixed work intervals.
 * A blocking caller drains it; a cooperative caller yields to the event loop at
 * every pause. Two hand-maintained copies of a linear-space LCS diff would drift.
 */
type DiffSteps<TResult> = Generator<void, TResult, void>;

/**
 * Every budget is a builder setting, so a project generating one very large file
 * can raise the ceiling instead of editing a shipped bundle. They are resolved
 * here rather than read at each call site, so no caller can invent its own.
 */
export function resolveTextMergeBudgets(settings: BuilderProjectSettings): TextChangeBudgetOptions {
  return {
    maxEstimatedDiffWork: settings.mergeMaxEstimatedDiffWork,
    maxTextBytesPerSide: settings.mergeMaxTextBytesPerSide,
    maxTextBytesCombined: settings.mergeMaxTextBytesCombined,
  };
}

export function resolveExactMarkerBudgets(
  settings: BuilderProjectSettings,
): TextChangeBudgetOptions {
  return {
    maxEstimatedDiffWork: settings.markerMaxEstimatedDiffWork,
    maxTextBytesPerSide: settings.markerMaxTextBytesPerSide,
    maxTextBytesCombined: settings.markerMaxTextBytesCombined,
  };
}

const SCAN_STEP_INTERVAL = 128;
const OPERATION_STEP_INTERVAL = 256;
const LCS_STEP_INTERVAL = 4096;

function requireDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }

  return value;
}

function drainDiffSteps<TResult>(steps: DiffSteps<TResult>): TResult {
  let step = steps.next();
  while (!step.done) {
    step = steps.next();
  }
  return step.value;
}

async function drainDiffStepsCooperative<TResult>(
  steps: DiffSteps<TResult>,
  yieldController: CooperativeYieldController,
): Promise<TResult> {
  let step = steps.next();
  while (!step.done) {
    await yieldController.maybeYield();
    step = steps.next();
  }
  return step.value;
}

export async function tryMergeTextContributionsCooperative(
  baseText: string,
  contributors: TextMergeContributor[],
  yieldController: CooperativeYieldController,
  budgets: TextChangeBudgetOptions,
): Promise<TextMergeResult> {
  const mergedEdits: TextLineEdit[] = [];

  for (const contributor of contributors) {
    await yieldController.maybeYield();
    let incomingEdits: TextLineEdit[];
    try {
      incomingEdits = await drainDiffStepsCooperative(
        diffTextToLineEditsSteps(baseText, contributor, budgets),
        yieldController,
      );
    } catch (error) {
      return toBudgetFailure(error);
    }
    for (const [editIndex, incomingEdit] of incomingEdits.entries()) {
      if (editIndex % 16 === 0) {
        await yieldController.maybeYield();
      }
      const identical = mergedEdits.find((existingEdit) =>
        areIdenticalEdits(existingEdit, incomingEdit),
      );
      if (identical) {
        continue;
      }

      const inheritedInsertionIndex = mergedEdits.findIndex((existingEdit) =>
        canResolveInheritedInsertion(existingEdit, incomingEdit),
      );
      if (inheritedInsertionIndex >= 0) {
        const existingEdit = requireDefined(
          mergedEdits[inheritedInsertionIndex],
          `Missing inherited insertion edit at index ${inheritedInsertionIndex}`,
        );
        if (existingEdit.newLines.length >= incomingEdit.newLines.length) {
          continue;
        }
        mergedEdits[inheritedInsertionIndex] = incomingEdit;
        continue;
      }

      const conflict = mergedEdits.find((existingEdit) => editsOverlap(existingEdit, incomingEdit));
      if (conflict) {
        return {
          ok: false,
          reason: 'conflict',
          conflict: {
            existing: conflict,
            incoming: incomingEdit,
          },
        };
      }

      mergedEdits.push(incomingEdit);
    }
  }

  mergedEdits.sort(compareEdits);
  return {
    ok: true,
    content: applyLineEdits(splitTextLines(baseText), mergedEdits),
    edits: mergedEdits,
  };
}

export function formatLineEditRange(edit: Pick<TextLineEdit, 'start' | 'end'>): string {
  if (edit.start === edit.end) {
    return `line ${edit.start + 1} insertion`;
  }
  if (edit.end === edit.start + 1) {
    return `line ${edit.start + 1}`;
  }
  return `lines ${edit.start + 1}-${edit.end}`;
}

export function describeTextChanges(
  baseText: string,
  nextText: string,
  contributor: Pick<TextMergeContributor, 'id' | 'label'>,
  budgets: TextChangeBudgetOptions,
): TextChangeDescriptionResult {
  try {
    return {
      ok: true,
      edits: drainDiffSteps(describedChangeSteps(baseText, nextText, contributor, budgets)),
    };
  } catch (error) {
    return toBudgetFailure(error);
  }
}

export async function describeTextChangesCooperative(
  baseText: string,
  nextText: string,
  contributor: Pick<TextMergeContributor, 'id' | 'label'>,
  yieldController: CooperativeYieldController,
  budgets: TextChangeBudgetOptions,
): Promise<TextChangeDescriptionResult> {
  try {
    return {
      ok: true,
      edits: await drainDiffStepsCooperative(
        describedChangeSteps(baseText, nextText, contributor, budgets),
        yieldController,
      ),
    };
  } catch (error) {
    return toBudgetFailure(error);
  }
}

function describedChangeSteps(
  baseText: string,
  nextText: string,
  contributor: Pick<TextMergeContributor, 'id' | 'label'>,
  budgets: TextChangeBudgetOptions,
): DiffSteps<TextLineEdit[]> {
  return diffTextToLineEditsSteps(baseText, { ...contributor, content: nextText }, budgets);
}

function toBudgetFailure(error: unknown): TextMergeBudgetFailure {
  if (error instanceof TextMergeBudgetError) {
    return {
      ok: false,
      reason: 'budget_exceeded',
      budget: error.budget,
    };
  }
  throw error;
}

function* diffTextToLineEditsSteps(
  baseText: string,
  contributor: TextMergeContributor,
  budgets: TextChangeBudgetOptions,
): DiffSteps<TextLineEdit[]> {
  assertWithinSizeBudget(baseText, contributor.content, contributor.label, budgets);

  const baseLines = splitTextLines(baseText);
  const nextLines = splitTextLines(contributor.content);
  const prefixLength = yield* measureCommonPrefixSteps(baseLines, nextLines);
  const suffixLength = yield* measureCommonSuffixSteps(baseLines, nextLines, prefixLength);
  const baseSlice = baseLines.slice(prefixLength, baseLines.length - suffixLength);
  const nextSlice = nextLines.slice(prefixLength, nextLines.length - suffixLength);
  assertWithinDiffBudget(baseSlice.length, nextSlice.length, contributor.label, budgets);

  const operations = yield* diffLineSlicesSteps(baseSlice, nextSlice);
  const edits: TextLineEdit[] = [];
  let baseIndex = prefixLength;
  let pendingStart: number | undefined;
  let pendingDeletedCount = 0;
  let pendingNewLines: string[] = [];

  const flushPending = () => {
    if (pendingStart === undefined) {
      return;
    }
    edits.push({
      start: pendingStart,
      end: pendingStart + pendingDeletedCount,
      newLines: pendingNewLines,
      contributorId: contributor.id,
      contributorLabel: contributor.label,
    });
    pendingStart = undefined;
    pendingDeletedCount = 0;
    pendingNewLines = [];
  };

  for (const [operationIndex, operation] of operations.entries()) {
    if (operationIndex % 32 === 0) {
      yield;
    }
    if (operation.kind === 'equal') {
      flushPending();
      baseIndex += 1;
      continue;
    }

    if (pendingStart === undefined) {
      pendingStart = baseIndex;
    }

    if (operation.kind === 'delete') {
      pendingDeletedCount += 1;
      baseIndex += 1;
      continue;
    }

    pendingNewLines.push(operation.value);
  }

  flushPending();
  return edits;
}

class TextMergeBudgetError extends Error {
  readonly budget: TextMergeBudgetExceeded;

  constructor(budget: TextMergeBudgetExceeded) {
    super('Text merge budget exceeded');
    this.budget = budget;
  }
}

function assertWithinSizeBudget(
  baseText: string,
  nextText: string,
  contributorLabel: string,
  budgets: TextChangeBudgetOptions,
): void {
  const baseBytes = Buffer.byteLength(baseText);
  const nextBytes = Buffer.byteLength(nextText);
  const combinedLength = baseBytes + nextBytes;
  if (
    baseBytes <= budgets.maxTextBytesPerSide &&
    nextBytes <= budgets.maxTextBytesPerSide &&
    combinedLength <= budgets.maxTextBytesCombined
  ) {
    return;
  }

  throw new TextMergeBudgetError({
    contributorLabel,
    changedBaseLines: 0,
    changedNextLines: 0,
    estimatedWork: combinedLength,
  });
}

function assertWithinDiffBudget(
  changedBaseLines: number,
  changedNextLines: number,
  contributorLabel: string,
  budgets: TextChangeBudgetOptions,
): void {
  const estimatedWork = changedBaseLines * changedNextLines;
  if (
    changedBaseLines === 0 ||
    changedNextLines === 0 ||
    estimatedWork <= budgets.maxEstimatedDiffWork
  ) {
    return;
  }

  throw new TextMergeBudgetError({
    contributorLabel,
    changedBaseLines,
    changedNextLines,
    estimatedWork,
  });
}

function* measureCommonPrefixSteps(left: string[], right: string[]): DiffSteps<number> {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    if (index % SCAN_STEP_INTERVAL === 0) {
      yield;
    }
    index += 1;
  }
  return index;
}

function* measureCommonSuffixSteps(
  left: string[],
  right: string[],
  prefixLength: number,
): DiffSteps<number> {
  const limit = Math.min(left.length - prefixLength, right.length - prefixLength);
  let index = 0;
  while (index < limit && left[left.length - 1 - index] === right[right.length - 1 - index]) {
    if (index % SCAN_STEP_INTERVAL === 0) {
      yield;
    }
    index += 1;
  }
  return index;
}

export function splitTextLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  // Split on `\n` only, keeping any `\r` inside its line. A lone `\r` is not a line
  // break anywhere else in YMB, and treating it as one here dropped the text before
  // it - which `applyLineEdits` would then write back to a live file without it.
  const matches = text.match(/[^\n]*(?:\n|$)/g) ?? [];
  if (matches.length > 0 && matches[matches.length - 1] === '') {
    matches.pop();
  }
  return matches;
}

function applyLineEdits(baseLines: string[], edits: TextLineEdit[]): string {
  let cursor = 0;
  const chunks: string[] = [];

  for (const edit of edits) {
    appendLines(chunks, baseLines, cursor, edit.start);
    appendLines(chunks, edit.newLines, 0, edit.newLines.length);
    cursor = edit.end;
  }

  appendLines(chunks, baseLines, cursor, baseLines.length);
  return chunks.join('');
}

/** Copy `source[start..end)` onto `target`, skipping indexes past the end of `source`. */
export function appendLines(target: string[], source: string[], start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    const line = source[index];
    if (line !== undefined) {
      target.push(line);
    }
  }
}

function areIdenticalEdits(left: TextLineEdit, right: TextLineEdit): boolean {
  return (
    left.start === right.start &&
    left.end === right.end &&
    left.newLines.length === right.newLines.length &&
    left.newLines.every((line, index) => line === right.newLines[index])
  );
}

function editsOverlap(left: TextLineEdit, right: TextLineEdit): boolean {
  const leftIsInsertion = left.start === left.end;
  const rightIsInsertion = right.start === right.end;

  if (leftIsInsertion && rightIsInsertion) {
    return left.start === right.start;
  }

  if (leftIsInsertion) {
    return left.start > right.start && left.start < right.end;
  }

  if (rightIsInsertion) {
    return right.start > left.start && right.start < left.end;
  }

  return Math.max(left.start, right.start) < Math.min(left.end, right.end);
}

function canResolveInheritedInsertion(left: TextLineEdit, right: TextLineEdit): boolean {
  return (
    left.start === left.end &&
    right.start === right.end &&
    left.start === right.start &&
    (startsWithLines(left.newLines, right.newLines) ||
      startsWithLines(right.newLines, left.newLines))
  );
}

function startsWithLines(value: string[], prefix: string[]): boolean {
  return prefix.length <= value.length && prefix.every((line, index) => value[index] === line);
}

function compareEdits(left: TextLineEdit, right: TextLineEdit): number {
  if (left.start !== right.start) {
    return left.start - right.start;
  }
  if (left.end !== right.end) {
    return left.end - right.end;
  }
  return left.contributorId.localeCompare(right.contributorId);
}

function* diffLineSlicesSteps(
  baseLines: string[],
  nextLines: string[],
): DiffSteps<DiffOperation[]> {
  const operations: DiffOperation[] = [];
  yield* appendLinearSpaceDiffSteps(
    baseLines,
    0,
    baseLines.length,
    nextLines,
    0,
    nextLines.length,
    operations,
  );
  return operations;
}

function* appendLinearSpaceDiffSteps(
  baseLines: string[],
  baseStart: number,
  baseEnd: number,
  nextLines: string[],
  nextStart: number,
  nextEnd: number,
  operations: DiffOperation[],
): DiffSteps<void> {
  let prefixWork = 0;
  while (
    baseStart < baseEnd &&
    nextStart < nextEnd &&
    baseLines[baseStart] === nextLines[nextStart]
  ) {
    pushOperation(operations, 'equal', baseLines, baseStart);
    baseStart += 1;
    nextStart += 1;
    prefixWork += 1;
    if (prefixWork >= SCAN_STEP_INTERVAL) {
      yield;
      prefixWork = 0;
    }
  }

  let suffixLength = 0;
  while (
    baseStart < baseEnd - suffixLength &&
    nextStart < nextEnd - suffixLength &&
    baseLines[baseEnd - 1 - suffixLength] === nextLines[nextEnd - 1 - suffixLength]
  ) {
    suffixLength += 1;
    if (suffixLength % SCAN_STEP_INTERVAL === 0) {
      yield;
    }
  }
  const coreBaseEnd = baseEnd - suffixLength;
  const coreNextEnd = nextEnd - suffixLength;

  if (baseStart === coreBaseEnd) {
    yield* appendOperationRangeSteps(operations, 'insert', nextLines, nextStart, coreNextEnd);
  } else if (nextStart === coreNextEnd) {
    yield* appendOperationRangeSteps(operations, 'delete', baseLines, baseStart, coreBaseEnd);
  } else if (coreBaseEnd - baseStart === 1 || coreNextEnd - nextStart === 1) {
    yield* appendSmallDiffSteps(
      baseLines,
      baseStart,
      coreBaseEnd,
      nextLines,
      nextStart,
      coreNextEnd,
      operations,
    );
  } else if (
    !(yield* rangesShareLineSteps(
      baseLines,
      baseStart,
      coreBaseEnd,
      nextLines,
      nextStart,
      coreNextEnd,
    ))
  ) {
    yield* appendOperationRangeSteps(operations, 'delete', baseLines, baseStart, coreBaseEnd);
    yield* appendOperationRangeSteps(operations, 'insert', nextLines, nextStart, coreNextEnd);
  } else {
    const baseMiddle = baseStart + Math.floor((coreBaseEnd - baseStart) / 2);
    const nextMiddle = yield* findLcsSplitSteps(
      baseLines,
      baseStart,
      baseMiddle,
      coreBaseEnd,
      nextLines,
      nextStart,
      coreNextEnd,
    );
    yield* appendLinearSpaceDiffSteps(
      baseLines,
      baseStart,
      baseMiddle,
      nextLines,
      nextStart,
      nextMiddle,
      operations,
    );
    yield* appendLinearSpaceDiffSteps(
      baseLines,
      baseMiddle,
      coreBaseEnd,
      nextLines,
      nextMiddle,
      coreNextEnd,
      operations,
    );
  }

  yield* appendOperationRangeSteps(operations, 'equal', baseLines, coreBaseEnd, baseEnd);
}

function* appendSmallDiffSteps(
  baseLines: string[],
  baseStart: number,
  baseEnd: number,
  nextLines: string[],
  nextStart: number,
  nextEnd: number,
  operations: DiffOperation[],
): DiffSteps<void> {
  if (baseEnd - baseStart === 1) {
    const baseLine = requireDefined(
      baseLines[baseStart],
      `Missing base line at index ${baseStart}`,
    );
    const equalIndex = nextLines.indexOf(baseLine, nextStart);
    if (equalIndex < nextStart || equalIndex >= nextEnd) {
      pushOperation(operations, 'delete', baseLines, baseStart);
      yield* appendOperationRangeSteps(operations, 'insert', nextLines, nextStart, nextEnd);
      return;
    }
    yield* appendOperationRangeSteps(operations, 'insert', nextLines, nextStart, equalIndex);
    pushOperation(operations, 'equal', baseLines, baseStart);
    yield* appendOperationRangeSteps(operations, 'insert', nextLines, equalIndex + 1, nextEnd);
    return;
  }

  const nextLine = requireDefined(nextLines[nextStart], `Missing next line at index ${nextStart}`);
  const equalIndex = baseLines.indexOf(nextLine, baseStart);
  if (equalIndex < baseStart || equalIndex >= baseEnd) {
    yield* appendOperationRangeSteps(operations, 'delete', baseLines, baseStart, baseEnd);
    pushOperation(operations, 'insert', nextLines, nextStart);
    return;
  }
  yield* appendOperationRangeSteps(operations, 'delete', baseLines, baseStart, equalIndex);
  pushOperation(operations, 'equal', baseLines, equalIndex);
  yield* appendOperationRangeSteps(operations, 'delete', baseLines, equalIndex + 1, baseEnd);
}

function* rangesShareLineSteps(
  baseLines: string[],
  baseStart: number,
  baseEnd: number,
  nextLines: string[],
  nextStart: number,
  nextEnd: number,
): DiffSteps<boolean> {
  const baseIsShorter = baseEnd - baseStart <= nextEnd - nextStart;
  const indexed = baseIsShorter ? baseLines : nextLines;
  const indexedStart = baseIsShorter ? baseStart : nextStart;
  const indexedEnd = baseIsShorter ? baseEnd : nextEnd;
  const scanned = baseIsShorter ? nextLines : baseLines;
  const scannedStart = baseIsShorter ? nextStart : baseStart;
  const scannedEnd = baseIsShorter ? nextEnd : baseEnd;

  const indexedLines = new Set<string>();
  for (let index = indexedStart; index < indexedEnd; index += 1) {
    if ((index - indexedStart) % OPERATION_STEP_INTERVAL === 0) {
      yield;
    }
    indexedLines.add(requireDefined(indexed[index], `Missing diff line at index ${index}`));
  }
  for (let index = scannedStart; index < scannedEnd; index += 1) {
    if ((index - scannedStart) % OPERATION_STEP_INTERVAL === 0) {
      yield;
    }
    if (indexedLines.has(requireDefined(scanned[index], `Missing diff line at index ${index}`))) {
      return true;
    }
  }
  return false;
}

function* findLcsSplitSteps(
  baseLines: string[],
  baseStart: number,
  baseMiddle: number,
  baseEnd: number,
  nextLines: string[],
  nextStart: number,
  nextEnd: number,
): DiffSteps<number> {
  const nextLength = nextEnd - nextStart;
  const forward = yield* computeLcsLengthsSteps(
    baseLines,
    baseStart,
    baseMiddle,
    nextLines,
    nextStart,
    nextEnd,
    'forward',
  );
  const backward = yield* computeLcsLengthsSteps(
    baseLines,
    baseMiddle,
    baseEnd,
    nextLines,
    nextStart,
    nextEnd,
    'backward',
  );
  let bestOffset = 0;
  let bestLength = -1;
  for (let offset = 0; offset <= nextLength; offset += 1) {
    if (offset % OPERATION_STEP_INTERVAL === 0) {
      yield;
    }
    const length =
      requireDefined(forward[offset], `Missing forward LCS length at ${offset}`) +
      requireDefined(backward[offset], `Missing backward LCS length at ${offset}`);
    if (length > bestLength) {
      bestLength = length;
      bestOffset = offset;
    }
  }
  return nextStart + bestOffset;
}

/**
 * One row of the LCS table at a time, in the given direction. `forward` measures
 * prefixes of the next slice, `backward` measures its suffixes, so the two arrays
 * meet at the split offset the caller is looking for.
 */
function* computeLcsLengthsSteps(
  baseLines: string[],
  baseStart: number,
  baseEnd: number,
  nextLines: string[],
  nextStart: number,
  nextEnd: number,
  direction: 'forward' | 'backward',
): DiffSteps<Int32Array> {
  const lengths = new Int32Array(nextEnd - nextStart + 1);
  const rowWork = Math.max(1, lengths.length - 1);
  let work = 0;

  for (
    let baseIndex = direction === 'forward' ? baseStart : baseEnd - 1;
    direction === 'forward' ? baseIndex < baseEnd : baseIndex >= baseStart;
    baseIndex += direction === 'forward' ? 1 : -1
  ) {
    let diagonal = 0;
    if (direction === 'forward') {
      for (let offset = 1; offset < lengths.length; offset += 1) {
        const previousRow = requireDefined(lengths[offset], `Missing LCS length at ${offset}`);
        lengths[offset] =
          baseLines[baseIndex] === nextLines[nextStart + offset - 1]
            ? diagonal + 1
            : Math.max(previousRow, requireDefined(lengths[offset - 1], 'Missing LCS prefix'));
        diagonal = previousRow;
      }
    } else {
      for (let offset = lengths.length - 2; offset >= 0; offset -= 1) {
        const previousRow = requireDefined(lengths[offset], `Missing LCS length at ${offset}`);
        lengths[offset] =
          baseLines[baseIndex] === nextLines[nextStart + offset]
            ? diagonal + 1
            : Math.max(previousRow, requireDefined(lengths[offset + 1], 'Missing LCS suffix'));
        diagonal = previousRow;
      }
    }

    work += rowWork;
    if (work >= LCS_STEP_INTERVAL) {
      yield;
      work = 0;
    }
  }
  return lengths;
}

function pushOperation(
  operations: DiffOperation[],
  kind: DiffOperation['kind'],
  lines: string[],
  index: number,
): void {
  operations.push({
    kind,
    value: requireDefined(lines[index], `Missing ${kind} line at index ${index}`),
  });
}

function* appendOperationRangeSteps(
  operations: DiffOperation[],
  kind: DiffOperation['kind'],
  lines: string[],
  start: number,
  end: number,
): DiffSteps<void> {
  for (let index = start; index < end; index += 1) {
    if ((index - start) % OPERATION_STEP_INTERVAL === 0) {
      yield;
    }
    pushOperation(operations, kind, lines, index);
  }
}
