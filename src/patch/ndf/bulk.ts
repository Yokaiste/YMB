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
import {
  applyTopLevelBlockRewrites,
  extractFirstCollectionRange,
  findAllMapEntryRanges,
  findAllNestedFieldRanges,
  findCollectionEntries,
  findNestedFieldRange,
  findTopLevelBlocks,
  readNestedFieldValue,
} from './scan.ts';
import {
  advanceStringState,
  formatNdfValue,
  preserveOuterWhitespace,
  readLineIndent,
  renderLeadingOperationComment,
  type StringDelimiter,
  startsLineComment,
  type TopLevelBlock,
} from './shared.ts';

interface Splice {
  start: number;
  end: number;
  text: string;
  annotation?: boolean;
}

interface BulkErrorContext {
  application: PatchApplication;
  absolutePath: string;
  operationIndex: number;
}

export function applyBulkOperation(
  currentText: string,
  operation: BulkOperation,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
): string {
  const context = { application, absolutePath, operationIndex };
  validateResolvedEdits(operation, context);
  const matchedBlocks = findTopLevelBlocks(currentText).filter((block) =>
    matchesBlock(block, operation.match),
  );

  ensure(matchedBlocks.length >= operation.expect.minBlocks, 'SelectorError', {
    ...errorOwner(context),
    reason: `Bulk operation matched ${matchedBlocks.length} block(s) but expects at least ${operation.expect.minBlocks}.`,
    suggestion:
      'Re-check the conditions after game-data changes, or lower `expect.minBlocks` when fewer matches are intentional.',
    details: describeConditions(operation.match),
  });

  const changesPerEdit = operation.edits.map(() => 0);
  const rewrites = matchedBlocks.flatMap((block) => {
    const text = rewriteBlock(block.text, operation, changesPerEdit, context);
    return text === undefined ? [] : [{ block, text }];
  });

  for (const [editIndex, edit] of operation.edits.entries()) {
    const changes = changesPerEdit[editIndex] ?? 0;
    const minimum = edit.minChanges ?? 0;
    ensure(changes >= minimum, 'SelectorError', {
      ...errorOwner(context),
      reason: `Bulk edit ${editIndex} changed ${changes} value(s) across ${matchedBlocks.length} matched block(s) but expects at least ${minimum}.`,
      suggestion:
        'Re-check the edit target after game-data changes, or lower `minChanges` when fewer changes are intentional.',
      details: [describeEditTarget(edit)],
    });
  }

  return applyTopLevelBlockRewrites(currentText, rewrites);
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
  return {
    absolutePath: context.absolutePath,
    modId: context.application.mod.config.id,
    modName: context.application.mod.config.name,
    patchId: context.application.patch.config.id,
    operationIndex: context.operationIndex,
  };
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

function matchesBlock(block: TopLevelBlock, match: BulkMatch): boolean {
  const results = match.conditions.map((condition) => matchesCondition(block, condition));
  return match.mode === 'any' ? results.some(Boolean) : results.every(Boolean);
}

function matchesCondition(block: TopLevelBlock, condition: BulkCondition): boolean {
  const subject = readConditionSubject(block, condition);
  switch (condition.is) {
    case 'startsWith':
      return condition.value.some((value) => subject.startsWith(value));
    case 'endsWith':
      return condition.value.some((value) => subject.endsWith(value));
    case 'contains':
      return condition.value.some((value) => subject.includes(value));
    case 'notContains':
      return condition.value.every((value) => !subject.includes(value));
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
  context: BulkErrorContext,
): string | undefined {
  const splices: Splice[] = [];

  for (const [editIndex, edit] of operation.edits.entries()) {
    const editSplices = collectEditSplices(blockText, edit);
    changesPerEdit[editIndex] =
      (changesPerEdit[editIndex] ?? 0) + editSplices.filter((splice) => !splice.annotation).length;
    splices.push(...editSplices);
  }

  if (splices.length > 0) {
    const leadingComment = collectLeadingComment(blockText, operation.leadingComment);
    if (leadingComment) splices.push(leadingComment);
  }
  ensureNonOverlappingSplices(splices, context);
  return applySplices(blockText, splices);
}

function collectEditSplices(blockText: string, edit: BulkEdit): Splice[] {
  if (isBulkListEdit(edit)) {
    return collectListSplices(blockText, edit, edit.list);
  }

  const valueRanges =
    edit.field !== undefined
      ? findAllNestedFieldRanges(blockText, edit.field)
      : findAllMapEntryRanges(blockText, edit.mapEntry);
  return valueRanges.flatMap((range) => collectValueSplices(blockText, edit, range));
}

function isBulkListEdit(edit: BulkEdit): edit is BulkListEdit {
  return edit.list !== undefined;
}

function collectValueSplices(
  blockText: string,
  edit: BulkValueEdit,
  range: { valueStart: number; valueEnd: number },
): Splice[] {
  const currentValue = blockText.slice(range.valueStart, range.valueEnd);
  const currentCore = currentValue.trim();
  const { code, trailingComment } = splitTrailingComment(currentCore);
  const nextCode = renderNextValue(code, edit);
  if (nextCode === undefined || nextCode === code) return [];

  const nextCore = trailingComment ? `${nextCode} ${trailingComment}` : nextCode;
  const splices: Splice[] = [
    {
      start: range.valueStart,
      end: range.valueEnd,
      text: preserveOuterWhitespace(currentValue, nextCore),
    },
  ];
  const comment = renderComment(edit.comment, code);
  if (comment) {
    const lineEnd = resolveLineEnd(blockText, range.valueEnd);
    if (!hasTrailingComment(blockText, lineEnd)) {
      const flattened = lineEnd === blockText.length;
      splices.push({
        start: flattened ? range.valueEnd : lineEnd,
        end: flattened ? range.valueEnd : lineEnd,
        text: flattened ? `${comment}\n` : comment,
        annotation: true,
      });
    }
  }
  return splices;
}

function splitTrailingComment(core: string): { code: string; trailingComment?: string } {
  let inString: StringDelimiter | undefined;
  for (let index = 0; index < core.length; index += 1) {
    if (!inString && startsLineComment(core[index] ?? '', core[index + 1])) {
      return { code: core.slice(0, index).trimEnd(), trailingComment: core.slice(index) };
    }
    inString = advanceStringState(inString, core, index);
  }
  return { code: core };
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

function renderComment(comment: string | undefined, originalCore: string): string | undefined {
  return comment === undefined ? undefined : ` // ${comment} (was ${originalCore})`;
}

function collectListSplices(blockText: string, edit: BulkListEdit, listName: string): Splice[] {
  const fieldRange = findNestedFieldRange(blockText, listName);
  if (!fieldRange) return [];

  const valueText = blockText.slice(fieldRange.valueStart, fieldRange.valueEnd);
  const collectionStart = fieldRange.valueStart;
  const entries = findCollectionEntries(valueText);

  if (edit.removeEntry !== undefined) {
    const target = normalizeEntry(edit.removeEntry);
    return entries
      .filter((entry) => normalizeEntry(entry.text) === target)
      .map((entry) =>
        expandToWholeLine(
          blockText,
          collectionStart + entry.start,
          collectionStart + entry.separatorEnd,
        ),
      );
  }

  if (edit.setEntry !== undefined) {
    const index =
      edit.setEntry.index < 0 ? entries.length + edit.setEntry.index : edit.setEntry.index;
    const entry = entries[index];
    const nextText = formatNdfValue(edit.setEntry.value);
    return !entry || normalizeEntry(entry.text) === nextText
      ? []
      : [
          {
            start: collectionStart + entry.start,
            end: collectionStart + entry.end,
            text: nextText,
          },
        ];
  }

  const insertion = edit.insert;
  if (!insertion) return [];
  const entryText = formatNdfValue(insertion.value);
  if (entries.some((entry) => normalizeEntry(entry.text) === entryText)) return [];
  if (entries.length === 0) {
    return insertIntoEmptyCollection(blockText, collectionStart, valueText, entryText);
  }

  const anchor = insertion.position === 'start' ? entries[0] : entries.at(-1);
  if (!anchor) return [];
  const indent = readEntryIndent(valueText, anchor.start);
  return insertion.position === 'start'
    ? [
        {
          start: collectionStart + anchor.start,
          end: collectionStart + anchor.start,
          text: `${entryText},\n${indent}`,
        },
      ]
    : [
        {
          start: collectionStart + anchor.separatorEnd,
          end: collectionStart + anchor.separatorEnd,
          text: `\n${indent}${entryText},`,
        },
      ];
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
    const rendered = renderLeadingOperationComment(comment, indent);
    return rendered
      ? { start: openerLineStart, end: openerLineStart, text: rendered, annotation: true }
      : undefined;
  }

  let spacingStart = opener;
  while (spacingStart > 0 && /[ \t]/.test(blockText[spacingStart - 1] ?? '')) {
    spacingStart -= 1;
  }
  const rendered = renderLeadingOperationComment(comment, '');
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

function hasTrailingComment(text: string, lineEnd: number): boolean {
  const lineStart = text.lastIndexOf('\n', lineEnd - 1) + 1;
  return text.slice(lineStart, lineEnd).includes('//');
}

function ensureNonOverlappingSplices(splices: Splice[], context: BulkErrorContext): void {
  const ordered = [...splices].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let coveredUntil = 0;
  for (const splice of ordered) {
    ensure(splice.start >= coveredUntil, 'ConflictError', {
      ...errorOwner(context),
      reason: 'Bulk edits overlap inside the same matched block.',
      suggestion:
        'Remove duplicate targets or split dependent edits into separate bulk operations.',
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
