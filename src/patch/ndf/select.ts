import { ensure } from '../../errors.ts';
import type { PatchApplication, Selector } from '../../types.ts';
import type { NdfTextBuffer } from './buffer.ts';
import { findDirectFieldRange } from './scan.ts';
import {
  ensureFound,
  formatNdfValue,
  type PatchErrorIdentity,
  selectorError,
  type TopLevelBlock,
  toPatchErrorIdentity,
} from './shared.ts';

/** Every operation resolves its target this way and only then differs in what it writes. */
export function resolveTopLevelBlockReference(
  buffer: NdfTextBuffer,
  reference: string,
  identity: PatchErrorIdentity,
): TopLevelBlock {
  if (reference.startsWith('@type:')) {
    const requestedType = reference.slice('@type:'.length).trim();
    ensure(requestedType.length > 0, 'SelectorError', {
      ...identity,
      reason: '`@type:` is missing a type name.',
      suggestion: 'Add the type, such as `@type:TExampleDescriptor`.',
    });
    const matches = buffer
      .blocks()
      .filter((block) => block.typeName.trim().split(/\s+/u)[0] === requestedType);
    ensureFound(matches.length > 0, {
      ...identity,
      reason: `Top-level type selector \`${reference}\` matched no blocks.`,
      suggestion: 'Run `find --type <type> --file <path>` to check the type and file.',
    });
    ensure(matches.length === 1, 'SelectorError', {
      ...identity,
      reason: `Top-level type selector \`${reference}\` matched multiple blocks.`,
      suggestion:
        'Select a block by its exact name, or choose a type that occurs once in this file.',
    });
    const match = matches[0];
    ensure(match, 'SelectorError', {
      ...identity,
      reason: `Top-level type selector \`${reference}\` could not be resolved.`,
      suggestion:
        'Select a block by its exact name, or choose a type that occurs once in this file.',
    });
    return match;
  }

  if (/^@\d+$/.test(reference)) {
    const blockIndex = Number(reference.slice(1));
    const block = buffer.blocks()[blockIndex];
    ensureFound(block, {
      ...identity,
      reason: `Top-level block index ${blockIndex} was not found.`,
      suggestion: 'Check the block count; `@0` is the first block. Prefer a name when one exists.',
    });
    return block;
  }

  const block = buffer.findNamedBlock(reference);
  ensureFound(block, {
    ...identity,
    reason: `Top-level block \`${reference}\` was not found.`,
    suggestion:
      'Use `find --name <name> --file <path>` to check the file. An unnamed block can use `@type:<TypeName>` or a zero-based `@<index>`.',
  });
  return block;
}

export function findSingleBlock(
  buffer: NdfTextBuffer,
  selector: Selector,
  application: PatchApplication,
  absolutePath: string,
  operationIndex: number,
): TopLevelBlock {
  if (selector.by === 'name') {
    ensure(typeof selector.value === 'string', 'SchemaError', {
      ...toPatchErrorIdentity(application, absolutePath, operationIndex),
      reason: 'Name selectors require a string `value`.',
      suggestion: 'Set `value` to the exact block name in quotes.',
    });

    const block = buffer.findNamedBlock(selector.value);
    ensureFound(block, {
      ...toPatchErrorIdentity(application, absolutePath, operationIndex),
      reason: `Object \`${selector.value}\` was not found.`,
      suggestion: 'Run `find --name <name> --file <path>` and copy the matching block name.',
    });
    return block;
  }

  if (selector.by === 'index') {
    ensure(typeof selector.value === 'number', 'SchemaError', {
      ...toPatchErrorIdentity(application, absolutePath, operationIndex),
      reason: 'Index selectors require a numeric `value`.',
      suggestion: 'Set `value` to a number: `0` selects the first block.',
    });

    const blocks = buffer.blocks();
    const block = blocks[selector.value];
    ensureFound(block, {
      ...toPatchErrorIdentity(application, absolutePath, operationIndex),
      reason: `Top-level block index ${selector.value} was not found.`,
      suggestion: 'Check the block count and remember that `0` is the first block.',
    });
    return block;
  }

  if (selector.by === 'match' && selector.where) {
    const matches = buffer.blocks().filter((block) =>
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

    ensureFound(matches.length > 0, {
      ...toPatchErrorIdentity(application, absolutePath, operationIndex),
      reason: 'No object matches this selector.',
      suggestion:
        'Check the match text against the current file, or select a block by its exact name.',
    });
    ensure(matches.length === 1, 'SelectorError', {
      ...toPatchErrorIdentity(application, absolutePath, operationIndex),
      reason: 'More than one object matches this selector.',
      suggestion: 'Narrow the match text, or select a block by its exact name.',
    });
    const matchedBlock = matches[0];
    ensure(matchedBlock, 'SelectorError', {
      ...toPatchErrorIdentity(application, absolutePath, operationIndex),
      reason: 'The selector could not choose one object.',
      suggestion: 'Narrow the match text, or select a block by its exact name.',
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
