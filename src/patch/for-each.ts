import { YmbError } from '../errors.ts';
import { resolveTemplateValue } from '../templates.ts';
import type {
  AuthoredOperation,
  AuthoredPatchTarget,
  ForEachOperations,
  NdfOperation,
  PatchTarget,
} from '../types.ts';

/**
 * One target may not expand past this many operations. A `forEach` over a
 * mistyped variable can otherwise turn a three-line config into millions of
 * operations, and the failure would look like a hang rather than a mistake.
 */
const MAX_EXPANDED_OPERATIONS = 10_000;

interface ExpansionContext {
  absolutePath: string;
  modId: string;
  modName: string;
  patchId: string;
}

/**
 * Expansion runs before the generic template pass: the loop variable does not exist
 * in the surrounding scope, so resolving the target first refuses every `${role}`.
 */
export function expandPatchTarget(
  target: AuthoredPatchTarget,
  variables: Record<string, unknown>,
  context: ExpansionContext,
): PatchTarget {
  const operations: NdfOperation[] = [];
  // Every expanded operation records the authored line it came from, so a
  // failure or notice can name the line rather than a position in a list nobody
  // wrote down. Operations a `forEach` produced all carry the loop's own line:
  // that is the line the reader edits.
  const operationLines: number[] = [];
  expandInto(
    operations,
    operationLines,
    target.operations,
    target.operationLines,
    variables,
    context,
  );
  return {
    file: resolveTemplateValue(target.file, variables) as string,
    operations,
    ...(operationLines.some((line) => line > 0) ? { operationLines } : {}),
    ...(target.expect
      ? {
          expect: {
            referenced: target.expect.referenced.map(
              (name) => resolveTemplateValue(name, variables) as string,
            ),
          },
        }
      : {}),
  };
}

function expandInto(
  output: NdfOperation[],
  outputLines: number[],
  entries: AuthoredOperation[],
  entryLines: number[] | undefined,
  variables: Record<string, unknown>,
  context: ExpansionContext,
  inheritedLine = 0,
): void {
  for (const [entryIndex, entry] of entries.entries()) {
    const entryLine = entryLines?.[entryIndex] ?? inheritedLine;
    if (!isForEach(entry)) {
      assertWithinBudget(output.length + 1, context, entryIndex);
      output.push(resolveTemplateValue(entry, variables) as NdfOperation);
      outputLines.push(entryLine);
      continue;
    }

    for (const [itemIndex, item] of readItems(entry, variables, context, entryIndex).entries()) {
      assertWithinBudget(output.length + 1, context, entryIndex);
      expandInto(
        output,
        outputLines,
        entry.do,
        undefined,
        // A nested `forEach` sees its parent's binding, so loops can be layered
        // without threading names through by hand.
        { ...variables, [entry.as]: item, [`${entry.as}Index`]: itemIndex },
        context,
        entryLine,
      );
    }
  }
}

function readItems(
  entry: ForEachOperations,
  variables: Record<string, unknown>,
  context: ExpansionContext,
  entryIndex: number,
): unknown[] {
  const resolved = resolveTemplateValue(entry.forEach, variables);
  if (Array.isArray(resolved)) {
    return resolved;
  }
  throw new YmbError('SchemaError', {
    absolutePath: context.absolutePath,
    modId: context.modId,
    modName: context.modName,
    patchId: context.patchId,
    operationIndex: entryIndex,
    reason: `\`forEach\` needs a list, but this one resolved to ${describeValue(resolved)}.`,
    suggestion:
      'Point `forEach` at a variable holding a list, or write the list inline as `forEach: [a, b, c]`.',
  });
}

function assertWithinBudget(
  operationCount: number,
  context: ExpansionContext,
  entryIndex: number,
): void {
  if (operationCount <= MAX_EXPANDED_OPERATIONS) {
    return;
  }
  throw new YmbError('SchemaError', {
    absolutePath: context.absolutePath,
    modId: context.modId,
    modName: context.modName,
    patchId: context.patchId,
    operationIndex: entryIndex,
    reason: `\`forEach\` expanded past ${MAX_EXPANDED_OPERATIONS} operations for one target file.`,
    suggestion:
      'Check the list this loop reads. If it really is that large, split the work across several targets or a generation script.',
  });
}

function isForEach(entry: AuthoredOperation): entry is ForEachOperations {
  return typeof entry === 'object' && entry !== null && 'forEach' in entry;
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === '') return 'empty text';
  if (Array.isArray(value)) return 'a list';
  return `a ${typeof value}`;
}
