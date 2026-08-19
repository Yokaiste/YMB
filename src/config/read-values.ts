import { ensure } from '../errors.ts';
import { createNdfTextBuffer } from '../patch/ndf/buffer.ts';
import { readNestedPathValue, splitNdfPath } from '../patch/ndf/scan.ts';
import { resolveTopLevelBlockReference } from '../patch/ndf/select.ts';
import { assertGameRelativePath, isMissingPathError, resolveModTargetPath } from '../path-utils.ts';
import { readTrackedText } from '../tracked-targets.ts';
import type { BuilderContext, ReadValueConfig } from '../types.ts';

interface ReadValueOwner {
  absolutePath: string;
  modId: string;
  modName: string;
  patchId?: string | undefined;
}

/**
 * A number copied out of the game goes stale the moment WARNO or another mod changes
 * it, and the copy fails quietly. Reading it every build is the only version that
 * stays true.
 */
export async function resolveReadValues(
  readValues: Record<string, ReadValueConfig> | undefined,
  context: BuilderContext,
  owner: ReadValueOwner,
): Promise<Record<string, unknown> | undefined> {
  if (!readValues || Object.keys(readValues).length === 0) {
    return undefined;
  }

  const resolved = Object.create(null) as Record<string, unknown>;
  for (const [name, request] of Object.entries(readValues)) {
    resolved[name] = await readOneValue(name, request, context, owner);
  }
  return resolved;
}

async function readOneValue(
  name: string,
  request: ReadValueConfig,
  context: BuilderContext,
  owner: ReadValueOwner,
): Promise<unknown> {
  const relativePath = assertGameRelativePath(request.file, context.modRoot);
  const absolutePath = resolveModTargetPath(context.modRoot, relativePath);

  let content: string;
  try {
    content = await readTrackedText(context, absolutePath);
  } catch (error) {
    ensure(!isMissingPathError(error), 'ConfigError', {
      ...owner,
      reason: `\`readValues.${name}\` reads \`${relativePath}\`, which this install does not have.`,
      suggestion:
        'Check the path against the game files, or drop the entry if the value it reads is no longer there.',
    });
    throw error;
  }

  const segments = splitNdfPath(request.path);
  const [blockReference, ...fieldSegments] = segments;
  ensure(blockReference && fieldSegments.length > 0, 'ConfigError', {
    ...owner,
    reason: `\`readValues.${name}\` has the path \`${request.path}\`, which names no field to read.`,
    suggestion:
      'Give a block and at least one field, such as `@type:TSomeBlock.SomeField` or `SomeBlock.SomeField`.',
  });

  const block = resolveTopLevelBlockReference(createNdfTextBuffer(content), blockReference, {
    absolutePath,
    modId: owner.modId,
    modName: owner.modName,
    patchId: owner.patchId,
    operationIndex: undefined,
  });
  const rawValue = readNestedPathValue(block.text, fieldSegments);
  ensure(rawValue !== undefined, 'ConfigError', {
    ...owner,
    reason: `\`readValues.${name}\` found no \`${fieldSegments.join('.')}\` in \`${blockReference}\` of \`${relativePath}\`.`,
    suggestion:
      'Open that block and check the field name, or point the path at a field that is still there.',
  });

  return toTemplateValue(rawValue);
}

/**
 * NDF has no separate integer and float, so both read as numbers and stay usable in
 * arithmetic. Anything else is handed over as written rather than guessed at.
 */
function toTemplateValue(rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) return trimmed;
  const asNumber = Number(trimmed);
  return Number.isFinite(asNumber) ? asNumber : trimmed;
}
