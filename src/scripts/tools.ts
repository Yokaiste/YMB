import type {
  BuildScriptCollectionPosition,
  BuildScriptGeneratedBlock,
  BuildScriptNdfBlock,
  BuildScriptNdfCollectionEntry,
  BuildScriptNdfCommentedFieldRange,
  BuildScriptNdfFieldRange,
  BuildScriptNdfRange,
  BuildScriptNdfTools,
  BuildScriptNdfValidationResult,
  BuildScriptTools,
} from 'ymb/api';
import { bulkMatchSchema } from '../config/bulk-operation-schema.ts';
import { formatErrorMessage, YmbError } from '../errors.ts';
import {
  buildGeneratedBlockMarkers,
  listGeneratedBlocks,
  renderGeneratedBlock,
  stripGeneratedBlocks,
  upsertGeneratedBlock,
} from '../generated-blocks.ts';
import { matchesBlock } from '../patch/ndf/bulk.ts';
import { findLineCommentIndex, stripLineComments } from '../patch/ndf/comments.ts';
import { insertCollectionEntryByPath } from '../patch/ndf/core.ts';
import {
  extractFirstCollectionRange,
  extractFirstParenthesizedRange,
  findCollectionEntries,
  findDirectFieldRange,
  findNamedBlockByName,
  findNestedFieldRange,
  findObjectBlocks,
  findTopLevelBlocks,
  readDirectFieldValue,
  readDirectFieldValues,
  readNestedFieldValue,
  readNestedFieldValues,
  readNestedPathValue,
  readNumericDefinitions,
  splitNdfPath,
} from '../patch/ndf/scan.ts';
import { formatNdfValue } from '../patch/ndf/shared.ts';
import { validateNdf } from '../patch/ndf/validate.ts';
import { parseNdfList, parseNdfScalar } from '../patch/ndf/values.ts';
import type { CollectionPosition, ScriptApplication, ScriptRuntimePlan } from '../types.ts';
import { SCRIPT_ASSERTION_TOOLS } from './assertion-tools.ts';
import { createScriptCacheTools } from './cache-tools.ts';
import { createScriptPatchTool } from './patch-tool.ts';
import { createScriptTextTools } from './text-tools.ts';
import { SCRIPT_VALUE_TOOLS } from './value-tools.ts';

export function createScriptTools(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
): BuildScriptTools {
  return Object.freeze({
    apiVersion: 4,
    patch: createScriptPatchTool(plan, script),
    ndf: SCRIPT_NDF_TOOLS,
    assert: SCRIPT_ASSERTION_TOOLS,
    values: SCRIPT_VALUE_TOOLS,
    text: createScriptTextTools(plan.context.builderConfig.settings),
    cache: createScriptCacheTools(plan, script),
  });
}

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
          code: error.context.code,
          line: error.context.line,
          column: error.context.column,
          offset: error.context.offset,
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

export const SCRIPT_NDF_TOOLS = Object.freeze<BuildScriptNdfTools>({
  validate,
  assertValid,
  readNumericDefinitions,
  matcher(match) {
    const parsed = bulkMatchSchema.parse(match);
    return (block) => matchesBlock(block, parsed);
  },
  findObjects(text: string): BuildScriptNdfBlock[] {
    return findObjectBlocks(text).map(toScriptBlock);
  },
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
  readField: readDirectFieldValue,
  readFields(blockText: string, fieldNames: readonly string[]): Record<string, string> {
    return Object.fromEntries(readDirectFieldValues(blockText, fieldNames));
  },
  readFieldDeep: readNestedFieldValue,
  readFieldsDeep(blockText: string, fieldNames: readonly string[]): Record<string, string> {
    return Object.fromEntries(readNestedFieldValues(blockText, fieldNames));
  },
  readPath(text: string, path: string | string[]): string | undefined {
    return readNestedPathValue(text, Array.isArray(path) ? path : splitNdfPath(path));
  },
  extractBody(text: string): BuildScriptNdfRange | undefined {
    return toScriptRange(text, extractFirstParenthesizedRange(text));
  },
  extractCollection(text: string): BuildScriptNdfRange | undefined {
    return toScriptRange(text, extractFirstCollectionRange(text));
  },
  parseValue: parseNdfScalar,
  parseList: parseNdfList,
  primaryTypeName(typeName: string): string {
    return typeName.trim().split(/\s+/)[0] ?? '';
  },
  listGeneratedBlocks(text: string): BuildScriptGeneratedBlock[] {
    return listGeneratedBlocks(text).map((block): BuildScriptGeneratedBlock => ({ ...block }));
  },
  stripGeneratedBlocks,
  generatedBlockMarkers: buildGeneratedBlockMarkers,
  renderGeneratedBlock,
  upsertGeneratedBlock,
  insertIntoCollection(
    text: string,
    collectionPath: string,
    entry: Parameters<BuildScriptNdfTools['insertIntoCollection']>[2],
    options?: { position?: BuildScriptCollectionPosition | undefined },
  ): string {
    return insertCollectionEntryByPath(text, collectionPath, entry, {
      position: toCollectionPosition(options?.position),
    });
  },
  formatValue: formatNdfValue,
  stripComments: stripLineComments,
});

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
