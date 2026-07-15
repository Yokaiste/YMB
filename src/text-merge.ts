import type { CooperativeYieldController } from './async.ts';

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

type TextMergeResult =
  | {
      ok: true;
      content: string;
      edits: TextLineEdit[];
    }
  | {
      ok: false;
      reason: 'conflict';
      conflict: TextMergeConflict;
    }
  | {
      ok: false;
      reason: 'budget_exceeded';
      budget: TextMergeBudgetExceeded;
    };

type TextChangeDescriptionResult =
  | {
      ok: true;
      edits: TextLineEdit[];
    }
  | {
      ok: false;
      reason: 'budget_exceeded';
      budget: TextMergeBudgetExceeded;
    };

export interface TextChangeBudgetOptions {
  maxEstimatedDiffWork: number;
  maxEstimatedCharWork: number;
  maxTextBytesPerSide: number;
  maxTextBytesCombined: number;
}

interface DiffOperation {
  kind: 'equal' | 'insert' | 'delete';
  value: string;
}

const DEFAULT_TEXT_CHANGE_BUDGETS: TextChangeBudgetOptions = {
  maxEstimatedDiffWork: 50_000_000,
  maxEstimatedCharWork: 80_000_000,
  maxTextBytesPerSide: 4_000_000,
  maxTextBytesCombined: 6_000_000,
};

function requireDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }

  return value;
}

export function tryMergeTextContributions(
  baseText: string,
  contributors: TextMergeContributor[],
): TextMergeResult {
  const mergedEdits: TextLineEdit[] = [];

  for (const contributor of contributors) {
    let incomingEdits: TextLineEdit[];
    try {
      incomingEdits = diffTextToLineEdits(baseText, contributor);
    } catch (error) {
      if (error instanceof TextMergeBudgetError) {
        return {
          ok: false,
          reason: 'budget_exceeded',
          budget: error.budget,
        };
      }
      throw error;
    }
    for (const incomingEdit of incomingEdits) {
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
    content: applyLineEdits(splitLines(baseText), mergedEdits),
    edits: mergedEdits,
  };
}

export async function tryMergeTextContributionsCooperative(
  baseText: string,
  contributors: TextMergeContributor[],
  yieldController: CooperativeYieldController,
): Promise<TextMergeResult> {
  const mergedEdits: TextLineEdit[] = [];

  for (const [contributorIndex, contributor] of contributors.entries()) {
    await maybeYieldEvery(contributorIndex, 1, yieldController);
    let incomingEdits: TextLineEdit[];
    try {
      incomingEdits = await diffTextToLineEditsCooperative(baseText, contributor, yieldController);
    } catch (error) {
      if (error instanceof TextMergeBudgetError) {
        return {
          ok: false,
          reason: 'budget_exceeded',
          budget: error.budget,
        };
      }
      throw error;
    }
    for (const [editIndex, incomingEdit] of incomingEdits.entries()) {
      await maybeYieldEvery(editIndex, 16, yieldController);
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
    content: applyLineEdits(splitLines(baseText), mergedEdits),
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
  budgets: Partial<TextChangeBudgetOptions> = {},
): TextChangeDescriptionResult {
  try {
    return {
      ok: true,
      edits: diffTextToLineEdits(
        baseText,
        {
          ...contributor,
          content: nextText,
        },
        resolveTextChangeBudgetOptions(budgets),
      ),
    };
  } catch (error) {
    if (error instanceof TextMergeBudgetError) {
      return {
        ok: false,
        reason: 'budget_exceeded',
        budget: error.budget,
      };
    }
    throw error;
  }
}

export async function describeTextChangesCooperative(
  baseText: string,
  nextText: string,
  contributor: Pick<TextMergeContributor, 'id' | 'label'>,
  yieldController: CooperativeYieldController,
  budgets: Partial<TextChangeBudgetOptions> = {},
): Promise<TextChangeDescriptionResult> {
  try {
    return {
      ok: true,
      edits: await diffTextToLineEditsCooperative(
        baseText,
        {
          ...contributor,
          content: nextText,
        },
        yieldController,
        resolveTextChangeBudgetOptions(budgets),
      ),
    };
  } catch (error) {
    if (error instanceof TextMergeBudgetError) {
      return {
        ok: false,
        reason: 'budget_exceeded',
        budget: error.budget,
      };
    }
    throw error;
  }
}

export function splitTextLines(text: string): string[] {
  return splitLines(text);
}

function diffTextToLineEdits(
  baseText: string,
  contributor: TextMergeContributor,
  budgets: TextChangeBudgetOptions = DEFAULT_TEXT_CHANGE_BUDGETS,
): TextLineEdit[] {
  const absoluteSizeBudgetExceeded = resolveAbsoluteSizeBudgetExceeded(
    baseText,
    contributor.content,
    contributor.label,
    budgets,
  );
  if (absoluteSizeBudgetExceeded) {
    throw new TextMergeBudgetError(absoluteSizeBudgetExceeded.budget);
  }
  const rawBudgetExceeded = resolveRawBudgetExceeded(
    baseText,
    contributor.content,
    contributor.label,
    budgets,
  );
  if (rawBudgetExceeded) {
    throw new TextMergeBudgetError(rawBudgetExceeded.budget);
  }
  const baseLines = splitLines(baseText);
  const nextLines = splitLines(contributor.content);
  let prefixLength = 0;

  while (
    prefixLength < baseLines.length &&
    prefixLength < nextLines.length &&
    baseLines[prefixLength] === nextLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < baseLines.length - prefixLength &&
    suffixLength < nextLines.length - prefixLength &&
    baseLines[baseLines.length - 1 - suffixLength] ===
      nextLines[nextLines.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const baseSlice = baseLines.slice(prefixLength, baseLines.length - suffixLength);
  const nextSlice = nextLines.slice(prefixLength, nextLines.length - suffixLength);
  const budgetExceeded = resolveDiffBudgetExceeded(
    baseSlice.length,
    nextSlice.length,
    contributor.label,
    budgets,
  );
  if (budgetExceeded) {
    throw new TextMergeBudgetError(budgetExceeded.budget);
  }
  const operations = diffLineSlices(baseSlice, nextSlice);
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

  for (const operation of operations) {
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

async function diffTextToLineEditsCooperative(
  baseText: string,
  contributor: TextMergeContributor,
  yieldController: CooperativeYieldController,
  budgets: TextChangeBudgetOptions = DEFAULT_TEXT_CHANGE_BUDGETS,
): Promise<TextLineEdit[]> {
  const absoluteSizeBudgetExceeded = resolveAbsoluteSizeBudgetExceeded(
    baseText,
    contributor.content,
    contributor.label,
    budgets,
  );
  if (absoluteSizeBudgetExceeded) {
    throw new TextMergeBudgetError(absoluteSizeBudgetExceeded.budget);
  }
  const rawBudgetExceeded = resolveRawBudgetExceeded(
    baseText,
    contributor.content,
    contributor.label,
    budgets,
  );
  if (rawBudgetExceeded) {
    throw new TextMergeBudgetError(rawBudgetExceeded.budget);
  }
  const baseLines = splitLines(baseText);
  const nextLines = splitLines(contributor.content);
  const prefixLength = await measureCommonPrefixCooperative(baseLines, nextLines, yieldController);
  const suffixLength = await measureCommonSuffixCooperative(
    baseLines,
    nextLines,
    prefixLength,
    yieldController,
  );
  const baseSlice = baseLines.slice(prefixLength, baseLines.length - suffixLength);
  const nextSlice = nextLines.slice(prefixLength, nextLines.length - suffixLength);
  const budgetExceeded = resolveDiffBudgetExceeded(
    baseSlice.length,
    nextSlice.length,
    contributor.label,
    budgets,
  );
  if (budgetExceeded) {
    throw new TextMergeBudgetError(budgetExceeded.budget);
  }
  const operations = await diffLineSlicesCooperative(baseSlice, nextSlice, yieldController);
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
    await maybeYieldEvery(operationIndex, 32, yieldController);
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

function resolveAbsoluteSizeBudgetExceeded(
  baseText: string,
  nextText: string,
  contributorLabel: string,
  budgets: TextChangeBudgetOptions,
): Extract<TextMergeResult, { ok: false; reason: 'budget_exceeded' }> | undefined {
  const combinedLength = baseText.length + nextText.length;
  const exceedsBudget =
    baseText.length > budgets.maxTextBytesPerSide ||
    nextText.length > budgets.maxTextBytesPerSide ||
    combinedLength > budgets.maxTextBytesCombined;
  if (!exceedsBudget) {
    return undefined;
  }

  return {
    ok: false,
    reason: 'budget_exceeded',
    budget: {
      contributorLabel,
      changedBaseLines: 0,
      changedNextLines: 0,
      estimatedWork: combinedLength,
    },
  };
}

function resolveRawBudgetExceeded(
  baseText: string,
  nextText: string,
  contributorLabel: string,
  budgets: TextChangeBudgetOptions,
): Extract<TextMergeResult, { ok: false; reason: 'budget_exceeded' }> | undefined {
  const prefixLength = measureCommonPrefix(baseText, nextText);
  const suffixLength = measureCommonSuffix(baseText, nextText, prefixLength);
  const changedBaseChars = baseText.length - prefixLength - suffixLength;
  const changedNextChars = nextText.length - prefixLength - suffixLength;
  const estimatedWork = changedBaseChars * changedNextChars;
  if (
    !(changedBaseChars > 0 && changedNextChars > 0 && estimatedWork > budgets.maxEstimatedCharWork)
  ) {
    return undefined;
  }

  return {
    ok: false,
    reason: 'budget_exceeded',
    budget: {
      contributorLabel,
      changedBaseLines: 0,
      changedNextLines: 0,
      estimatedWork,
    },
  };
}

function resolveDiffBudgetExceeded(
  changedBaseLines: number,
  changedNextLines: number,
  contributorLabel: string,
  budgets: TextChangeBudgetOptions,
): Extract<TextMergeResult, { ok: false; reason: 'budget_exceeded' }> | undefined {
  const estimatedWork = changedBaseLines * changedNextLines;
  const exceedsBudget =
    changedBaseLines > 0 && changedNextLines > 0 && estimatedWork > budgets.maxEstimatedDiffWork;
  if (!exceedsBudget) {
    return undefined;
  }

  return {
    ok: false,
    reason: 'budget_exceeded',
    budget: {
      contributorLabel,
      changedBaseLines,
      changedNextLines,
      estimatedWork,
    },
  };
}

function measureCommonPrefix(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) {
    index += 1;
  }
  return index;
}

async function measureCommonPrefixCooperative(
  left: string[],
  right: string[],
  yieldController: CooperativeYieldController,
): Promise<number> {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    await maybeYieldEvery(index, 128, yieldController);
    index += 1;
  }
  return index;
}

function resolveTextChangeBudgetOptions(
  overrides: Partial<TextChangeBudgetOptions>,
): TextChangeBudgetOptions {
  return {
    ...DEFAULT_TEXT_CHANGE_BUDGETS,
    ...overrides,
  };
}

function measureCommonSuffix(left: string, right: string, prefixLength: number): number {
  const leftRemaining = left.length - prefixLength;
  const rightRemaining = right.length - prefixLength;
  const limit = Math.min(leftRemaining, rightRemaining);
  let index = 0;
  while (
    index < limit &&
    left.charCodeAt(left.length - 1 - index) === right.charCodeAt(right.length - 1 - index)
  ) {
    index += 1;
  }
  return index;
}

async function measureCommonSuffixCooperative(
  left: string[],
  right: string[],
  prefixLength: number,
  yieldController: CooperativeYieldController,
): Promise<number> {
  const leftRemaining = left.length - prefixLength;
  const rightRemaining = right.length - prefixLength;
  const limit = Math.min(leftRemaining, rightRemaining);
  let index = 0;
  while (index < limit && left[left.length - 1 - index] === right[right.length - 1 - index]) {
    await maybeYieldEvery(index, 128, yieldController);
    index += 1;
  }
  return index;
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  const matches = text.match(/[^\r\n]*(?:\r\n|\n|$)/g) ?? [];
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

function appendLines(target: string[], source: string[], start: number, end: number): void {
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

function diffLineSlices(baseLines: string[], nextLines: string[]): DiffOperation[] {
  if (baseLines.length === 0) {
    return nextLines.map((value) => ({ kind: 'insert' as const, value }));
  }
  if (nextLines.length === 0) {
    return baseLines.map((value) => ({ kind: 'delete' as const, value }));
  }

  const trace: Array<Map<number, number>> = [];
  let frontier = new Map<number, number>([[1, 0]]);
  const maxDepth = baseLines.length + nextLines.length;

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const current = new Map<number, number>();

    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      const nextX = frontier.get(diagonal + 1) ?? 0;
      const previousX = frontier.get(diagonal - 1) ?? 0;
      let x =
        diagonal === -depth || (diagonal !== depth && previousX < nextX) ? nextX : previousX + 1;
      let y = x - diagonal;

      while (x < baseLines.length && y < nextLines.length && baseLines[x] === nextLines[y]) {
        x += 1;
        y += 1;
      }

      current.set(diagonal, x);
      if (x >= baseLines.length && y >= nextLines.length) {
        trace.push(current);
        return backtrackDiff(trace, baseLines, nextLines);
      }
    }

    trace.push(current);
    frontier = current;
  }

  return [];
}

async function diffLineSlicesCooperative(
  baseLines: string[],
  nextLines: string[],
  yieldController: CooperativeYieldController,
): Promise<DiffOperation[]> {
  if (baseLines.length === 0) {
    return nextLines.map((value) => ({ kind: 'insert' as const, value }));
  }
  if (nextLines.length === 0) {
    return baseLines.map((value) => ({ kind: 'delete' as const, value }));
  }

  const trace: Array<Map<number, number>> = [];
  let frontier = new Map<number, number>([[1, 0]]);
  const maxDepth = baseLines.length + nextLines.length;

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    await maybeYieldEvery(depth, 4, yieldController);
    const current = new Map<number, number>();

    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      await maybeYieldEvery(diagonal + depth, 32, yieldController);
      const nextX = frontier.get(diagonal + 1) ?? 0;
      const previousX = frontier.get(diagonal - 1) ?? 0;
      let x =
        diagonal === -depth || (diagonal !== depth && previousX < nextX) ? nextX : previousX + 1;
      let y = x - diagonal;

      while (x < baseLines.length && y < nextLines.length && baseLines[x] === nextLines[y]) {
        await maybeYieldEvery(x + y, 128, yieldController);
        x += 1;
        y += 1;
      }

      current.set(diagonal, x);
      if (x >= baseLines.length && y >= nextLines.length) {
        trace.push(current);
        return backtrackDiffCooperative(trace, baseLines, nextLines, yieldController);
      }
    }

    trace.push(current);
    frontier = current;
  }

  return [];
}

function backtrackDiff(
  trace: Array<Map<number, number>>,
  baseLines: string[],
  nextLines: string[],
): DiffOperation[] {
  const operations: DiffOperation[] = [];
  let x = baseLines.length;
  let y = nextLines.length;

  for (let depth = trace.length - 1; depth > 0; depth -= 1) {
    const previous = requireDefined(trace[depth - 1], `Missing diff trace at depth ${depth - 1}`);
    const diagonal = x - y;
    const nextX = previous.get(diagonal + 1) ?? 0;
    const previousX = previous.get(diagonal - 1) ?? 0;
    const previousDiagonal =
      diagonal === -depth || (diagonal !== depth && previousX < nextX)
        ? diagonal + 1
        : diagonal - 1;
    const snakeX = previous.get(previousDiagonal) ?? 0;
    const snakeY = snakeX - previousDiagonal;

    while (x > snakeX && y > snakeY) {
      operations.unshift({
        kind: 'equal',
        value: requireDefined(baseLines[x - 1], `Missing base line at index ${x - 1}`),
      });
      x -= 1;
      y -= 1;
    }

    if (x === snakeX) {
      operations.unshift({
        kind: 'insert',
        value: requireDefined(nextLines[y - 1], `Missing next line at index ${y - 1}`),
      });
      y -= 1;
    } else {
      operations.unshift({
        kind: 'delete',
        value: requireDefined(baseLines[x - 1], `Missing base line at index ${x - 1}`),
      });
      x -= 1;
    }
  }

  while (x > 0 && y > 0) {
    operations.unshift({
      kind: 'equal',
      value: requireDefined(baseLines[x - 1], `Missing base line at index ${x - 1}`),
    });
    x -= 1;
    y -= 1;
  }
  while (x > 0) {
    operations.unshift({
      kind: 'delete',
      value: requireDefined(baseLines[x - 1], `Missing base line at index ${x - 1}`),
    });
    x -= 1;
  }
  while (y > 0) {
    operations.unshift({
      kind: 'insert',
      value: requireDefined(nextLines[y - 1], `Missing next line at index ${y - 1}`),
    });
    y -= 1;
  }

  return operations;
}

async function backtrackDiffCooperative(
  trace: Array<Map<number, number>>,
  baseLines: string[],
  nextLines: string[],
  yieldController: CooperativeYieldController,
): Promise<DiffOperation[]> {
  const operations: DiffOperation[] = [];
  let x = baseLines.length;
  let y = nextLines.length;

  for (let depth = trace.length - 1; depth > 0; depth -= 1) {
    await maybeYieldEvery(trace.length - depth, 4, yieldController);
    const previous = requireDefined(trace[depth - 1], `Missing diff trace at depth ${depth - 1}`);
    const diagonal = x - y;
    const nextX = previous.get(diagonal + 1) ?? 0;
    const previousX = previous.get(diagonal - 1) ?? 0;
    const previousDiagonal =
      diagonal === -depth || (diagonal !== depth && previousX < nextX)
        ? diagonal + 1
        : diagonal - 1;
    const snakeX = previous.get(previousDiagonal) ?? 0;
    const snakeY = snakeX - previousDiagonal;

    while (x > snakeX && y > snakeY) {
      await maybeYieldEvery(x + y, 128, yieldController);
      operations.unshift({
        kind: 'equal',
        value: requireDefined(baseLines[x - 1], `Missing base line at index ${x - 1}`),
      });
      x -= 1;
      y -= 1;
    }

    if (x === snakeX) {
      operations.unshift({
        kind: 'insert',
        value: requireDefined(nextLines[y - 1], `Missing next line at index ${y - 1}`),
      });
      y -= 1;
    } else {
      operations.unshift({
        kind: 'delete',
        value: requireDefined(baseLines[x - 1], `Missing base line at index ${x - 1}`),
      });
      x -= 1;
    }
  }

  while (x > 0 && y > 0) {
    await maybeYieldEvery(x + y, 128, yieldController);
    operations.unshift({
      kind: 'equal',
      value: requireDefined(baseLines[x - 1], `Missing base line at index ${x - 1}`),
    });
    x -= 1;
    y -= 1;
  }
  while (x > 0) {
    await maybeYieldEvery(x, 128, yieldController);
    operations.unshift({
      kind: 'delete',
      value: requireDefined(baseLines[x - 1], `Missing base line at index ${x - 1}`),
    });
    x -= 1;
  }
  while (y > 0) {
    await maybeYieldEvery(y, 128, yieldController);
    operations.unshift({
      kind: 'insert',
      value: requireDefined(nextLines[y - 1], `Missing next line at index ${y - 1}`),
    });
    y -= 1;
  }

  return operations;
}

async function maybeYieldEvery(
  index: number,
  batchSize: number,
  yieldController: CooperativeYieldController,
): Promise<void> {
  if (index % batchSize === 0) {
    await yieldController.maybeYield();
  }
}
