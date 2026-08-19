import { ensure } from '../../errors.ts';
import type {
  BulkCondition,
  BulkEdit,
  BulkListEdit,
  BulkMatch,
  BulkOperation,
  BulkValueEdit,
  PatchApplication,
} from '../../types.ts';
import type { NdfTextBuffer } from './buffer.ts';
import {
  lineHasComment,
  renderLeadingComment,
  renderTrailingComment,
  splitTrailingComment,
  withTrailingComment,
} from './comments.ts';
import { createPatchNotice, type PatchNoticeSink } from './notices.ts';
import {
  extractFirstCollectionRange,
  findAllMapEntryRanges,
  findAllNestedFieldRanges,
  findCollectionEntries,
  findNestedFieldRange,
  readNestedFieldValue,
} from './scan.ts';
import {
  formatNdfValue,
  preserveOuterWhitespace,
  readLineIndent,
  type TopLevelBlock,
  toPatchErrorIdentity,
} from './shared.ts';

interface Splice {
  start: number;
  end: number;
  text: string;
  annotation?: boolean;
}

/**
 * `alreadySet` counts targets found holding the value the edit writes: nothing is
 * spliced, but the rule did reach them. That is what lets `minChanges` tell a rule
 * that stopped matching from game data that already agrees.
 */
interface EditOutcome {
  splices: Splice[];
  alreadySet: number;
}

interface BulkErrorContext {
  application: PatchApplication;
  absolutePath: string;
  operationIndex: number;
}

export function applyBulkOperation(
  buffer: NdfTextBuffer,
  operation: BulkOperation,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  onNotice?: PatchNoticeSink | undefined,
): void {
  const context = { application, absolutePath, operationIndex };
  validateResolvedEdits(operation, context);
  const unreached = createUnreachedValueTracker(operation);
  const matchedBlocks = buffer
    .blocks()
    .filter((block) => matchesBlock(block, operation.match, unreached));
  reportUnreachedConditionValues(unreached, operation, context, onNotice);

  ensure(matchedBlocks.length >= operation.expect.minBlocks, 'SelectorError', {
    ...errorOwner(context),
    reason: `Bulk operation matched ${matchedBlocks.length} block(s) but expects at least ${operation.expect.minBlocks}.`,
    suggestion:
      'Re-check the conditions after game-data changes, or lower `expect.minBlocks` when fewer matches are intentional.',
    details: describeConditions(operation.match),
  });

  const changesPerEdit = operation.edits.map(() => 0);
  const alreadySetPerEdit = operation.edits.map(() => 0);
  const rewrites = matchedBlocks.flatMap((block) => {
    const text = rewriteBlock(block.text, operation, changesPerEdit, alreadySetPerEdit, context);
    return text === undefined ? [] : [{ block, text }];
  });

  for (const [editIndex, edit] of operation.edits.entries()) {
    assertEditMetItsExpectation(
      {
        editIndex,
        edit,
        changes: changesPerEdit[editIndex] ?? 0,
        alreadySet: alreadySetPerEdit[editIndex] ?? 0,
        matchedBlocks: matchedBlocks.length,
      },
      context,
      onNotice,
    );
  }

  // Applied from the back, so a rewrite never shifts the offsets of one that
  // has not been applied yet.
  for (const rewrite of rewrites.reverse()) {
    buffer.replaceTopLevelRange(rewrite.block.start, rewrite.block.end, rewrite.text);
  }
}

interface EditExpectation {
  editIndex: number;
  edit: BulkEdit;
  changes: number;
  alreadySet: number;
  matchedBlocks: number;
}

/**
 * A value already equal to what the edit writes counts towards `minChanges`: the
 * rule found its target and had nothing left to do.
 */
function assertEditMetItsExpectation(
  expectation: EditExpectation,
  context: BulkErrorContext,
  onNotice: PatchNoticeSink | undefined,
): void {
  const { editIndex, edit, changes, alreadySet, matchedBlocks } = expectation;
  const minimum = edit.minChanges ?? 0;
  if (changes >= minimum) {
    reportEditThatChangedNothing(expectation, context, onNotice);
    return;
  }

  ensure(changes + alreadySet >= minimum, 'SelectorError', {
    ...errorOwner(context),
    reason: `Bulk edit ${editIndex} changed ${changes} value(s) across ${matchedBlocks} matched block(s) but expects at least ${minimum}.`,
    suggestion:
      'Re-check the edit target after game-data changes, or lower `minChanges` when fewer changes are intentional.',
    details: [
      describeEditTarget(edit),
      ...(alreadySet > 0 ? [`${alreadySet} target(s) already held the new value.`] : []),
    ],
  });

  onNotice?.(
    createPatchNotice(
      context.application,
      context.absolutePath,
      context.operationIndex,
      `Bulk edit ${editIndex} changed ${changes} value(s), under \`minChanges: ${minimum}\`, because ${alreadySet} target(s) already held the new value.`,
      'Lower `minChanges` to what this rule still changes, or drop the edit if the game data already says this.',
    ),
  );
}

/**
 * An edit that wrote nothing, on a rule with no `minChanges` to catch it. A target
 * the blocks do not have is a wrong name; a target already holding the value is an
 * edit the game data has caught up with.
 */
function reportEditThatChangedNothing(
  expectation: EditExpectation,
  context: BulkErrorContext,
  onNotice: PatchNoticeSink | undefined,
): void {
  const { editIndex, edit, changes, alreadySet, matchedBlocks } = expectation;
  // Nothing matched is the operation's own problem, and `expect.minBlocks`
  // already owns it. Saying it again per edit would bury the one line that
  // matters under one per edit.
  if (changes > 0 || matchedBlocks === 0) return;

  onNotice?.(
    createPatchNotice(
      context.application,
      context.absolutePath,
      context.operationIndex,
      alreadySet > 0
        ? `Bulk edit ${editIndex} (${describeEditTarget(edit)}) changed nothing: all ${alreadySet} target(s) across ${matchedBlocks} matched block(s) already hold this value.`
        : `Bulk edit ${editIndex} changed nothing, because none of the ${matchedBlocks} matched block(s) have \`${describeEditTarget(edit)}\`.`,
      alreadySet > 0
        ? 'Drop the edit if the game data already says this, or set the value you actually want.'
        : 'Check the target name against the file, or narrow `match` to the blocks that do have it.',
    ),
  );
}

function validateResolvedEdits(operation: BulkOperation, context: BulkErrorContext): void {
  for (const [editIndex, edit] of operation.edits.entries()) {
    if (edit.multiply === undefined) continue;
    ensure(typeof edit.multiply === 'number' && Number.isFinite(edit.multiply), 'ConfigError', {
      ...errorOwner(context),
      reason: `Bulk edit ${editIndex} \`multiply\` must resolve to a finite number.`,
      suggestion: 'Set the referenced template variable to a finite number.',
      details: [`Resolved value: ${String(edit.multiply)}`],
    });
  }
}

function errorOwner(context: BulkErrorContext) {
  return toPatchErrorIdentity(context.application, context.absolutePath, context.operationIndex);
}

function describeEditTarget(edit: BulkEdit): string {
  if (edit.field !== undefined) return `field: ${edit.field}`;
  if (edit.mapEntry !== undefined) return `mapEntry: ${edit.mapEntry}`;
  return `list: ${edit.list}`;
}

function describeConditions(match: BulkMatch): string[] {
  return match.conditions.map(
    (condition) =>
      `${match.mode}: ${condition.on}${condition.field ? `(${condition.field})` : ''} ${condition.is} ${condition.value.join(' | ')}`,
  );
}

/**
 * One set per condition of the values nothing has satisfied, so a literal no block
 * can match is left over at the end. `expect.minBlocks: 0` opts out.
 */
type UnreachedValues = Array<Set<string>> | undefined;

function createUnreachedValueTracker(operation: BulkOperation): UnreachedValues {
  if (operation.expect.minBlocks === 0) return undefined;
  return operation.match.conditions.map((condition) =>
    // A `notContains` value that matches nothing is the case it was written for,
    // not a miss, so it is never tracked.
    condition.is === 'notContains' ? new Set<string>() : new Set(condition.value),
  );
}

/**
 * A value list is an `or` and `minBlocks` counts the whole operation, so one wrong
 * literal stays invisible behind neighbours that match enough blocks.
 */
function reportUnreachedConditionValues(
  unreached: UnreachedValues,
  operation: BulkOperation,
  context: BulkErrorContext,
  onNotice: PatchNoticeSink | undefined,
): void {
  if (!unreached || !onNotice) return;
  const missed = unreached.flatMap((values, conditionIndex) => {
    const condition = operation.match.conditions[conditionIndex];
    return condition ? [...values].map((value) => describeConditionValue(condition, value)) : [];
  });
  if (missed.length === 0) return;

  onNotice(
    createPatchNotice(
      context.application,
      context.absolutePath,
      context.operationIndex,
      `Bulk match ${missed.length === 1 ? 'value' : 'values'} ${missed.join(', ')} matched no block in this file, so ${missed.length === 1 ? 'it reaches' : 'they reach'} nothing.`,
      'Check the spelling against the file, drop the value if the game no longer ships it, or set `expect.minBlocks: 0` when it belongs to a mod that may not be layered.',
    ),
  );
}

function describeConditionValue(condition: BulkCondition, value: string): string {
  return `\`${condition.on}${condition.field ? `(${condition.field})` : ''} ${condition.is} ${value}\``;
}

function matchesBlock(block: TopLevelBlock, match: BulkMatch, unreached: UnreachedValues): boolean {
  const results = match.conditions.map((condition, conditionIndex) =>
    matchesCondition(block, condition, unreached?.[conditionIndex]),
  );
  return match.mode === 'any' ? results.some(Boolean) : results.every(Boolean);
}

function matchesCondition(
  block: TopLevelBlock,
  condition: BulkCondition,
  unreached: Set<string> | undefined,
): boolean {
  const subject = readConditionSubject(block, condition);
  if (condition.is === 'notContains') {
    return condition.value.every((value) => !subject.includes(value));
  }

  let matched = false;
  for (const value of condition.value) {
    if (!satisfiesConditionValue(subject, condition.is, value)) continue;
    matched = true;
    unreached?.delete(value);
    // Every value has to be tried while any of them is still unaccounted for;
    // after that the first hit is the whole answer.
    if (!unreached || unreached.size === 0) break;
  }
  return matched;
}

function satisfiesConditionValue(
  subject: string,
  is: Exclude<BulkCondition['is'], 'notContains'>,
  value: string,
): boolean {
  switch (is) {
    case 'startsWith':
      return subject.startsWith(value);
    case 'endsWith':
      return subject.endsWith(value);
    case 'contains':
      return subject.includes(value);
  }
}

function readConditionSubject(block: TopLevelBlock, condition: BulkCondition): string {
  switch (condition.on) {
    case 'name':
      return block.name ?? '';
    case 'type':
      return block.typeName;
    case 'text':
      return block.text;
    case 'field':
      return readNestedFieldValue(block.text, condition.field) ?? '';
  }
}

function rewriteBlock(
  blockText: string,
  operation: BulkOperation,
  changesPerEdit: number[],
  alreadySetPerEdit: number[],
  context: BulkErrorContext,
): string | undefined {
  const splices: Splice[] = [];

  for (const [editIndex, edit] of operation.edits.entries()) {
    const outcome = collectEditSplices(blockText, edit);
    changesPerEdit[editIndex] =
      (changesPerEdit[editIndex] ?? 0) +
      outcome.splices.filter((splice) => !splice.annotation).length;
    alreadySetPerEdit[editIndex] = (alreadySetPerEdit[editIndex] ?? 0) + outcome.alreadySet;
    splices.push(...outcome.splices);
  }

  if (splices.length > 0) {
    const leadingComment = collectLeadingComment(blockText, operation.leadingComment);
    if (leadingComment) splices.push(leadingComment);
  }
  ensureNonOverlappingSplices(splices, context);
  return applySplices(blockText, splices);
}

function collectEditSplices(blockText: string, edit: BulkEdit): EditOutcome {
  if (isBulkListEdit(edit)) {
    return collectListSplices(blockText, edit, edit.list);
  }

  const valueRanges =
    edit.field !== undefined
      ? findAllNestedFieldRanges(blockText, edit.field)
      : findAllMapEntryRanges(blockText, edit.mapEntry);
  return mergeEditOutcomes(valueRanges.map((range) => collectValueSplices(blockText, edit, range)));
}

function mergeEditOutcomes(outcomes: EditOutcome[]): EditOutcome {
  return {
    splices: outcomes.flatMap((outcome) => outcome.splices),
    alreadySet: outcomes.reduce((total, outcome) => total + outcome.alreadySet, 0),
  };
}

function isBulkListEdit(edit: BulkEdit): edit is BulkListEdit {
  return edit.list !== undefined;
}

function collectValueSplices(
  blockText: string,
  edit: BulkValueEdit,
  range: { valueStart: number; valueEnd: number },
): EditOutcome {
  const currentValue = blockText.slice(range.valueStart, range.valueEnd);
  const currentCore = currentValue.trim();
  const { code, trailingComment } = splitTrailingComment(currentCore);
  const nextCode = renderNextValue(code, edit);
  // `undefined` is a value this edit cannot act on at all - `multiply` over
  // something that is not a number - which is not the same as one it has already
  // reached.
  if (nextCode === undefined) return { splices: [], alreadySet: 0 };
  if (nextCode === code) return { splices: [], alreadySet: 1 };

  const nextCore = withTrailingComment(nextCode, trailingComment);
  const splices: Splice[] = [
    {
      start: range.valueStart,
      end: range.valueEnd,
      text: preserveOuterWhitespace(currentValue, nextCore),
    },
  ];
  const comment = renderTrailingComment(edit.trailingComment, code);
  if (comment) {
    const lineEnd = resolveLineEnd(blockText, range.valueEnd);
    if (!lineHasComment(blockText, lineEnd)) {
      const flattened = lineEnd === blockText.length;
      splices.push({
        start: flattened ? range.valueEnd : lineEnd,
        end: flattened ? range.valueEnd : lineEnd,
        text: flattened ? `${comment}\n` : comment,
        annotation: true,
      });
    }
  }
  return { splices, alreadySet: 0 };
}

function renderNextValue(currentCore: string, edit: BulkValueEdit): string | undefined {
  return edit.multiply !== undefined
    ? multiplyNdfNumber(currentCore, edit.multiply)
    : formatNdfValue(edit.set);
}

function multiplyNdfNumber(currentCore: string, factor: number): string | undefined {
  if (!/^-?\d+(?:\.\d+)?$/.test(currentCore)) return undefined;
  const product = Number(currentCore) * factor;
  if (!Number.isFinite(product)) return undefined;
  if (!currentCore.includes('.')) return String(Math.round(product));
  const decimals = Math.max(currentCore.split('.')[1]?.length ?? 1, 1);
  return product.toFixed(Math.min(decimals, 6));
}

function collectListSplices(blockText: string, edit: BulkListEdit, listName: string): EditOutcome {
  const fieldRange = findNestedFieldRange(blockText, listName);
  if (!fieldRange) return { splices: [], alreadySet: 0 };

  const valueText = blockText.slice(fieldRange.valueStart, fieldRange.valueEnd);
  const collectionStart = fieldRange.valueStart;
  const entries = findCollectionEntries(valueText);

  if (edit.removeEntry !== undefined) {
    const target = normalizeEntry(edit.removeEntry);
    return {
      splices: entries
        .filter((entry) => normalizeEntry(entry.text) === target)
        .map((entry) =>
          expandToWholeLine(
            blockText,
            collectionStart + entry.start,
            collectionStart + entry.separatorEnd,
          ),
        ),
      alreadySet: 0,
    };
  }

  if (edit.setEntry !== undefined) {
    const index =
      edit.setEntry.index < 0 ? entries.length + edit.setEntry.index : edit.setEntry.index;
    const entry = entries[index];
    const nextText = formatNdfValue(edit.setEntry.value);
    if (!entry) return { splices: [], alreadySet: 0 };
    if (normalizeEntry(entry.text) === nextText) return { splices: [], alreadySet: 1 };
    return {
      splices: [
        {
          start: collectionStart + entry.start,
          end: collectionStart + entry.end,
          text: nextText,
        },
      ],
      alreadySet: 0,
    };
  }

  const insertion = edit.insert;
  if (!insertion) return { splices: [], alreadySet: 0 };
  const entryText = formatNdfValue(insertion.value);
  if (entries.some((entry) => normalizeEntry(entry.text) === entryText)) {
    return { splices: [], alreadySet: 1 };
  }
  if (entries.length === 0) {
    return {
      splices: insertIntoEmptyCollection(blockText, collectionStart, valueText, entryText),
      alreadySet: 0,
    };
  }

  const anchor = insertion.position === 'start' ? entries[0] : entries.at(-1);
  if (!anchor) return { splices: [], alreadySet: 0 };
  const indent = readEntryIndent(valueText, anchor.start);
  if (insertion.position === 'start') {
    return {
      splices: [
        {
          start: collectionStart + anchor.start,
          end: collectionStart + anchor.start,
          text: `${entryText},\n${indent}`,
        },
      ],
      alreadySet: 0,
    };
  }

  // A last entry with no trailing comma has `separatorStart === separatorEnd` at the
  // collection's inner end, so appending there needs the separator the anchor never
  // wrote - otherwise the two entries fuse into one invalid token.
  const anchorEndsWithSeparator = anchor.separatorEnd > anchor.separatorStart;
  const insertAt = anchorEndsWithSeparator ? anchor.separatorEnd : anchor.end;
  return {
    splices: [
      {
        start: collectionStart + insertAt,
        end: collectionStart + insertAt,
        text: `${anchorEndsWithSeparator ? '' : ','}\n${indent}${entryText},`,
      },
    ],
    alreadySet: 0,
  };
}

function insertIntoEmptyCollection(
  blockText: string,
  collectionStart: number,
  valueText: string,
  entryText: string,
): Splice[] {
  const collection = extractFirstCollectionRange(valueText);
  if (!collection) return [];
  const interiorStart = collectionStart + collection.start + 1;
  const interiorEnd = collectionStart + collection.end - 1;
  const fieldIndent = readLineIndent(blockText, collectionStart);
  const entryIndent = `${fieldIndent}    `;
  return [
    {
      start: interiorStart,
      end: interiorEnd,
      text: `\n${entryIndent}${entryText},\n${fieldIndent}`,
    },
  ];
}

function expandToWholeLine(text: string, start: number, end: number): Splice {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const expandedStart = /^[ \t]*$/.test(text.slice(lineStart, start)) ? lineStart : start;
  const lineEnd = resolveLineEnd(text, end);
  const expandedEnd = /^[ \t\r]*$/.test(text.slice(end, lineEnd)) ? lineEnd + 1 : end;
  return { start: expandedStart, end: expandedEnd, text: '' };
}

function normalizeEntry(entryText: string): string {
  return entryText.trim().replace(/,$/, '').trim();
}

function readEntryIndent(collectionText: string, entryStart: number): string {
  const lineStart = collectionText.lastIndexOf('\n', entryStart - 1);
  const prefix = collectionText.slice(lineStart + 1, entryStart);
  return /^[ \t]*$/.test(prefix) ? prefix : '    ';
}

function collectLeadingComment(blockText: string, comment: string | undefined): Splice | undefined {
  const round = blockText.indexOf('(');
  const square = blockText.indexOf('[');
  const opener = [round, square].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  if (opener === undefined) return undefined;

  const openerLineStart = blockText.lastIndexOf('\n', opener - 1) + 1;
  if (openerLineStart > 0) {
    const indent = readLineIndent(blockText, opener);
    const rendered = renderLeadingComment(comment, indent);
    return rendered
      ? { start: openerLineStart, end: openerLineStart, text: rendered, annotation: true }
      : undefined;
  }

  let spacingStart = opener;
  while (spacingStart > 0 && /[ \t]/.test(blockText[spacingStart - 1] ?? '')) {
    spacingStart -= 1;
  }
  const rendered = renderLeadingComment(comment, '');
  if (!rendered) return undefined;
  return {
    start: spacingStart,
    end: opener,
    text: `\n${rendered}`,
    annotation: true,
  };
}

function resolveLineEnd(text: string, fromIndex: number): number {
  const lineEnd = text.indexOf('\n', fromIndex);
  return lineEnd < 0 ? text.length : lineEnd;
}

function ensureNonOverlappingSplices(splices: Splice[], context: BulkErrorContext): void {
  const ordered = [...splices].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let coveredUntil = 0;
  for (const splice of ordered) {
    ensure(splice.start >= coveredUntil, 'ConflictError', {
      ...errorOwner(context),
      reason: 'Two edits in this bulk operation write over the same text in one matched block.',
      // Usually not a duplicate at all: one edit's field sits inside the value
      // another edit replaces wholesale, so whichever ran second would write into
      // text the first had already rewritten.
      suggestion:
        "Check whether one edit targets a field nested inside another edit's value. Narrow one of them, or split the dependent edit into its own bulk operation so it runs against the finished text.",
    });
    coveredUntil = Math.max(coveredUntil, splice.end);
  }
}

function applySplices(text: string, splices: Splice[]): string | undefined {
  if (splices.length === 0) return undefined;
  const ordered = [...splices].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const parts: string[] = [];
  let cursor = 0;
  for (const splice of ordered) {
    parts.push(text.slice(cursor, splice.start), splice.text);
    cursor = splice.end;
  }
  parts.push(text.slice(cursor));
  const nextText = parts.join('');
  return nextText === text ? undefined : nextText;
}
