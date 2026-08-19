import type { CooperativeYieldController } from '../../async.ts';
import { ensure, YmbError } from '../../errors.ts';
import type {
  AddOperation,
  CollectionPosition,
  CopyOperation,
  FieldPathSelector,
  ModifyOperation,
  NdfOperation,
  PatchApplication,
  PatchTarget,
  RemoveOperation,
} from '../../types.ts';
import { createNdfTextBuffer, type NdfTextBuffer } from './buffer.ts';
import { applyBulkOperation } from './bulk.ts';
import { advanceStringState, CHAR_LINE_FEED, type StringDelimiter } from './chars.ts';
import { splitTrailingComment, stripLineComments, withTrailingComment } from './comments.ts';
import {
  createPatchNotice,
  describeNdfValue,
  type PatchNoticeSink,
  reportTargetAlreadyGone,
  reportTargetAlreadyPresent,
  reportValueAlreadySet,
} from './notices.ts';
import {
  type CollectionEntryRange,
  extractFirstCollectionRange,
  extractFirstParenthesizedRange,
  findCollectionEntries,
  findCollectionEntryRange,
  findDirectFieldRange,
  findTemplateBlocks,
  findTopLevelBlocks,
  isCollectionSelectorSegment,
  splitNdfPath,
} from './scan.ts';
import { findSingleBlock, resolveTopLevelBlockReference } from './select.ts';
import {
  createMarkerContext,
  ensureFound,
  ensureMarkerBlockEndsBeforeFollowingToken,
  formatNdfValue,
  isMissingNdfTarget,
  isRawNdfValue,
  normalizeSnippetIndentation,
  type PatchErrorIdentity,
  type PatchMarkerContext,
  preserveOuterWhitespace,
  readLineIndent,
  removeRange,
  replaceRange,
  selectorError,
  type TopLevelBlock,
  toPatchErrorIdentity,
  trimOuterWhitespace,
  wrapModifiedSnippetWithMarkers,
  wrapRemovedSnippetWithMarkers,
  wrapSnippetWithMarkers,
} from './shared.ts';
import { validateNdf, validateNdfCooperative } from './validate.ts';

export interface ApplyPatchTargetOptions {
  validateBeforeApply?: boolean;
  validateAfterApply?: boolean;
  /** Called once per non-fatal observation, in the order the operations made them. */
  onNotice?: PatchNoticeSink | undefined;
}

/**
 * The deep walks know their operation index but not their target, and one patch may
 * target a file twice, so the lookup travels with what they all already carry.
 */
function scopeToTarget(application: PatchApplication, target: PatchTarget): PatchApplication {
  return target.operationLines
    ? { ...application, operationLines: target.operationLines }
    : application;
}

export async function applyPatchTargetCooperative(
  currentText: string,
  target: PatchTarget,
  rawApplication: PatchApplication,
  absolutePath: string,
  yieldController: CooperativeYieldController,
  options: ApplyPatchTargetOptions = {},
): Promise<string> {
  await yieldController.maybeYield();
  if (options.validateBeforeApply ?? true) {
    await validateNdfCooperative(currentText, absolutePath, yieldController);
  }

  const application = scopeToTarget(rawApplication, target);
  const watched = watchForSilence(options.onNotice);
  const buffer = createNdfTextBuffer(currentText);
  for (const [operationIndex, operation] of target.operations.entries()) {
    await yieldController.maybeYield();
    applyOperation(buffer, operation, application, absolutePath, operationIndex, watched.onNotice);
  }

  const nextText = buffer.text();
  reportTargetChangedNothing(
    watched,
    nextText === currentText,
    target,
    application,
    absolutePath,
    options,
  );

  await yieldController.maybeYield();
  if (options.validateAfterApply ?? true) {
    await validateNdfCooperative(nextText, absolutePath, yieldController);
  }
  return nextText;
}

/** A target built only from `expect.minBlocks: 0` has already answered for its silence. */
function everyOperationMayDoNothing(target: PatchTarget): boolean {
  // An empty list is not an opt-out, it is a `forEach` that expanded to nothing.
  return (
    target.operations.length > 0 &&
    target.operations.every(
      (operation) => operation.op === 'bulk' && operation.expect.minBlocks === 0,
    )
  );
}

interface SilenceWatch {
  onNotice: PatchNoticeSink | undefined;
  reported: () => boolean;
}

/**
 * Each operation explains its own silence, and those lines are the useful ones
 * because they name the operation. The backstop only speaks when none of them did.
 */
function watchForSilence(onNotice: PatchNoticeSink | undefined): SilenceWatch {
  if (!onNotice) return { onNotice: undefined, reported: () => true };
  let reported = false;
  return {
    onNotice: (notice) => {
      reported = true;
      onNotice(notice);
    },
    reported: () => reported,
  };
}

/**
 * Every operation reported success and the file is byte-for-byte unchanged -- the
 * state a patch decays into once the game data moves on under it.
 */
function reportTargetChangedNothing(
  watched: SilenceWatch,
  unchanged: boolean,
  target: PatchTarget,
  application: PatchApplication,
  absolutePath: string,
  options: ApplyPatchTargetOptions,
): void {
  if (!unchanged || watched.reported() || everyOperationMayDoNothing(target)) return;
  options.onNotice?.(
    createPatchNotice(
      application,
      absolutePath,
      0,
      'Every operation on this target applied and left the file exactly as it was, so this patch changes nothing here.',
      'Check the operations against the current game data, or delete the target if the game already ships what it asks for.',
    ),
  );
}

function applyOperation(
  buffer: NdfTextBuffer,
  operation: NdfOperation,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  onNotice: PatchNoticeSink | undefined,
): void {
  switch (operation.op) {
    case 'bulk':
      applyBulkOperation(buffer, operation, application, absolutePath, operationIndex, onNotice);
      return;
    case 'modify':
      applyModify(buffer, operation, application, absolutePath, operationIndex, onNotice);
      return;
    case 'copy':
      applyCopy(buffer, operation, application, absolutePath, operationIndex, onNotice);
      return;
    case 'remove':
      applyRemove(buffer, operation, application, absolutePath, operationIndex, onNotice);
      return;
    case 'add':
      applyAdd(buffer, operation, application, absolutePath, operationIndex, onNotice);
      return;
  }
}

function applyModify(
  buffer: NdfTextBuffer,
  operation: ModifyOperation,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  onNotice: PatchNoticeSink | undefined,
): void {
  if (operation.selector.kind === 'field' && operation.selector.by === 'path') {
    updateFieldPath(
      buffer,
      readFieldPathSegments(operation.selector, application, absolutePath, operationIndex),
      operation.value,
      application,
      absolutePath,
      operationIndex,
      'modify',
      createMarkerContext('modify', operation.selector, application, absolutePath, operationIndex),
      onNotice,
    );
    return;
  }

  if (operation.selector.kind === 'object') {
    const block = findSingleBlock(
      buffer,
      operation.selector,
      application,
      absolutePath,
      operationIndex,
    );
    ensure(operation.changes, 'SchemaError', {
      ...toPatchErrorIdentity(application, absolutePath, operationIndex),
      reason: 'Object modify operations require `changes`.',
      suggestion: 'Provide a `changes` map of field names to replacement values.',
    });

    let updatedBlockText = block.text;
    for (const [fieldName, fieldValue] of Object.entries(operation.changes)) {
      updatedBlockText = updateDirectField(updatedBlockText, fieldName, fieldValue, {
        application,
        absolutePath,
        operationIndex,
        allowInsert: true,
        onNotice,
        targetLabel: block.name ? `${block.name}.${fieldName}` : fieldName,
      });
    }

    if (updatedBlockText === block.text) {
      return;
    }
    buffer.replaceTopLevelRange(
      block.start,
      block.end,
      wrapModifiedSnippetWithMarkers(
        updatedBlockText,
        block.text,
        buffer.readLineIndent(block.start),
        createMarkerContext(
          'modify',
          operation.selector,
          application,
          absolutePath,
          operationIndex,
        ),
        operation.leadingComment,
      ),
    );
    return;
  }

  throw selectorError(
    operation.selector,
    application,
    absolutePath,
    operationIndex,
    'Unsupported modify selector.',
  );
}

function applyCopy(
  buffer: NdfTextBuffer,
  operation: CopyOperation,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  onNotice: PatchNoticeSink | undefined,
): void {
  ensure(operation.selector.kind === 'object', 'SelectorError', {
    ...toPatchErrorIdentity(application, absolutePath, operationIndex),
    reason: '`copy` operations currently support `object` selectors only.',
    suggestion: 'Use `selector.kind: object` and a supported object selector mode for `copy`.',
  });
  ensure(operation.destination, 'SchemaError', {
    ...toPatchErrorIdentity(application, absolutePath, operationIndex),
    reason: '`copy` operations require `destination`.',
    suggestion: 'Provide `destination.name` in the operation config.',
  });

  const sourceBlock = findSingleBlock(
    buffer,
    operation.selector,
    application,
    absolutePath,
    operationIndex,
  );
  ensure(sourceBlock.name, 'SelectorError', {
    ...toPatchErrorIdentity(application, absolutePath, operationIndex),
    reason: '`copy` cannot rename an unnamed top-level block.',
    suggestion:
      'Select a named object, or add the new unnamed block explicitly with an `add` operation.',
  });
  const destinationName = operation.destination.name;
  const copiedText = sourceBlock.text.replace(
    new RegExp(`\\b${RegExp.escape(sourceBlock.name)}\\b`, 'g'),
    () => destinationName,
  );
  // Indexed lookup: scanning every block of a 27 MB NDF just to test one name
  // is the kind of cost that repeats once per copy operation.
  const existingDestination = buffer.findNamedBlock(destinationName);
  if (existingDestination && isSameNdfSnippet(existingDestination.text, copiedText)) {
    reportTargetAlreadyPresent(
      onNotice,
      application,
      absolutePath,
      operationIndex,
      `Copy destination \`${destinationName}\``,
    );
    return;
  }
  ensure(!existingDestination, 'ConflictError', {
    ...toPatchErrorIdentity(application, absolutePath, operationIndex),
    reason: `Copy destination \`${destinationName}\` already exists, and holds something other than this copy.`,
    suggestion: 'Choose a unique destination object name.',
  });

  const insertion = `${buffer.endsWithNewline() ? '' : '\n'}${wrapSnippetWithMarkers(
    copiedText,
    '',
    createMarkerContext('copy', operation.selector, application, absolutePath, operationIndex),
    operation.leadingComment,
  )}\n`;
  buffer.replaceTopLevelRange(buffer.length, buffer.length, insertion);
  return;
}

/**
 * A `remove` whose target is absent is the job already done: worth reporting, since
 * a WARNO update can retire a block, but not a failure. Every other selector
 * failure still is.
 */
function applyRemove(
  buffer: NdfTextBuffer,
  operation: RemoveOperation,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  onNotice: PatchNoticeSink | undefined,
): void {
  try {
    removeSelectedTarget(buffer, operation, application, absolutePath, operationIndex, onNotice);
    return;
  } catch (error) {
    if (!isMissingNdfTarget(error)) throw error;
    reportTargetAlreadyGone(
      onNotice,
      application,
      absolutePath,
      operationIndex,
      error.context.reason,
    );
    return;
  }
}

function removeSelectedTarget(
  buffer: NdfTextBuffer,
  operation: RemoveOperation,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  onNotice: PatchNoticeSink | undefined,
): void {
  if (operation.selector.kind === 'object') {
    const block = findSingleBlock(
      buffer,
      operation.selector,
      application,
      absolutePath,
      operationIndex,
    );
    buffer.replaceTopLevelRange(
      block.start,
      block.end,
      wrapRemovedSnippetWithMarkers(
        block.text,
        buffer.readLineIndent(block.start),
        createMarkerContext(
          'remove',
          operation.selector,
          application,
          absolutePath,
          operationIndex,
        ),
        operation.leadingComment,
      ),
    );
    return;
  }

  if (operation.selector.kind === 'field' && operation.selector.by === 'path') {
    updateFieldPath(
      buffer,
      readFieldPathSegments(operation.selector, application, absolutePath, operationIndex),
      undefined,
      application,
      absolutePath,
      operationIndex,
      'remove',
      createMarkerContext('remove', operation.selector, application, absolutePath, operationIndex),
      onNotice,
    );
    return;
  }

  throw selectorError(
    operation.selector,
    application,
    absolutePath,
    operationIndex,
    'Unsupported remove selector.',
  );
}

function applyAdd(
  buffer: NdfTextBuffer,
  operation: AddOperation,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  onNotice: PatchNoticeSink | undefined,
): void {
  if (!operation.selector) {
    insertTopLevelRaw(buffer, operation, application, absolutePath, operationIndex, onNotice);
    return;
  }

  if (operation.selector.kind === 'collection' && operation.selector.by === 'path') {
    ensure(typeof operation.selector.value === 'string', 'SchemaError', {
      ...toPatchErrorIdentity(application, absolutePath, operationIndex),
      reason: 'Collection path selectors require a string `value`.',
      suggestion: 'Set `selector.value` to a collection path like `@0.DivisionIds`.',
    });

    updateCollectionPath(
      buffer,
      splitNdfPath(operation.selector.value),
      operation.value,
      operation.position,
      operation.leadingComment,
      application,
      absolutePath,
      operationIndex,
      createMarkerContext('add', operation.selector, application, absolutePath, operationIndex),
      onNotice,
    );
    return;
  }

  if (operation.selector.kind === 'field' && operation.selector.by === 'path') {
    updateFieldPath(
      buffer,
      readFieldPathSegments(operation.selector, application, absolutePath, operationIndex),
      operation.value,
      application,
      absolutePath,
      operationIndex,
      'add',
      createMarkerContext('add', operation.selector, application, absolutePath, operationIndex),
      onNotice,
    );
    return;
  }

  throw selectorError(
    operation.selector,
    application,
    absolutePath,
    operationIndex,
    'Unsupported add selector.',
  );
}

/**
 * No selector: the block does not exist yet, so anything selectable would be an
 * anchor, and `position` says that more clearly.
 */
function insertTopLevelRaw(
  buffer: NdfTextBuffer,
  operation: AddOperation,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  onNotice: PatchNoticeSink | undefined,
): void {
  const rawValue = renderRawAddValue(
    operation.value,
    application,
    absolutePath,
    operationIndex,
    'Top-level',
  ).trimEnd();
  const alreadyPresent = describeAlreadyAddedBlocks(rawValue, buffer);
  if (alreadyPresent) {
    reportTargetAlreadyPresent(onNotice, application, absolutePath, operationIndex, alreadyPresent);
    return;
  }
  assertAddedNamesAreFree(rawValue, buffer, application, absolutePath, operationIndex);
  const renderedValue = wrapSnippetWithMarkers(
    rawValue,
    '',
    createMarkerContext('add', undefined, application, absolutePath, operationIndex),
    operation.leadingComment,
  );
  const insertAt = resolveTopLevelInsertionPoint(
    buffer,
    operation.position,
    application,
    absolutePath,
    operationIndex,
  );

  const prefix = insertAt === 0 || buffer.charCodeAt(insertAt - 1) === CHAR_LINE_FEED ? '' : '\n';
  const suffix = renderedValue.endsWith('\n') ? '' : '\n';
  buffer.replaceTopLevelRange(insertAt, insertAt, `${prefix}${renderedValue}${suffix}`);
  return;
}

/**
 * Only when every block in the snippet is already there with identical content. A
 * same-named block holding something else is what `assertAddedNamesAreFree` catches,
 * and a part-present snippet still fails, because inserting it whole duplicates the
 * rest.
 */
function describeAlreadyAddedBlocks(rawValue: string, buffer: NdfTextBuffer): string | undefined {
  const addedBlocks = findAddedNamedBlocks(rawValue);
  if (addedBlocks.length === 0) return undefined;

  const present = addedBlocks.filter((block) => {
    const existing = block.name ? buffer.findNamedBlock(block.name) : undefined;
    return existing !== undefined && isSameNdfSnippet(existing.text, block.text);
  });
  if (present.length !== addedBlocks.length) return undefined;

  const names = present.map((block) => `\`${block.name}\``);
  return names.length === 1 ? `Block ${names[0]}` : `Blocks ${names.join(', ')}`;
}

/** Templates included: a name the file holds is a conflict whichever form declares it. */
function findAddedNamedBlocks(rawValue: string): Array<TopLevelBlock & { name: string }> {
  return [...findTopLevelBlocks(rawValue), ...findTemplateBlocks(rawValue)].filter(
    (block): block is TopLevelBlock & { name: string } => block.name !== undefined,
  );
}

/** NDF parses with two blocks of one name and the game silently picks one. */
function assertAddedNamesAreFree(
  rawValue: string,
  buffer: NdfTextBuffer,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
): void {
  for (const addedBlock of findAddedNamedBlocks(rawValue)) {
    ensure(!buffer.findNamedBlock(addedBlock.name), 'ConflictError', {
      ...toPatchErrorIdentity(application, absolutePath, operationIndex),
      reason: `Top-level block \`${addedBlock.name}\` already exists in this file.`,
      suggestion: `Use \`op: modify\` to change the existing block, \`op: copy\` to duplicate it under a new name, or rename the block being added.`,
    });
  }
}

function resolveTopLevelInsertionPoint(
  buffer: NdfTextBuffer,
  position: AddOperation['position'],
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
): number {
  if (!position || position.mode === 'end') {
    return buffer.length;
  }
  if (position.mode === 'start') {
    return 0;
  }

  const anchorName = position.anchor;
  ensure(anchorName, 'SchemaError', {
    ...toPatchErrorIdentity(application, absolutePath, operationIndex),
    reason: `\`position.mode: ${position.mode}\` needs an \`anchor\`.`,
    suggestion: 'Name the existing top-level block the new one should sit beside.',
  });
  const anchorBlock = buffer.findNamedBlock(anchorName);
  ensure(anchorBlock, 'SelectorError', {
    ...toPatchErrorIdentity(application, absolutePath, operationIndex),
    reason: `Anchor block \`${anchorName}\` was not found.`,
    suggestion: `\`position.anchor\` names an existing block to sit beside, not the block being added. Use an existing top-level block name, or drop \`position\` to append at the end.`,
  });
  return position.mode === 'before' ? anchorBlock.start : anchorBlock.end;
}

function renderRawAddValue(
  value: unknown,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  targetKind: 'Top-level' | 'Collection',
): string {
  if (isRawNdfValue(value)) {
    return stripLineComments(String(value.$raw));
  }

  ensure(typeof value === 'string', 'SchemaError', {
    ...toPatchErrorIdentity(application, absolutePath, operationIndex),
    reason: `${targetKind} add operations require \`value: { $raw: "..." }\`.`,
    suggestion: `Provide the exact ${targetKind.toLowerCase()} NDF snippet in \`value.$raw\`.`,
  });
  return value;
}

/** The one reading of a `field:path` selector, for `add`, `modify`, and `remove` alike. */
function readFieldPathSegments(
  selector: FieldPathSelector,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
): string[] {
  ensure(typeof selector.value === 'string', 'SchemaError', {
    ...toPatchErrorIdentity(application, absolutePath, operationIndex),
    reason: 'Field path selectors require a string `value`.',
    suggestion: 'Set `selector.value` to a dotted NDF path like `Descriptor_Unit_X.SomeField`.',
  });

  const segments = splitNdfPath(selector.value);
  ensure(segments.length >= 2, 'SelectorError', {
    ...toPatchErrorIdentity(application, absolutePath, operationIndex),
    reason: 'Field path selectors must include an export name and at least one field segment.',
    suggestion: 'Use a dotted selector value like `Descriptor_Unit_X.SomeField`.',
  });
  return segments;
}

function updateFieldPath(
  buffer: NdfTextBuffer,
  segments: string[],
  nextValue: unknown,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  mode: 'add' | 'modify' | 'remove',
  markerContext?: PatchMarkerContext,
  onNotice?: PatchNoticeSink | undefined,
): void {
  const [exportName, ...fieldSegments] = segments;
  ensure(exportName, 'SelectorError', {
    ...toPatchErrorIdentity(application, absolutePath, operationIndex),
    reason: 'Field path selectors must start with an export name.',
    suggestion: 'Use a selector like `Descriptor_Unit_X.SomeField`.',
  });
  const exportBlock = resolveTopLevelBlockReference(
    buffer,
    exportName,
    toPatchErrorIdentity(application, absolutePath, operationIndex),
  );

  ensure(exportBlock, 'SelectorError', {
    ...toPatchErrorIdentity(application, absolutePath, operationIndex),
    reason: `Export \`${exportName}\` was not found.`,
    suggestion: 'Check the selector path and the target NDF file.',
  });

  const updatedBlockText = updateAlongNdfPath(
    exportBlock.text,
    fieldSegments,
    createFieldUpdateLeaf(
      nextValue,
      application,
      absolutePath,
      operationIndex,
      mode,
      markerContext,
      onNotice,
      segments.join('.'),
    ),
  );
  buffer.replaceTopLevelRange(exportBlock.start, exportBlock.end, updatedBlockText);
  return;
}

function updateCollectionPath(
  buffer: NdfTextBuffer,
  segments: string[],
  nextValue: unknown,
  position: CollectionPosition | undefined,
  leadingComment: string | undefined,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  markerContext: PatchMarkerContext,
  onNotice: PatchNoticeSink | undefined,
): void {
  const [rootReference, ...fieldSegments] = segments;
  ensure(rootReference, 'SelectorError', {
    ...toPatchErrorIdentity(application, absolutePath, operationIndex),
    reason: 'Collection path selectors must start with a top-level block reference.',
    suggestion: 'Use a named block like `DivisionTypeDescriptions.DivisionTypes` or `@0.Field`.',
  });
  const topLevelBlock = resolveTopLevelBlockReference(
    buffer,
    rootReference,
    toPatchErrorIdentity(application, absolutePath, operationIndex),
  );
  const renderedEntry = renderRawAddValue(
    nextValue,
    application,
    absolutePath,
    operationIndex,
    'Collection',
  );
  const updatedBlockText =
    fieldSegments.length === 0
      ? updateCollectionValue(
          topLevelBlock.text,
          renderedEntry,
          position,
          toPatchInsertContext(
            application,
            absolutePath,
            operationIndex,
            markerContext,
            leadingComment,
            onNotice,
            renderedEntry,
          ),
        )
      : updateAlongNdfPath(
          topLevelBlock.text,
          fieldSegments,
          createCollectionInsertLeaf(
            nextValue,
            position,
            leadingComment,
            application,
            absolutePath,
            operationIndex,
            markerContext,
            onNotice,
          ),
        );
  buffer.replaceTopLevelRange(topLevelBlock.start, topLevelBlock.end, updatedBlockText);
  return;
}

/** Walking down to the leaf is shared by every operation; only these two differ. */
interface NdfPathLeaf {
  identity: PatchErrorIdentity;
  /** The path ends on a plain field name. */
  onField: (containerText: string, fieldName: string) => string;
  /** The path ends on a collection-entry selector; returns the whole updated container. */
  onCollectionEntry: (containerText: string, entry: CollectionEntryRange) => string;
}

function updateAlongNdfPath(
  containerText: string,
  pathSegments: string[],
  leaf: NdfPathLeaf,
): string {
  const [currentSegment, ...remaining] = pathSegments;
  ensure(currentSegment, 'SelectorError', {
    ...leaf.identity,
    reason: 'Selector path contains an empty segment.',
    suggestion: 'Fix the selector path so every segment names a field or a collection entry.',
  });

  if (isCollectionSelectorSegment(currentSegment)) {
    const entryRange = findCollectionEntryRange(containerText, currentSegment, leaf.identity);
    if (remaining.length === 0) {
      return leaf.onCollectionEntry(containerText, entryRange);
    }
    return replaceRange(
      containerText,
      entryRange.start,
      entryRange.end,
      updateAlongNdfPath(entryRange.text, remaining, leaf),
    );
  }

  if (remaining.length === 0) {
    return leaf.onField(containerText, currentSegment);
  }

  const fieldRange = requireDirectFieldRange(
    containerText,
    currentSegment,
    leaf.identity,
    'Check the selector path or add the missing intermediate object first.',
  );
  return replaceNestedFieldValue(
    containerText,
    fieldRange,
    containerText.slice(fieldRange.valueStart, fieldRange.valueEnd),
    currentSegment,
    remaining,
    leaf.identity,
    (nestedText, nestedSegments) => updateAlongNdfPath(nestedText, nestedSegments, leaf),
  );
}

function createFieldUpdateLeaf(
  nextValue: unknown,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  mode: 'add' | 'modify' | 'remove',
  markerContext?: PatchMarkerContext,
  onNotice?: PatchNoticeSink | undefined,
  targetLabel?: string | undefined,
): NdfPathLeaf {
  const identity = toPatchErrorIdentity(application, absolutePath, operationIndex);
  return {
    identity,
    onField: (containerText, fieldName) =>
      updateDirectField(containerText, fieldName, nextValue, {
        application,
        absolutePath,
        operationIndex,
        allowInsert: mode !== 'remove',
        removeField: mode === 'remove',
        markerContext,
        onNotice,
        targetLabel,
      }),
    onCollectionEntry: (containerText, entry) => {
      // Nothing else can be done to a whole entry: `add` and `modify` need a field
      // inside it to write to.
      ensure(mode === 'remove', 'SelectorError', {
        ...identity,
        reason: 'Collection entry selectors require a nested field unless used by `remove`.',
        suggestion:
          'Append a field path after the collection selector or switch to a remove operation.',
      });
      return removeCollectionEntry(containerText, entry, markerContext);
    },
  };
}

function createCollectionInsertLeaf(
  nextValue: unknown,
  position: CollectionPosition | undefined,
  leadingComment: string | undefined,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  markerContext: PatchMarkerContext,
  onNotice: PatchNoticeSink | undefined,
): NdfPathLeaf {
  const identity = toPatchErrorIdentity(application, absolutePath, operationIndex);
  const renderedEntry = renderRawAddValue(
    nextValue,
    application,
    absolutePath,
    operationIndex,
    'Collection',
  );
  const insertContext = toPatchInsertContext(
    application,
    absolutePath,
    operationIndex,
    markerContext,
    leadingComment,
    onNotice,
    renderedEntry,
  );
  return {
    identity,
    onField: (containerText, fieldName) => {
      const fieldRange = requireDirectFieldRange(
        containerText,
        fieldName,
        identity,
        'Check the selector path and target NDF file.',
      );
      const currentValue = containerText.slice(fieldRange.valueStart, fieldRange.valueEnd);
      return replaceRange(
        containerText,
        fieldRange.valueStart,
        fieldRange.valueEnd,
        updateCollectionValue(currentValue, renderedEntry, position, insertContext),
      );
    },
    onCollectionEntry: () => {
      throw new YmbError('SelectorError', {
        ...identity,
        reason:
          'Collection updates must target a nested field inside the selected collection entry.',
        suggestion: 'Append the collection field path after the collection selector.',
      });
    },
  };
}

function requireDirectFieldRange(
  blockText: string,
  fieldName: string,
  identity: PatchErrorIdentity,
  suggestion: string,
) {
  const fieldRange = findDirectFieldRange(blockText, fieldName);
  ensureFound(fieldRange, {
    ...identity,
    reason: `Field \`${fieldName}\` was not found.`,
    suggestion,
  });
  return fieldRange;
}

function replaceNestedFieldValue(
  blockText: string,
  fieldRange: { valueStart: number; valueEnd: number },
  currentValue: string,
  currentField: string,
  remaining: string[],
  identity: PatchErrorIdentity,
  updateNested: (nestedText: string, nestedSegments: string[]) => string,
): string {
  const currentValueCore = trimOuterWhitespace(currentValue);
  let updatedValue: string;

  if (isCollectionSelectorSegment(remaining[0] ?? '')) {
    updatedValue = updateNested(currentValueCore, remaining);
  } else {
    const nestedRange = extractFirstParenthesizedRange(currentValueCore);
    ensure(nestedRange, 'SelectorError', {
      ...identity,
      reason: `Field \`${currentField}\` is not an object-like NDF value.`,
      suggestion: 'Only object-like field paths can be traversed recursively.',
    });

    const nestedValue = currentValueCore.slice(nestedRange.start, nestedRange.end);
    const updatedNestedValue = updateNested(nestedValue, remaining);
    updatedValue =
      currentValueCore.slice(0, nestedRange.start) +
      updatedNestedValue +
      currentValueCore.slice(nestedRange.end);
  }

  return replaceRange(
    blockText,
    fieldRange.valueStart,
    fieldRange.valueEnd,
    preserveOuterWhitespace(currentValue, updatedValue),
  );
}

interface CollectionInsertContext {
  identity: PatchErrorIdentity;
  wrapEntry: (normalizedSnippet: string, indent: string) => string;
  /** Called when the entry is already in the collection, so nothing is inserted. */
  reportAlreadyPresent?: (() => void) | undefined;
}

function endsWithCollectionSeparator(text: string): boolean {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = (lines[index] ?? '').trim();
    if (trimmed.length === 0 || trimmed.startsWith('//')) {
      continue;
    }
    const code = trimmed.replace(/\s*\/\/.*$/, '').trimEnd();
    if (code.length === 0) {
      continue;
    }
    return code.endsWith(',') || code.endsWith('[');
  }
  return true;
}

function updateCollectionValue(
  currentValue: string,
  rawRenderedEntry: string,
  position: CollectionPosition | undefined,
  context: CollectionInsertContext,
): string {
  const collectionValue = trimOuterWhitespace(currentValue);
  const collectionRange = extractFirstCollectionRange(collectionValue);
  ensure(collectionRange, 'SelectorError', {
    ...context.identity,
    reason: 'Selected value is not an NDF collection or map.',
    suggestion: 'Use collection selectors only on `[...]` or `MAP [...]` values.',
  });

  const normalizedRenderedEntry = normalizeCollectionEntrySnippet(rawRenderedEntry);
  if (collectionAlreadyContainsEntry(collectionValue, rawRenderedEntry)) {
    context.reportAlreadyPresent?.();
    return currentValue;
  }

  const insertionPoint = resolveCollectionInsertionPoint(
    collectionValue,
    collectionRange,
    position,
  );
  const entryIndent = detectCollectionEntryIndentation(
    collectionValue,
    collectionRange,
    insertionPoint,
  );
  const renderedEntry = context.wrapEntry(
    normalizeSnippetIndentation(normalizedRenderedEntry, entryIndent),
    entryIndent,
  );
  const rawBeforeInsertion = collectionValue.slice(0, insertionPoint);
  const afterInsertion = collectionValue.slice(insertionPoint);
  // A last entry carries no trailing comma, so appending after it needs the separator.
  // Whole-line comments and whitespace are skipped to reach the last real character.
  const needsSeparator =
    afterInsertion.replace(/^\s+/, '').startsWith(']') &&
    !endsWithCollectionSeparator(rawBeforeInsertion);
  // Indentation at the insertion point belongs to the line being pushed down. Without
  // a separator that line stays: the text can end inside a trailing `//` comment, which
  // would swallow a comma appended there.
  const beforeInsertion = needsSeparator
    ? rawBeforeInsertion
    : rawBeforeInsertion.replace(/[ \t]+$/, '');
  const prefix = `${needsSeparator ? ',' : ''}${beforeInsertion.endsWith('\n') ? '' : '\n'}`;
  const suffix = resolveCollectionInsertionSuffix(afterInsertion, entryIndent);
  return preserveOuterWhitespace(
    currentValue,
    `${beforeInsertion}${prefix}${renderedEntry}${suffix}${afterInsertion}`,
  );
}

function toPatchInsertContext(
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  markerContext: PatchMarkerContext,
  leadingComment: string | undefined,
  onNotice: PatchNoticeSink | undefined,
  entryLabel: string,
): CollectionInsertContext {
  return {
    identity: toPatchErrorIdentity(application, absolutePath, operationIndex),
    wrapEntry: (snippet, indent) =>
      wrapSnippetWithMarkers(snippet, indent, markerContext, leadingComment),
    reportAlreadyPresent: () =>
      reportTargetAlreadyPresent(
        onNotice,
        application,
        absolutePath,
        operationIndex,
        `Collection entry \`${describeNdfValue(entryLabel)}\``,
      ),
  };
}

interface CollectionInsertOptions {
  position?: CollectionPosition | undefined;
  pathHint?: string | undefined;
}

export function insertCollectionEntryByPath(
  text: string,
  collectionPath: string,
  entry: string | { $raw: string | number | bigint | boolean },
  options: CollectionInsertOptions = {},
): string {
  const identity: PatchErrorIdentity = { absolutePath: options.pathHint ?? 'inline.ndf' };
  const segments = splitNdfPath(collectionPath);
  const [blockReference, ...fieldSegments] = segments;
  ensure(blockReference !== undefined && fieldSegments.length > 0, 'SelectorError', {
    ...identity,
    reason: 'Collection path must reference a top-level block and at least one field.',
    suggestion: 'Use a path like `DivisionRules.DivisionIds`.',
  });

  const rawRenderedEntry = isRawNdfValue(entry)
    ? stripLineComments(String(entry.$raw))
    : renderScriptCollectionEntry(entry, identity);
  const context: CollectionInsertContext = {
    identity,
    wrapEntry: (snippet) => snippet,
  };

  const buffer = createNdfTextBuffer(text);
  const block = resolveTopLevelBlockReference(buffer, blockReference, identity);
  const updatedBlockText = insertCollectionEntryIntoContainer(
    block.text,
    fieldSegments,
    rawRenderedEntry,
    options.position,
    context,
  );
  buffer.replaceTopLevelRange(block.start, block.end, updatedBlockText);
  const updatedText = buffer.text();
  validateNdf(updatedText, identity.absolutePath ?? 'inline.ndf');
  return updatedText;
}

function renderScriptCollectionEntry(entry: unknown, identity: PatchErrorIdentity): string {
  ensure(typeof entry === 'string', 'SchemaError', {
    ...identity,
    reason: 'Collection entry must be a string or a `{ $raw: "..." }` value.',
    suggestion: 'Pass the exact NDF entry snippet as a string or via `{ $raw }`.',
  });
  return entry;
}

function insertCollectionEntryIntoContainer(
  containerText: string,
  fieldSegments: string[],
  rawRenderedEntry: string,
  position: CollectionPosition | undefined,
  context: CollectionInsertContext,
): string {
  const [field, ...rest] = fieldSegments;
  ensure(field !== undefined && !isCollectionSelectorSegment(field), 'SelectorError', {
    ...context.identity,
    reason: 'Script collection inserts only support plain field paths.',
    suggestion: 'Use a dotted path of field names such as `DivisionRules.DivisionIds`.',
  });

  const fieldRange = findDirectFieldRange(containerText, field);
  ensure(fieldRange, 'SelectorError', {
    ...context.identity,
    reason: `Field \`${field}\` was not found in the target block.`,
    suggestion: 'Check the collection path against the current NDF structure.',
  });

  const currentValue = containerText.slice(fieldRange.valueStart, fieldRange.valueEnd);
  const updatedValue =
    rest.length === 0
      ? updateCollectionValue(currentValue, rawRenderedEntry, position, context)
      : insertCollectionEntryIntoContainer(currentValue, rest, rawRenderedEntry, position, context);
  return replaceRange(containerText, fieldRange.valueStart, fieldRange.valueEnd, updatedValue);
}

function normalizeCollectionEntrySnippet(value: string): string {
  const trimmedEnd = value.trimEnd();
  if (trimmedEnd.length === 0 || trimmedEnd.endsWith(',')) {
    return trimmedEnd;
  }
  return `${trimmedEnd},`;
}

function collectionAlreadyContainsEntry(
  collectionValue: string,
  rawRenderedEntry: string,
): boolean {
  const existingEntries = new Set(
    findCollectionEntries(collectionValue).map((entry) => normalizeEntryForComparison(entry.text)),
  );
  const renderedEntries = findCollectionEntries(`[\n${rawRenderedEntry}\n]`)
    .map((entry) => normalizeEntryForComparison(entry.text))
    .filter((entry) => entry.length > 0);
  return renderedEntries.length > 0 && renderedEntries.every((entry) => existingEntries.has(entry));
}

/** Comments and layout are how a file was written, not what it holds, so neither counts. */
function isSameNdfSnippet(left: string, right: string): boolean {
  return normalizeEntryForComparison(left) === normalizeEntryForComparison(right);
}

function normalizeEntryForComparison(entryText: string): string {
  const withoutComments = stripLineComments(entryText);
  let normalized = '';
  let inString: StringDelimiter | undefined;
  let pendingSpace = false;
  for (let index = 0; index < withoutComments.length; index += 1) {
    const char = withoutComments[index] ?? '';
    inString = advanceStringState(inString, withoutComments, index);
    if (!inString && /\s/.test(char)) {
      pendingSpace = normalized.length > 0;
      continue;
    }
    if (pendingSpace) {
      normalized += ' ';
      pendingSpace = false;
    }
    normalized += char;
  }
  return normalized;
}

function resolveCollectionInsertionSuffix(afterInsertion: string, entryIndent: string): string {
  if (afterInsertion.length === 0 || afterInsertion.startsWith('\n')) {
    return '';
  }

  // The trailing entry starts a fresh line here, so it needs the collection's indent.
  if (/^[^\s]/.test(afterInsertion)) {
    return `\n${entryIndent}`;
  }

  return '\n';
}

/**
 * Markers are whole lines, so a `//` in front of a field that is not first on its
 * line comments out the code before it. What is left still parses; it no longer
 * says what it did. The object form marks the whole block and has no such problem.
 */
function assertFieldStartsItsOwnLine(
  blockText: string,
  fieldStart: number,
  fieldName: string,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
): void {
  const lineStart = blockText.lastIndexOf('\n', Math.max(0, fieldStart - 1)) + 1;
  const before = blockText.slice(lineStart, fieldStart);
  ensure(before.trim().length === 0, 'SchemaError', {
    ...toPatchErrorIdentity(application, absolutePath, operationIndex),
    reason: `Field \`${fieldName}\` shares its line with other code, so this operation cannot record what it changed.`,
    suggestion:
      'Use an object selector with `changes` to edit the whole block at once, which marks the block instead of the line.',
    details: [`Line: ${readLineAt(blockText, lineStart).trim()}`],
  });
}

function readLineAt(text: string, lineStart: number): string {
  const lineEnd = text.indexOf('\n', lineStart);
  return lineEnd === -1 ? text.slice(lineStart) : text.slice(lineStart, lineEnd);
}

/** Everything about a direct field write except the text and the value itself. */
interface DirectFieldUpdate {
  application: PatchApplication;
  absolutePath: string;
  operationIndex: number;
  /** `add` and `modify` may write a field that is not there yet; `remove` never does. */
  allowInsert: boolean;
  removeField?: boolean | undefined;
  markerContext?: PatchMarkerContext | undefined;
  onNotice?: PatchNoticeSink | undefined;
  /** How a notice names the field. Defaults to the field name on its own. */
  targetLabel?: string | undefined;
}

function updateDirectField(
  blockText: string,
  fieldName: string,
  nextValue: unknown,
  update: DirectFieldUpdate,
): string {
  const { application, absolutePath, operationIndex, allowInsert, markerContext } = update;
  const removeField = update.removeField ?? false;
  const fieldRange = findDirectFieldRange(blockText, fieldName);

  if (!fieldRange && removeField) {
    reportTargetAlreadyGone(
      update.onNotice,
      application,
      absolutePath,
      operationIndex,
      `Field \`${update.targetLabel ?? fieldName}\` was not found.`,
    );
    return blockText;
  }

  if (!fieldRange && allowInsert) {
    const lastParen = blockText.lastIndexOf(')');
    ensure(lastParen !== -1, 'ParserError', {
      ...toPatchErrorIdentity(application, absolutePath, operationIndex),
      reason: 'Object block is malformed and is missing its closing parenthesis.',
      suggestion: 'Fix the target NDF object syntax before applying the patch.',
    });

    const insertionField = `    ${fieldName} = ${formatNdfValue(nextValue)}\n`;
    const insertion = markerContext
      ? `${wrapSnippetWithMarkers(insertionField.trimEnd(), '    ', markerContext)}\n`
      : insertionField;
    return `${blockText.slice(0, lastParen)}${insertion}${blockText.slice(lastParen)}`;
  }

  ensureFound(fieldRange, {
    ...toPatchErrorIdentity(application, absolutePath, operationIndex),
    reason: `Field \`${fieldName}\` was not found.`,
    suggestion: 'Check the selector or use an add operation first.',
  });

  if (markerContext) {
    assertFieldStartsItsOwnLine(
      blockText,
      fieldRange.start,
      fieldName,
      application,
      absolutePath,
      operationIndex,
    );
  }

  if (removeField) {
    const fieldText = blockText.slice(fieldRange.start, fieldRange.end);
    const fieldIndent = fieldText.match(/^[ \t]*/)?.[0] ?? '';
    if (!markerContext) {
      return removeRange(blockText, fieldRange.start, fieldRange.end);
    }
    const wrappedRemoval = ensureMarkerBlockEndsBeforeFollowingToken(
      wrapRemovedSnippetWithMarkers(fieldText, fieldIndent, markerContext),
      blockText[fieldRange.end],
    );
    return replaceRange(blockText, fieldRange.start, fieldRange.end, wrappedRemoval);
  }

  const currentValue = blockText.slice(fieldRange.valueStart, fieldRange.valueEnd);
  // A `//` note after the value is the file's, not the value's. Comparing it as
  // part of the value hid every operation that wrote what was already there, and
  // rewriting the field then deleted the note on the way past.
  const { code: currentValueCore, trailingComment } = splitTrailingComment(
    trimOuterWhitespace(currentValue),
  );
  const originalFieldText = blockText.slice(fieldRange.start, fieldRange.end);
  const fieldIndent = originalFieldText.match(/^[ \t]*/)?.[0] ?? '';
  const renderedValue = formatNdfValue(nextValue);
  if (currentValueCore === renderedValue) {
    reportValueAlreadySet(
      update.onNotice,
      application,
      absolutePath,
      operationIndex,
      update.targetLabel ?? fieldName,
      renderedValue,
    );
    return blockText;
  }

  const updatedFieldText = replaceRange(
    originalFieldText,
    fieldRange.valueStart - fieldRange.start,
    fieldRange.valueEnd - fieldRange.start,
    preserveOuterWhitespace(currentValue, withTrailingComment(renderedValue, trailingComment)),
  );
  return replaceRange(
    blockText,
    fieldRange.start,
    fieldRange.end,
    markerContext
      ? ensureMarkerBlockEndsBeforeFollowingToken(
          wrapModifiedSnippetWithMarkers(
            updatedFieldText,
            originalFieldText,
            fieldIndent,
            markerContext,
          ),
          blockText[fieldRange.end],
        )
      : updatedFieldText,
  );
}

// Stops at the line break so the following entry keeps its own indentation.
function consumeTrailingLineBreak(collectionText: string, index: number): number {
  let cursor = index;
  while (cursor < collectionText.length && /[ \t]/.test(collectionText[cursor] ?? '')) {
    cursor += 1;
  }
  if (collectionText[cursor] === '\r') {
    cursor += 1;
  }
  if (collectionText[cursor] === '\n') {
    cursor += 1;
  }
  return cursor;
}

function removeCollectionEntry(
  collectionText: string,
  entry: CollectionEntryRange,
  markerContext?: PatchMarkerContext,
): string {
  let start = entry.start;
  let end = entry.end;

  let nextIndex = entry.separatorStart;
  while (nextIndex < collectionText.length && /\s/.test(collectionText[nextIndex] ?? '')) {
    nextIndex += 1;
  }
  if (collectionText[nextIndex] === ',') {
    end = consumeTrailingLineBreak(collectionText, nextIndex + 1);
    return replaceRemovedCollectionEntry(collectionText, start, end, entry, markerContext);
  }

  let previousIndex = entry.start - 1;
  while (previousIndex >= 0 && /\s/.test(collectionText[previousIndex] ?? '')) {
    previousIndex -= 1;
  }
  if (collectionText[previousIndex] === ',') {
    start = previousIndex;
    while (start > 0 && /\s/.test(collectionText[start - 1] ?? '')) {
      start -= 1;
    }
  }

  return replaceRemovedCollectionEntry(collectionText, start, end, entry, markerContext);
}

function resolveCollectionInsertionPoint(
  currentValue: string,
  collectionRange: { start: number; end: number },
  position: CollectionPosition | undefined,
): number {
  const innerStart = collectionRange.start + 1;
  const innerEnd = collectionRange.end - 1;

  if (!position || position.mode === 'end') {
    return innerEnd;
  }

  if (position.mode === 'start') {
    return innerStart;
  }

  if (!position.anchor) {
    return innerEnd;
  }

  const containingEntry = findCollectionEntries(currentValue).find((entry) =>
    stripLineComments(currentValue.slice(entry.start, entry.separatorEnd)).includes(
      position.anchor ?? '',
    ),
  );
  if (containingEntry) {
    // `end` stops before the anchor's comma, which would fuse the two entries;
    // `separatorEnd` clears it, collapsing to the collection's inner end for a last entry.
    return position.mode === 'before' ? containingEntry.start : containingEntry.separatorEnd;
  }
  return innerEnd;
}

function detectCollectionEntryIndentation(
  collectionValue: string,
  collectionRange: { start: number; end: number },
  insertionPoint: number,
): string {
  const entries = findCollectionEntries(collectionValue);
  const previousEntry = [...entries].reverse().find((entry) => entry.start < insertionPoint);
  if (previousEntry) {
    const previousIndent = readLineIndent(collectionValue, previousEntry.start);
    if (previousIndent.length > 0) {
      return previousIndent;
    }
  }

  const nextEntry = entries.find((entry) => entry.start >= insertionPoint);
  if (nextEntry) {
    const nextIndent = readLineIndent(collectionValue, nextEntry.start);
    if (nextIndent.length > 0) {
      return nextIndent;
    }
  }

  const closingIndent = readLineIndent(collectionValue, collectionRange.end - 1);
  return closingIndent.length > 0 ? `${closingIndent}    ` : '    ';
}

function replaceRemovedCollectionEntry(
  collectionText: string,
  start: number,
  end: number,
  entry: CollectionEntryRange,
  markerContext?: PatchMarkerContext,
): string {
  if (!markerContext) {
    return `${collectionText.slice(0, start)}${collectionText.slice(end)}`;
  }

  const indent = readLineIndent(collectionText, entry.start);
  const before = collectionText.slice(0, start).replace(/[ \t]+$/, '');
  const after = collectionText.slice(end);
  const prefix = before.endsWith('\n') || before.length === 0 ? '' : '\n';
  const suffix = after.startsWith('\n') ? '' : '\n';
  return `${before}${prefix}${wrapRemovedSnippetWithMarkers(entry.text, indent, markerContext)}${suffix}${after}`;
}
