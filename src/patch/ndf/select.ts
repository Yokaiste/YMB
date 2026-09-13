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
      reason: 'Top-level type selector is missing its type name.',
      suggestion: 'Use a semantic reference such as `@type:TUISpecificCountriesInfos`.',
    });
    const matches = buffer
      .blocks()
      .filter((block) => block.typeName.trim().split(/\s+/u)[0] === requestedType);
    ensureFound(matches.length > 0, {
      ...identity,
      reason: `Top-level type selector \`${reference}\` matched no blocks.`,
      suggestion: 'Use a type that uniquely identifies one top-level block in the target file.',
    });
    ensure(matches.length === 1, 'SelectorError', {
      ...identity,
      reason: `Top-level type selector \`${reference}\` matched multiple blocks.`,
      suggestion: 'Use a type that uniquely identifies one top-level block in the target file.',
    });
    const match = matches[0];
    ensure(match, 'SelectorError', {
      ...identity,
      reason: `Top-level type selector \`${reference}\` could not be resolved.`,
      suggestion: 'Use a type that uniquely identifies one top-level block in the target file.',
    });
    return match;
  }

  if (/^@\d+$/.test(reference)) {
    const blockIndex = Number(reference.slice(1));
    const block = buffer.blocks()[blockIndex];
    ensureFound(block, {
      ...identity,
      reason: `Top-level block index ${blockIndex} was not found.`,
      suggestion: 'Use a valid `@<index>` top-level block reference.',
    });
    return block;
  }

  const block = buffer.findNamedBlock(reference);
  ensureFound(block, {
    ...identity,
    reason: `Top-level block \`${reference}\` was not found.`,
    suggestion:
      'Use an existing top-level block name, a semantic `@type:<TypeName>` reference, or `@<index>` only as a last resort.',
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
      suggestion: 'Provide the export name to match.',
    });

    const block = buffer.findNamedBlock(selector.value);
    ensureFound(block, {
      ...toPatchErrorIdentity(application, absolutePath, operationIndex),
      reason: `Object \`${selector.value}\` was not found.`,
      suggestion: 'Check the selector name and target file.',
    });
    return block;
  }

  if (selector.by === 'index') {
    ensure(typeof selector.value === 'number', 'SchemaError', {
      ...toPatchErrorIdentity(application, absolutePath, operationIndex),
      reason: 'Index selectors require a numeric `value`.',
      suggestion: 'Provide a zero-based top-level block index.',
    });

    const blocks = buffer.blocks();
    const block = blocks[selector.value];
    ensureFound(block, {
      ...toPatchErrorIdentity(application, absolutePath, operationIndex),
      reason: `Top-level block index ${selector.value} was not found.`,
      suggestion: 'Use a valid zero-based top-level block index.',
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
      reason: 'Match selector matched no objects.',
      suggestion: 'Use a more specific match, or switch to an exact name or path selector.',
    });
    ensure(matches.length === 1, 'SelectorError', {
      ...toPatchErrorIdentity(application, absolutePath, operationIndex),
      reason: 'Match selector matched multiple objects.',
      suggestion: 'Use a more specific match, or switch to an exact name or path selector.',
    });
    const matchedBlock = matches[0];
    ensure(matchedBlock, 'SelectorError', {
      ...toPatchErrorIdentity(application, absolutePath, operationIndex),
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
