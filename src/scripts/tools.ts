import type {
  BuildScriptCollectionPosition,
  BuildScriptGeneratedBlock,
  BuildScriptGeneratedBlockMarkers,
  BuildScriptGeneratedBlockOptions,
  BuildScriptNdfBlock,
  BuildScriptNdfCollectionEntry,
  BuildScriptNdfCommentedFieldRange,
  BuildScriptNdfFieldRange,
  BuildScriptNdfRange,
  BuildScriptNdfScalar,
  BuildScriptNdfTools,
  BuildScriptNdfValidationResult,
  BuildScriptTools,
} from '../api.ts';
import { formatErrorMessage, YmbError } from '../errors.ts';
import {
  buildGeneratedBlockMarkers,
  listGeneratedBlocks,
  renderGeneratedBlock,
  stripGeneratedBlocks,
  upsertGeneratedBlock,
} from '../generated-blocks.ts';
import {
  extractFirstCollectionRange,
  extractFirstParenthesizedRange,
  findCollectionEntries,
  findDirectFieldRange,
  findNamedBlockByName,
  findNestedFieldRange,
  findTopLevelBlocks,
  readDirectFieldValue,
  readDirectFieldValues,
  readNestedFieldValue,
  readNestedFieldValues,
  readNestedPathValue,
} from '../patch/ndf/scan.ts';
import { formatNdfValue, stripLineComments } from '../patch/ndf/shared.ts';
import { findLineCommentIndex, parseNdfList, parseNdfScalar } from '../patch/ndf/values.ts';
import { insertCollectionEntryByPath, validateNdf } from '../patch/ndf.ts';
import type { CollectionPosition, ScriptApplication, ScriptRuntimePlan } from '../types.ts';
import { createScriptAssertionTools } from './assertion-tools.ts';
import { createScriptCacheTools } from './cache-tools.ts';
import { createScriptTextTools } from './text-tools.ts';
import { createScriptValueTools } from './value-tools.ts';

export function createScriptTools(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
): BuildScriptTools {
  return Object.freeze({
    apiVersion: 4,
    ndf: SCRIPT_NDF_TOOLS,
    assert: SCRIPT_ASSERTION_TOOLS,
    values: SCRIPT_VALUE_TOOLS,
    text: SCRIPT_TEXT_TOOLS,
    cache: createScriptCacheTools(plan, script),
  });
}

export function createScriptNdfTools(): BuildScriptNdfTools {
  const validate = (text: string, pathHint = 'inline.ndf'): BuildScriptNdfValidationResult => {
    try {
      validateNdf(text, pathHint);
      return { ok: true };
    } catch (error) {
      if (error instanceof YmbError) {
        return {
          ok: false,
          error: {
            category: error.category,
            message: formatErrorMessage(error.category, error.context),
            absolutePath: error.context.absolutePath,
            reason: error.context.reason,
            suggestion: error.context.suggestion,
            details: error.context.details ?? [],
          },
        };
      }
      throw error;
    }
  };
  const assertValid = (text: string, pathHint = 'inline.ndf'): void => {
    validateNdf(text, pathHint);
  };

  return {
    validate,
    assertValid,
    findTopLevelBlocks(text: string): BuildScriptNdfBlock[] {
      return findTopLevelBlocks(text).map(toScriptBlock);
    },
    findNamedBlock(text: string, name: string): BuildScriptNdfBlock | undefined {
      const block = findNamedBlockByName(text, name);
      return block ? toScriptBlock(block) : undefined;
    },
    findField(blockText: string, fieldName: string): BuildScriptNdfFieldRange | undefined {
      return toScriptFieldRange(blockText, findDirectFieldRange(blockText, fieldName));
    },
    findFieldDeep(blockText: string, fieldName: string): BuildScriptNdfFieldRange | undefined {
      return toScriptFieldRange(blockText, findNestedFieldRange(blockText, fieldName));
    },
    findFieldWithComment(
      blockText: string,
      fieldName: string,
    ): BuildScriptNdfCommentedFieldRange | undefined {
      const fieldRange = findDirectFieldRange(blockText, fieldName);
      if (!fieldRange) {
        return undefined;
      }
      const commentIndex = findLineCommentIndex(
        blockText,
        fieldRange.valueStart,
        fieldRange.valueEnd,
      );
      const valueEnd = commentIndex === -1 ? fieldRange.valueEnd : commentIndex;
      const base: BuildScriptNdfCommentedFieldRange = {
        ...fieldRange,
        text: blockText.slice(fieldRange.start, fieldRange.end),
        valueText: blockText.slice(fieldRange.valueStart, valueEnd).trim(),
      };
      if (commentIndex === -1) {
        return base;
      }
      return {
        ...base,
        trailingComment: blockText.slice(commentIndex + 2, fieldRange.valueEnd).trim(),
      };
    },
    findCollectionEntries(collectionText: string): BuildScriptNdfCollectionEntry[] {
      return findCollectionEntries(collectionText).map((entry) => ({ ...entry }));
    },
    readField(blockText: string, fieldName: string): string | undefined {
      return readDirectFieldValue(blockText, fieldName);
    },
    readFields(blockText: string, fieldNames: readonly string[]): Record<string, string> {
      return Object.fromEntries(readDirectFieldValues(blockText, fieldNames));
    },
    readFieldDeep(blockText: string, fieldName: string): string | undefined {
      return readNestedFieldValue(blockText, fieldName);
    },
    readFieldsDeep(blockText: string, fieldNames: readonly string[]): Record<string, string> {
      return Object.fromEntries(readNestedFieldValues(blockText, fieldNames));
    },
    readPath(text: string, path: string | string[]): string | undefined {
      return readNestedPathValue(text, toPathSegments(path));
    },
    extractBody(text: string): BuildScriptNdfRange | undefined {
      return toScriptRange(text, extractFirstParenthesizedRange(text));
    },
    extractCollection(text: string): BuildScriptNdfRange | undefined {
      return toScriptRange(text, extractFirstCollectionRange(text));
    },
    parseValue(valueText: string): BuildScriptNdfScalar {
      return parseNdfScalar(valueText);
    },
    parseList(collectionText: string): BuildScriptNdfScalar[] {
      return parseNdfList(collectionText);
    },
    primaryTypeName(typeName: string): string {
      return typeName.trim().split(/\s+/)[0] ?? '';
    },
    listGeneratedBlocks(text: string): BuildScriptGeneratedBlock[] {
      return listGeneratedBlocks(text).map((block): BuildScriptGeneratedBlock => ({ ...block }));
    },
    stripGeneratedBlocks(text: string): string {
      return stripGeneratedBlocks(text);
    },
    generatedBlockMarkers(ownerId: string): BuildScriptGeneratedBlockMarkers {
      return buildGeneratedBlockMarkers(ownerId);
    },
    renderGeneratedBlock(options: BuildScriptGeneratedBlockOptions): string {
      return renderGeneratedBlock(options);
    },
    upsertGeneratedBlock(text: string, generatedBlock: string, ownerId: string): string {
      return upsertGeneratedBlock(text, generatedBlock, ownerId);
    },
    insertIntoCollection(
      text: string,
      collectionPath: string,
      entry: string | { $raw: string },
      options?: { position?: BuildScriptCollectionPosition | undefined },
    ): string {
      return insertCollectionEntryByPath(text, collectionPath, entry, {
        position: toCollectionPosition(options?.position),
      });
    },
    formatValue(value: unknown): string {
      return formatNdfValue(value);
    },
    stripComments(text: string): string {
      return stripLineComments(text);
    },
  } satisfies BuildScriptNdfTools;
}

function toPathSegments(path: string | string[]): string[] {
  return Array.isArray(path)
    ? [...path]
    : path
        .split('.')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);
}

function toScriptRange(
  text: string,
  range: { start: number; end: number } | undefined,
): BuildScriptNdfRange | undefined {
  return range ? { ...range, text: text.slice(range.start, range.end) } : undefined;
}

function toCollectionPosition(
  position: BuildScriptCollectionPosition | undefined,
): CollectionPosition | undefined {
  if (position === undefined) {
    return undefined;
  }
  if (position === 'start' || position === 'end') {
    return { mode: position };
  }
  if ('before' in position) {
    return { mode: 'before', anchor: position.before };
  }
  return { mode: 'after', anchor: position.after };
}

const SCRIPT_NDF_TOOLS = Object.freeze(createScriptNdfTools());
const SCRIPT_ASSERTION_TOOLS = createScriptAssertionTools();
const SCRIPT_VALUE_TOOLS = createScriptValueTools();
const SCRIPT_TEXT_TOOLS = createScriptTextTools();

function toScriptBlock(block: BuildScriptNdfBlock): BuildScriptNdfBlock {
  return { ...block };
}

function toScriptFieldRange(
  blockText: string,
  fieldRange:
    | {
        start: number;
        end: number;
        valueStart: number;
        valueEnd: number;
      }
    | undefined,
): BuildScriptNdfFieldRange | undefined {
  if (!fieldRange) {
    return undefined;
  }

  return {
    ...fieldRange,
    text: blockText.slice(fieldRange.start, fieldRange.end),
    valueText: blockText.slice(fieldRange.valueStart, fieldRange.valueEnd).trim(),
  };
}
