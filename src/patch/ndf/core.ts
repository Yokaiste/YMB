import type { CooperativeYieldController } from '../../async.ts';
import { ensure } from '../../errors.ts';
import { escapeRegExp } from '../../text-utils.ts';
import type {
  CollectionPosition,
  ErrorContext,
  NdfOperation,
  PatchApplication,
  PatchTarget,
  Selector,
} from '../../types.ts';
import {
  type CollectionEntryRange,
  extractFirstCollectionRange,
  extractFirstParenthesizedRange,
  findCollectionEntries,
  findCollectionEntryRange,
  findDirectFieldRange,
  findNamedBlockByName,
  findTopLevelBlocks,
  isCollectionSelectorSegment,
} from './scan.ts';
import {
  advanceStringState,
  createMarkerContext,
  ensureMarkerBlockEndsBeforeFollowingToken,
  formatNdfValue,
  isRawNdfValue,
  normalizeSnippetIndentation,
  type PatchMarkerContext,
  preserveOuterWhitespace,
  readLineIndent,
  removeRange,
  replaceRange,
  type StringDelimiter,
  selectorError,
  startsLineComment,
  stripLineComments,
  type TopLevelBlock,
  trimOuterWhitespace,
  wrapAddedSnippetWithMarkers,
  wrapModifiedSnippetWithMarkers,
  wrapRemovedSnippetWithMarkers,
  wrapSnippetWithMarkers,
} from './shared.ts';

export function isNdfPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.ndf');
}

const VALIDATION_YIELD_INTERVAL = 4096;

type DelimiterChar = '(' | '[' | '{';

interface CollectionValidationState {
  pendingSeparator: boolean;
}

interface NdfValidationState {
  stack: DelimiterChar[];
  collectionStates: Map<number, CollectionValidationState>;
  line: number;
  column: number;
  inString: StringDelimiter | undefined;
  inLineComment: boolean;
}

export function validateNdf(text: string, absolutePath: string): void {
  const state = createNdfValidationState();
  for (let index = 0; index < text.length; index += 1) {
    advanceNdfValidation(state, text, index, absolutePath);
  }
  finalizeNdfValidation(state, absolutePath);
}

export async function validateNdfCooperative(
  text: string,
  absolutePath: string,
  yieldController: CooperativeYieldController,
): Promise<void> {
  const state = createNdfValidationState();
  for (let index = 0; index < text.length; index += 1) {
    if (index % VALIDATION_YIELD_INTERVAL === 0) {
      await yieldController.maybeYield();
    }
    advanceNdfValidation(state, text, index, absolutePath);
  }
  finalizeNdfValidation(state, absolutePath);
}

function createNdfValidationState(): NdfValidationState {
  return {
    stack: [],
    collectionStates: new Map(),
    line: 1,
    column: 0,
    inString: undefined,
    inLineComment: false,
  };
}

function advanceNdfValidation(
  state: NdfValidationState,
  text: string,
  index: number,
  absolutePath: string,
): void {
  const char = text[index] ?? '';
  const next = text[index + 1];
  state.column += 1;

  if (char === '\n') {
    state.line += 1;
    state.column = 0;
    state.inLineComment = false;
    return;
  }

  if (state.inLineComment) {
    return;
  }

  if (!state.inString && startsLineComment(char, next)) {
    state.inLineComment = true;
    return;
  }

  const nextStringState = advanceStringState(state.inString, text, index);
  if (nextStringState !== state.inString) {
    const previousStringState = state.inString;
    state.inString = nextStringState;
    if (previousStringState && !state.inString) {
      markCollectionEntryComplete(state);
    }
    return;
  }

  if (state.inString) {
    return;
  }

  const currentCollection = state.collectionStates.get(state.stack.length);
  if (currentCollection) {
    if (char === ',') {
      currentCollection.pendingSeparator = false;
      return;
    }
    if (!/\s/.test(char) && char !== ']') {
      if (currentCollection.pendingSeparator && isCollectionExpressionContinuationChar(char)) {
        currentCollection.pendingSeparator = false;
      }
      ensure(!currentCollection.pendingSeparator, 'ParserError', {
        absolutePath,
        reason: `Missing collection separator before \`${char}\` at line ${state.line}, column ${state.column}.`,
        suggestion:
          'Add a comma between top-level collection entries so generated NDF stays valid.',
      });
    }
  }

  if (char === '(' || char === '[' || char === '{') {
    state.stack.push(char);
    if (char === '[') {
      state.collectionStates.set(state.stack.length, { pendingSeparator: false });
    }
    return;
  }

  if (char === ')' || char === ']' || char === '}') {
    const previous = state.stack.pop();
    const matches =
      (previous === '(' && char === ')') ||
      (previous === '[' && char === ']') ||
      (previous === '{' && char === '}');

    ensure(matches, 'ParserError', {
      absolutePath,
      reason: `Unbalanced delimiter \`${char}\` at line ${state.line}, column ${state.column}.`,
      suggestion:
        'Fix the surrounding NDF syntax so parentheses, brackets, and braces are balanced.',
    });

    if (previous === '[') {
      state.collectionStates.delete(state.stack.length + 1);
    }
    markCollectionEntryComplete(state);
  }
}

function finalizeNdfValidation(state: NdfValidationState, absolutePath: string): void {
  ensure(state.stack.length === 0, 'ParserError', {
    absolutePath,
    reason: 'NDF text ends with unbalanced delimiters.',
    suggestion: 'Fix the surrounding NDF syntax so parentheses, brackets, and braces are balanced.',
  });
}

function markCollectionEntryComplete(state: NdfValidationState): void {
  const currentCollection = state.collectionStates.get(state.stack.length);
  if (currentCollection) {
    currentCollection.pendingSeparator = true;
  }
}

function isCollectionExpressionContinuationChar(char: string): boolean {
  return /[!%&*+\-./:<=>?^|~]/.test(char);
}

export function applyPatchTarget(
  currentText: string,
  target: PatchTarget,
  application: PatchApplication,
  absolutePath: string,
  options: {
    validateBeforeApply?: boolean;
    validateAfterApply?: boolean;
  } = {},
): string {
  if (options.validateBeforeApply ?? true) {
    validateNdf(currentText, absolutePath);
  }
  let nextText = currentText;

  for (const [operationIndex, operation] of target.operations.entries()) {
    nextText = applyOperation(nextText, operation, application, absolutePath, operationIndex);
  }

  if (options.validateAfterApply ?? true) {
    validateNdf(nextText, absolutePath);
  }
  return nextText;
}

export async function applyPatchTargetCooperative(
  currentText: string,
  target: PatchTarget,
  application: PatchApplication,
  absolutePath: string,
  yieldController: CooperativeYieldController,
  options: {
    validateBeforeApply?: boolean;
    validateAfterApply?: boolean;
  } = {},
): Promise<string> {
  await yieldController.maybeYield();
  if (options.validateBeforeApply ?? true) {
    await validateNdfCooperative(currentText, absolutePath, yieldController);
  }
  let nextText = currentText;

  for (const [operationIndex, operation] of target.operations.entries()) {
    await yieldController.maybeYield();
    nextText = applyOperation(nextText, operation, application, absolutePath, operationIndex);
  }

  await yieldController.maybeYield();
  if (options.validateAfterApply ?? true) {
    await validateNdfCooperative(nextText, absolutePath, yieldController);
  }
  return nextText;
}

function applyOperation(
  currentText: string,
  operation: NdfOperation,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
): string {
  switch (operation.op) {
    case 'modify':
      return applyModify(currentText, operation, application, absolutePath, operationIndex);
    case 'copy':
      return applyCopy(currentText, operation, application, absolutePath, operationIndex);
    case 'remove':
      return applyRemove(currentText, operation, application, absolutePath, operationIndex);
    case 'add':
      return applyAdd(currentText, operation, application, absolutePath, operationIndex);
    default:
      return currentText;
  }
}

function applyModify(
  currentText: string,
  operation: NdfOperation,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
): string {
  if (operation.selector.kind === 'field' && operation.selector.by === 'path') {
    ensure(typeof operation.selector.value === 'string', 'SchemaError', {
      absolutePath,
      modId: application.mod.config.id,
      modName: application.mod.config.name,
      patchId: application.patch.config.id,
      operationIndex,
      reason: 'Field path selectors require a string `value`.',
      suggestion: 'Set `selector.value` to a dotted NDF path like `Descriptor.Field`.',
    });

    const segments = operation.selector.value.split('.');
    ensure(segments.length >= 2, 'SelectorError', {
      absolutePath,
      modId: application.mod.config.id,
      modName: application.mod.config.name,
      patchId: application.patch.config.id,
      operationIndex,
      reason: 'Field path selectors must include an export name and at least one field segment.',
      suggestion: 'Use a dotted selector value like `Descriptor_Unit_X.SomeField`.',
    });

    return updateFieldPath(
      currentText,
      segments,
      operation.value,
      application,
      absolutePath,
      operationIndex,
      'modify',
      createMarkerContext('modify', operation.selector, application, absolutePath, operationIndex),
    );
  }

  if (operation.selector.kind === 'object') {
    const block = findSingleBlock(
      currentText,
      operation.selector,
      application,
      absolutePath,
      operationIndex,
    );
    ensure(operation.changes, 'SchemaError', {
      absolutePath,
      modId: application.mod.config.id,
      modName: application.mod.config.name,
      patchId: application.patch.config.id,
      operationIndex,
      reason: 'Object modify operations require `changes`.',
      suggestion: 'Provide a `changes` map of field names to replacement values.',
    });

    let updatedBlockText = block.text;
    for (const [fieldName, fieldValue] of Object.entries(operation.changes)) {
      updatedBlockText = updateDirectField(
        updatedBlockText,
        fieldName,
        fieldValue,
        application,
        absolutePath,
        operationIndex,
        true,
      );
    }

    if (updatedBlockText === block.text) {
      return currentText;
    }
    return replaceRange(
      currentText,
      block.start,
      block.end,
      wrapModifiedSnippetWithMarkers(
        updatedBlockText,
        block.text,
        readLineIndent(currentText, block.start),
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
  currentText: string,
  operation: NdfOperation,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
): string {
  ensure(operation.selector.kind === 'object', 'SelectorError', {
    absolutePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    operationIndex,
    reason: '`copy` operations currently support `object` selectors only.',
    suggestion: 'Use `selector.kind: object` and a supported object selector mode for `copy`.',
  });
  ensure(operation.destination, 'SchemaError', {
    absolutePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    operationIndex,
    reason: '`copy` operations require `destination`.',
    suggestion: 'Provide `destination.kind` and `destination.name` in the operation config.',
  });

  const sourceBlock = findSingleBlock(
    currentText,
    operation.selector,
    application,
    absolutePath,
    operationIndex,
  );
  ensure(sourceBlock.name, 'SelectorError', {
    absolutePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    operationIndex,
    reason: '`copy` cannot rename an unnamed top-level block.',
    suggestion:
      'Select a named object, or add the new unnamed block explicitly with an `add` operation.',
  });
  ensure(
    !findTopLevelBlocks(currentText).some((block) => block.name === operation.destination?.name),
    'ConflictError',
    {
      absolutePath,
      modId: application.mod.config.id,
      modName: application.mod.config.name,
      patchId: application.patch.config.id,
      operationIndex,
      reason: `Copy destination \`${operation.destination.name}\` already exists.`,
      suggestion: 'Choose a unique destination object name.',
    },
  );

  const copiedText = sourceBlock.text.replace(
    new RegExp(`\\b${escapeRegExp(sourceBlock.name)}\\b`, 'g'),
    operation.destination.name,
  );
  const insertion = `${currentText.endsWith('\n') ? '' : '\n'}${wrapSnippetWithMarkers(
    copiedText,
    '',
    createMarkerContext('copy', operation.selector, application, absolutePath, operationIndex),
    operation.leadingComment,
  )}\n`;
  return `${currentText}${insertion}`;
}

function applyRemove(
  currentText: string,
  operation: NdfOperation,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
): string {
  if (operation.selector.kind === 'object') {
    const block = findSingleBlock(
      currentText,
      operation.selector,
      application,
      absolutePath,
      operationIndex,
    );
    return replaceRange(
      currentText,
      block.start,
      block.end,
      wrapRemovedSnippetWithMarkers(
        block.text,
        readLineIndent(currentText, block.start),
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
  }

  if (operation.selector.kind === 'field' && operation.selector.by === 'path') {
    ensure(typeof operation.selector.value === 'string', 'SchemaError', {
      absolutePath,
      modId: application.mod.config.id,
      modName: application.mod.config.name,
      patchId: application.patch.config.id,
      operationIndex,
      reason: 'Field path selectors require a string `value`.',
      suggestion: 'Set `selector.value` to a dotted NDF path.',
    });

    return updateFieldPath(
      currentText,
      operation.selector.value.split('.'),
      undefined,
      application,
      absolutePath,
      operationIndex,
      'remove',
      createMarkerContext('remove', operation.selector, application, absolutePath, operationIndex),
    );
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
  currentText: string,
  operation: NdfOperation,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
): string {
  if (operation.selector.kind === 'object') {
    return appendTopLevelRaw(currentText, operation, application, absolutePath, operationIndex);
  }

  if (operation.selector.kind === 'collection' && operation.selector.by === 'path') {
    ensure(typeof operation.selector.value === 'string', 'SchemaError', {
      absolutePath,
      modId: application.mod.config.id,
      modName: application.mod.config.name,
      patchId: application.patch.config.id,
      operationIndex,
      reason: 'Collection path selectors require a string `value`.',
      suggestion: 'Set `selector.value` to a collection path like `@0.DivisionIds`.',
    });

    return updateCollectionPath(
      currentText,
      operation.selector.value.split('.'),
      operation.value,
      operation.position,
      operation.leadingComment,
      application,
      absolutePath,
      operationIndex,
      'add',
      createMarkerContext('add', operation.selector, application, absolutePath, operationIndex),
    );
  }

  if (operation.selector.kind === 'field' && operation.selector.by === 'path') {
    ensure(typeof operation.selector.value === 'string', 'SchemaError', {
      absolutePath,
      modId: application.mod.config.id,
      modName: application.mod.config.name,
      patchId: application.patch.config.id,
      operationIndex,
      reason: 'Field path selectors require a string `value`.',
      suggestion: 'Set `selector.value` to a dotted NDF path.',
    });

    return updateFieldPath(
      currentText,
      operation.selector.value.split('.'),
      operation.value,
      application,
      absolutePath,
      operationIndex,
      'add',
      createMarkerContext('add', operation.selector, application, absolutePath, operationIndex),
    );
  }

  throw selectorError(
    operation.selector,
    application,
    absolutePath,
    operationIndex,
    'Unsupported add selector.',
  );
}

function appendTopLevelRaw(
  currentText: string,
  operation: NdfOperation,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
): string {
  const renderedValue = wrapAddedSnippetWithMarkers(
    renderTopLevelRawValue(operation.value, application, absolutePath, operationIndex).trimEnd(),
    '',
    createMarkerContext('add', operation.selector, application, absolutePath, operationIndex),
    operation.leadingComment,
  );
  const topLevelBlocks = findTopLevelBlocks(currentText);

  let insertAt = currentText.length;
  if (operation.selector.by === 'index') {
    ensure(typeof operation.selector.value === 'number', 'SchemaError', {
      absolutePath,
      modId: application.mod.config.id,
      modName: application.mod.config.name,
      patchId: application.patch.config.id,
      operationIndex,
      reason: 'Index selectors require a numeric `value`.',
      suggestion: 'Use `selector.value: -1` to append at the end or a block index to insert after.',
    });

    if (operation.selector.value >= 0) {
      const anchorBlock = topLevelBlocks[operation.selector.value];
      ensure(anchorBlock, 'SelectorError', {
        absolutePath,
        modId: application.mod.config.id,
        modName: application.mod.config.name,
        patchId: application.patch.config.id,
        operationIndex,
        reason: `Top-level block index ${operation.selector.value} was not found.`,
        suggestion: 'Use a valid top-level block index or `-1` to append at the end.',
      });
      insertAt = anchorBlock.end;
    }
  } else if (operation.selector.by === 'name') {
    ensure(typeof operation.selector.value === 'string', 'SchemaError', {
      absolutePath,
      modId: application.mod.config.id,
      modName: application.mod.config.name,
      patchId: application.patch.config.id,
      operationIndex,
      reason: 'Name selectors require a string `value`.',
      suggestion: 'Set `selector.value` to the anchor block name.',
    });
    const anchorBlock = findNamedBlockByName(currentText, operation.selector.value);
    ensure(anchorBlock, 'SelectorError', {
      absolutePath,
      modId: application.mod.config.id,
      modName: application.mod.config.name,
      patchId: application.patch.config.id,
      operationIndex,
      reason: `Anchor block \`${operation.selector.value}\` was not found.`,
      suggestion: 'Choose an existing top-level block name or switch to `selector.by: index`.',
    });
    insertAt = anchorBlock.end;
  } else {
    throw selectorError(
      operation.selector,
      application,
      absolutePath,
      operationIndex,
      'Unsupported add object selector.',
    );
  }

  const prefix = insertAt === 0 || currentText.slice(0, insertAt).endsWith('\n') ? '' : '\n';
  const suffix = renderedValue.endsWith('\n') ? '' : '\n';
  return `${currentText.slice(0, insertAt)}${prefix}${renderedValue}${suffix}${currentText.slice(insertAt)}`;
}

function renderTopLevelRawValue(
  value: unknown,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
): string {
  if (isRawNdfValue(value)) {
    return stripLineComments(value.$raw);
  }

  ensure(typeof value === 'string', 'SchemaError', {
    absolutePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    operationIndex,
    reason: 'Top-level add operations require `value: { $raw: "..." }`.',
    suggestion: 'Provide the exact top-level NDF snippet in `value.$raw`.',
  });
  return value;
}

function updateFieldPath(
  currentText: string,
  segments: string[],
  nextValue: unknown,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  mode: 'add' | 'modify' | 'remove',
  markerContext?: PatchMarkerContext,
): string {
  const [exportName, ...fieldSegments] = segments;
  ensure(exportName, 'SelectorError', {
    absolutePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    operationIndex,
    reason: 'Field path selectors must start with an export name.',
    suggestion: 'Use a selector like `Descriptor_Unit_X.SomeField`.',
  });
  const exportBlock = resolveTopLevelBlockReference(
    currentText,
    exportName,
    toPatchIdentityContext(application, absolutePath, operationIndex),
  );

  ensure(exportBlock, 'SelectorError', {
    absolutePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    operationIndex,
    reason: `Export \`${exportName}\` was not found.`,
    suggestion: 'Check the selector path and the target NDF file.',
  });

  const updatedBlockText = updateNestedField(
    exportBlock.text,
    fieldSegments,
    nextValue,
    application,
    absolutePath,
    operationIndex,
    mode,
    markerContext,
  );
  return replaceRange(currentText, exportBlock.start, exportBlock.end, updatedBlockText);
}

function updateCollectionPath(
  currentText: string,
  segments: string[],
  nextValue: unknown,
  position: CollectionPosition | undefined,
  leadingComment: string | undefined,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  mode: 'add',
  markerContext: PatchMarkerContext,
): string {
  const [rootReference, ...fieldSegments] = segments;
  ensure(rootReference, 'SelectorError', {
    absolutePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    operationIndex,
    reason: 'Collection path selectors must start with a top-level block reference.',
    suggestion: 'Use a named block like `DivisionTypeDescriptions.DivisionTypes` or `@0.Field`.',
  });
  const topLevelBlock = resolveTopLevelBlockReference(
    currentText,
    rootReference,
    toPatchIdentityContext(application, absolutePath, operationIndex),
  );
  const updatedBlockText =
    fieldSegments.length === 0
      ? updateCollectionValue(
          topLevelBlock.text,
          renderCollectionEntryValue(nextValue, application, absolutePath, operationIndex),
          position,
          toPatchInsertContext(
            application,
            absolutePath,
            operationIndex,
            markerContext,
            leadingComment,
          ),
        )
      : updateNestedCollectionField(
          topLevelBlock.text,
          fieldSegments,
          nextValue,
          position,
          leadingComment,
          application,
          absolutePath,
          operationIndex,
          mode,
          markerContext,
        );
  return replaceRange(currentText, topLevelBlock.start, topLevelBlock.end, updatedBlockText);
}

function resolveTopLevelBlockReference(
  currentText: string,
  reference: string,
  identity: CollectionIdentityContext,
): TopLevelBlock {
  if (/^@\d+$/.test(reference)) {
    const blockIndex = Number(reference.slice(1));
    const block = findTopLevelBlocks(currentText)[blockIndex];
    ensure(block, 'SelectorError', {
      ...identity,
      reason: `Top-level block index ${blockIndex} was not found.`,
      suggestion: 'Use a valid `@<index>` top-level block reference.',
    });
    return block;
  }

  const block = findNamedBlockByName(currentText, reference);
  ensure(block, 'SelectorError', {
    ...identity,
    reason: `Top-level block \`${reference}\` was not found.`,
    suggestion: 'Use an existing top-level block name or `@<index>` reference.',
  });
  return block;
}

function updateNestedField(
  blockText: string,
  pathSegments: string[],
  nextValue: unknown,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  mode: 'add' | 'modify' | 'remove',
  markerContext?: PatchMarkerContext,
): string {
  const [currentField, ...remaining] = pathSegments;
  ensure(currentField, 'SelectorError', {
    absolutePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    operationIndex,
    reason: 'Field path contains an empty segment.',
    suggestion: 'Fix the selector path so every segment has a field name.',
  });

  if (isCollectionSelectorSegment(currentField)) {
    const entryRange = findCollectionEntryRange(
      blockText,
      currentField,
      application,
      absolutePath,
      operationIndex,
    );

    if (remaining.length === 0) {
      ensure(mode === 'remove', 'SelectorError', {
        absolutePath,
        modId: application.mod.config.id,
        modName: application.mod.config.name,
        patchId: application.patch.config.id,
        operationIndex,
        reason: 'Collection entry selectors require a nested field unless used by `remove`.',
        suggestion:
          'Append a field path after the collection selector or switch to a remove operation.',
      });
      return removeCollectionEntry(blockText, entryRange, markerContext);
    }

    const updatedEntry = updateNestedField(
      entryRange.text,
      remaining,
      nextValue,
      application,
      absolutePath,
      operationIndex,
      mode,
      markerContext,
    );
    return replaceRange(blockText, entryRange.start, entryRange.end, updatedEntry);
  }

  if (remaining.length === 0) {
    return updateDirectField(
      blockText,
      currentField,
      nextValue,
      application,
      absolutePath,
      operationIndex,
      mode !== 'remove',
      mode === 'remove',
      markerContext,
    );
  }

  const fieldRange = requireDirectFieldRange(
    blockText,
    currentField,
    application,
    absolutePath,
    operationIndex,
    'Check the selector path or add the missing intermediate object first.',
  );

  const currentValue = blockText.slice(fieldRange.valueStart, fieldRange.valueEnd);
  return replaceNestedFieldValue(
    blockText,
    fieldRange,
    currentValue,
    currentField,
    remaining,
    application,
    absolutePath,
    operationIndex,
    (nestedText, nestedSegments) =>
      updateNestedField(
        nestedText,
        nestedSegments,
        nextValue,
        application,
        absolutePath,
        operationIndex,
        mode,
        markerContext,
      ),
  );
}

function updateNestedCollectionField(
  blockText: string,
  pathSegments: string[],
  nextValue: unknown,
  position: CollectionPosition | undefined,
  leadingComment: string | undefined,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  mode: 'add',
  markerContext: PatchMarkerContext,
): string {
  const [currentField, ...remaining] = pathSegments;
  ensure(currentField, 'SelectorError', {
    absolutePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    operationIndex,
    reason: 'Collection path contains an empty segment.',
    suggestion: 'Fix the selector path so every segment has a field name or selector.',
  });

  if (isCollectionSelectorSegment(currentField)) {
    const entryRange = findCollectionEntryRange(
      blockText,
      currentField,
      application,
      absolutePath,
      operationIndex,
    );
    ensure(remaining.length > 0, 'SelectorError', {
      absolutePath,
      modId: application.mod.config.id,
      modName: application.mod.config.name,
      patchId: application.patch.config.id,
      operationIndex,
      reason: 'Collection updates must target a nested field inside the selected collection entry.',
      suggestion: 'Append the collection field path after the collection selector.',
    });

    const updatedEntry = updateNestedCollectionField(
      entryRange.text,
      remaining,
      nextValue,
      position,
      leadingComment,
      application,
      absolutePath,
      operationIndex,
      mode,
      markerContext,
    );
    return replaceRange(blockText, entryRange.start, entryRange.end, updatedEntry);
  }

  if (remaining.length === 0) {
    const fieldRange = requireDirectFieldRange(
      blockText,
      currentField,
      application,
      absolutePath,
      operationIndex,
      'Check the selector path and target NDF file.',
    );
    const currentValue = blockText.slice(fieldRange.valueStart, fieldRange.valueEnd);
    const updatedValue = updateCollectionValue(
      currentValue,
      renderCollectionEntryValue(nextValue, application, absolutePath, operationIndex),
      position,
      toPatchInsertContext(
        application,
        absolutePath,
        operationIndex,
        markerContext,
        leadingComment,
      ),
    );
    return replaceRange(blockText, fieldRange.valueStart, fieldRange.valueEnd, updatedValue);
  }

  const fieldRange = requireDirectFieldRange(
    blockText,
    currentField,
    application,
    absolutePath,
    operationIndex,
    'Check the selector path or add the missing intermediate object first.',
  );

  const currentValue = blockText.slice(fieldRange.valueStart, fieldRange.valueEnd);
  return replaceNestedFieldValue(
    blockText,
    fieldRange,
    currentValue,
    currentField,
    remaining,
    application,
    absolutePath,
    operationIndex,
    (nestedText, nestedSegments) =>
      updateNestedCollectionField(
        nestedText,
        nestedSegments,
        nextValue,
        position,
        leadingComment,
        application,
        absolutePath,
        operationIndex,
        mode,
        markerContext,
      ),
  );
}

function requireDirectFieldRange(
  blockText: string,
  fieldName: string,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  suggestion: string,
) {
  const fieldRange = findDirectFieldRange(blockText, fieldName);
  ensure(fieldRange, 'SelectorError', {
    absolutePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    operationIndex,
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
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  updateNested: (nestedText: string, nestedSegments: string[]) => string,
): string {
  const currentValueCore = trimOuterWhitespace(currentValue);
  let updatedValue: string;

  if (isCollectionSelectorSegment(remaining[0] ?? '')) {
    updatedValue = updateNested(currentValueCore, remaining);
  } else {
    const nestedRange = extractFirstParenthesizedRange(currentValueCore);
    ensure(nestedRange, 'SelectorError', {
      absolutePath,
      modId: application.mod.config.id,
      modName: application.mod.config.name,
      patchId: application.patch.config.id,
      operationIndex,
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
  identity: CollectionIdentityContext;
  wrapEntry: (normalizedSnippet: string, indent: string) => string;
}

type CollectionIdentityContext = Pick<
  ErrorContext,
  'absolutePath' | 'modId' | 'modName' | 'patchId' | 'operationIndex'
>;

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
  const beforeInsertion = collectionValue.slice(0, insertionPoint);
  const afterInsertion = collectionValue.slice(insertionPoint);
  const prefix = beforeInsertion.endsWith('\n') ? '' : '\n';
  const suffix = resolveCollectionInsertionSuffix(beforeInsertion, afterInsertion, entryIndent);
  return preserveOuterWhitespace(
    currentValue,
    `${beforeInsertion}${prefix}${renderedEntry}${suffix}${afterInsertion}`,
  );
}

function toPatchIdentityContext(
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
): CollectionIdentityContext {
  return {
    absolutePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    operationIndex,
  };
}

function toPatchInsertContext(
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  markerContext: PatchMarkerContext,
  leadingComment?: string,
): CollectionInsertContext {
  return {
    identity: toPatchIdentityContext(application, absolutePath, operationIndex),
    wrapEntry: (snippet, indent) =>
      wrapAddedSnippetWithMarkers(snippet, indent, markerContext, leadingComment),
  };
}

export interface CollectionInsertOptions {
  position?: CollectionPosition | undefined;
  pathHint?: string | undefined;
}

export function insertCollectionEntryByPath(
  text: string,
  collectionPath: string,
  entry: string | { $raw: string },
  options: CollectionInsertOptions = {},
): string {
  const identity: CollectionIdentityContext = { absolutePath: options.pathHint ?? 'inline.ndf' };
  const segments = collectionPath
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const [blockReference, ...fieldSegments] = segments;
  ensure(blockReference !== undefined && fieldSegments.length > 0, 'SelectorError', {
    ...identity,
    reason: 'Collection path must reference a top-level block and at least one field.',
    suggestion: 'Use a path like `DivisionRules.DivisionIds`.',
  });

  const rawRenderedEntry = isRawNdfValue(entry)
    ? stripLineComments(entry.$raw)
    : renderScriptCollectionEntry(entry, identity);
  const context: CollectionInsertContext = {
    identity,
    wrapEntry: (snippet) => snippet,
  };

  const block = resolveTopLevelBlockReference(text, blockReference, identity);
  const updatedBlockText = insertCollectionEntryIntoContainer(
    block.text,
    fieldSegments,
    rawRenderedEntry,
    options.position,
    context,
  );
  const updatedText = replaceRange(text, block.start, block.end, updatedBlockText);
  validateNdf(updatedText, identity.absolutePath ?? 'inline.ndf');
  return updatedText;
}

function renderScriptCollectionEntry(entry: unknown, identity: CollectionIdentityContext): string {
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

function renderCollectionEntryValue(
  value: unknown,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
): string {
  if (isRawNdfValue(value)) {
    return stripLineComments(value.$raw);
  }

  ensure(typeof value === 'string', 'SchemaError', {
    absolutePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    operationIndex,
    reason: 'Collection add operations require `value: { $raw: "..." }`.',
    suggestion: 'Provide the exact collection entry snippet in `value.$raw`.',
  });
  return value;
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

function normalizeEntryForComparison(entryText: string): string {
  const withoutComments = stripLineComments(entryText);
  let normalized = '';
  let inString: StringDelimiter | undefined;
  let pendingSpace = false;
  for (let index = 0; index < withoutComments.length; index += 1) {
    const char = withoutComments[index] as string;
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

function resolveCollectionInsertionSuffix(
  beforeInsertion: string,
  afterInsertion: string,
  entryIndent: string,
): string {
  if (afterInsertion.length === 0 || afterInsertion.startsWith('\n')) {
    return '';
  }

  if (/(^|\n)[ \t]*$/.test(beforeInsertion) && /^[^\s]/.test(afterInsertion)) {
    return `\n${entryIndent}`;
  }

  return '\n';
}

function updateDirectField(
  blockText: string,
  fieldName: string,
  nextValue: unknown,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
  allowInsert: boolean,
  removeField = false,
  markerContext?: PatchMarkerContext,
): string {
  const fieldRange = findDirectFieldRange(blockText, fieldName);

  if (!fieldRange && removeField) {
    return blockText;
  }

  if (!fieldRange && allowInsert) {
    const lastParen = blockText.lastIndexOf(')');
    ensure(lastParen !== -1, 'ParserError', {
      absolutePath,
      modId: application.mod.config.id,
      modName: application.mod.config.name,
      patchId: application.patch.config.id,
      operationIndex,
      reason: 'Object block is malformed and is missing its closing parenthesis.',
      suggestion: 'Fix the target NDF object syntax before applying the patch.',
    });

    const insertionField = `    ${fieldName} = ${formatNdfValue(nextValue)}\n`;
    const insertion = markerContext
      ? `${wrapSnippetWithMarkers(insertionField.trimEnd(), '    ', markerContext)}\n`
      : insertionField;
    return `${blockText.slice(0, lastParen)}${insertion}${blockText.slice(lastParen)}`;
  }

  ensure(fieldRange, 'SelectorError', {
    absolutePath,
    modId: application.mod.config.id,
    modName: application.mod.config.name,
    patchId: application.patch.config.id,
    operationIndex,
    reason: `Field \`${fieldName}\` was not found.`,
    suggestion: 'Check the selector or use an add operation first.',
  });

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
  const currentValueCore = trimOuterWhitespace(currentValue);
  const originalFieldText = blockText.slice(fieldRange.start, fieldRange.end);
  const fieldIndent = originalFieldText.match(/^[ \t]*/)?.[0] ?? '';
  const renderedValue = formatNdfValue(nextValue);
  if (currentValueCore === renderedValue) {
    return blockText;
  }

  const updatedFieldText = replaceRange(
    originalFieldText,
    fieldRange.valueStart - fieldRange.start,
    fieldRange.valueEnd - fieldRange.start,
    preserveOuterWhitespace(currentValue, renderedValue),
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

function findSingleBlock(
  text: string,
  selector: Selector,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
): TopLevelBlock {
  if (selector.by === 'name') {
    ensure(typeof selector.value === 'string', 'SchemaError', {
      absolutePath,
      modId: application.mod.config.id,
      modName: application.mod.config.name,
      patchId: application.patch.config.id,
      operationIndex,
      reason: 'Name selectors require a string `value`.',
      suggestion: 'Provide the export name to match.',
    });

    const block = findNamedBlockByName(text, selector.value);
    ensure(block, 'SelectorError', {
      absolutePath,
      modId: application.mod.config.id,
      modName: application.mod.config.name,
      patchId: application.patch.config.id,
      operationIndex,
      reason: `Object \`${selector.value}\` was not found.`,
      suggestion: 'Check the selector name and target file.',
    });
    return block;
  }

  if (selector.by === 'index') {
    ensure(typeof selector.value === 'number', 'SchemaError', {
      absolutePath,
      modId: application.mod.config.id,
      modName: application.mod.config.name,
      patchId: application.patch.config.id,
      operationIndex,
      reason: 'Index selectors require a numeric `value`.',
      suggestion: 'Provide a zero-based top-level block index.',
    });

    const blocks = findTopLevelBlocks(text);
    const block = blocks[selector.value];
    ensure(block, 'SelectorError', {
      absolutePath,
      modId: application.mod.config.id,
      modName: application.mod.config.name,
      patchId: application.patch.config.id,
      operationIndex,
      reason: `Top-level block index ${selector.value} was not found.`,
      suggestion: 'Use a valid zero-based top-level block index.',
    });
    return block;
  }

  if (selector.by === 'match' && selector.where) {
    const matches = findTopLevelBlocks(text).filter((block) =>
      Object.entries(selector.where ?? {}).every(([fieldName, expected]) => {
        const directField = findDirectFieldRange(block.text, fieldName);
        if (!directField) {
          return false;
        }
        return (
          block.text.slice(directField.valueStart, directField.valueEnd).trim() ===
          formatNdfValue(expected)
        );
      }),
    );

    ensure(matches.length === 1, 'SelectorError', {
      absolutePath,
      modId: application.mod.config.id,
      modName: application.mod.config.name,
      patchId: application.patch.config.id,
      operationIndex,
      reason:
        matches.length === 0
          ? 'Match selector matched no objects.'
          : 'Match selector matched multiple objects.',
      suggestion: 'Use a more specific match, or switch to an exact name or path selector.',
    });
    const matchedBlock = matches[0];
    ensure(matchedBlock, 'SelectorError', {
      absolutePath,
      modId: application.mod.config.id,
      modName: application.mod.config.name,
      patchId: application.patch.config.id,
      operationIndex,
      reason: 'Match selector could not be resolved to exactly one object.',
      suggestion: 'Use a more specific match, or switch to an exact name or path selector.',
    });
    return matchedBlock;
  }

  throw selectorError(
    selector,
    application,
    absolutePath,
    operationIndex,
    'Unsupported selector mode.',
  );
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
    end = nextIndex + 1;
    while (end < collectionText.length && /\s/.test(collectionText[end] ?? '')) {
      end += 1;
    }
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

  const anchorIndex = currentValue.indexOf(position.anchor, innerStart);
  if (anchorIndex === -1 || anchorIndex >= innerEnd) {
    return innerEnd;
  }

  if (position.mode === 'before') {
    return anchorIndex;
  }

  return anchorIndex + position.anchor.length;
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

  const before = collectionText.slice(0, start);
  const after = collectionText.slice(end);
  const indent = readLineIndent(collectionText, entry.start);
  const prefix = before.endsWith('\n') ? '' : '\n';
  const suffix = after.startsWith('\n') ? '' : '\n';
  return `${before}${prefix}${wrapRemovedSnippetWithMarkers(entry.text, indent, markerContext)}${suffix}${after}`;
}
