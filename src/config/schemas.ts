import { z } from 'zod';
import type { BuilderProjectConfig } from '../builder-config.ts';
import type {
  AuthoredOperation,
  CollectionPosition,
  FileOperation,
  ForEachOperations,
  ModConfig,
  NdfOperation,
  PatchConfig,
  ScriptConfig,
  TempArtifactConfig,
} from '../types.ts';
import { bulkOperationSchema } from './bulk-operation-schema.ts';
import {
  commentSchema,
  definedValueSchema,
  identifierText,
  nonEmptyText,
  positiveInteger,
} from './shared-schemas.ts';

export const SUPPORTED_CONFIG_VERSION = 1;
type BuilderProjectConfigInput = {
  version: BuilderProjectConfig['version'];
  paths?: {
    [K in keyof BuilderProjectConfig['paths']]?: BuilderProjectConfig['paths'][K] | undefined;
  };
  settings?: {
    [K in keyof BuilderProjectConfig['settings']]?: BuilderProjectConfig['settings'][K] | undefined;
  };
};

/**
 * Exact match: accepting an older version means guessing what its author meant under
 * newer rules. A mismatch names both and offers migrating or staying on the release
 * that supports the version in hand.
 */
const configVersionSchema = z
  .number()
  .int()
  .positive()
  .superRefine((value, context) => {
    if (value === SUPPORTED_CONFIG_VERSION) return;
    context.addIssue({
      code: 'custom',
      message:
        value > SUPPORTED_CONFIG_VERSION
          ? `is \`${value}\`, but this YMB build only supports \`${SUPPORTED_CONFIG_VERSION}\`; update YMB to a release that supports \`${value}\``
          : `is \`${value}\`, but this YMB build only supports \`${SUPPORTED_CONFIG_VERSION}\`; follow the migration notes for the release that introduced \`${SUPPORTED_CONFIG_VERSION}\`, or keep using the YMB release that supports \`${value}\``,
    });
  })
  // Only the supported version survives the check above, so narrowing to the
  // literal keeps `BuilderProjectConfig['version']` exact.
  .transform((value) => value as typeof SUPPORTED_CONFIG_VERSION);

const matchWhereSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
const fieldPathSelectorSchema = z.strictObject({
  kind: z.literal('field'),
  by: z.literal('path'),
  value: nonEmptyText,
});
const collectionPathSelectorSchema = z.strictObject({
  kind: z.literal('collection'),
  by: z.literal('path'),
  value: nonEmptyText,
});
const objectNameSelectorSchema = z.strictObject({
  kind: z.literal('object'),
  by: z.literal('name'),
  value: nonEmptyText,
});
const objectIndexSelectorSchema = z.strictObject({
  kind: z.literal('object'),
  by: z.literal('index'),
  value: z.number().int(),
});
const objectMatchSelectorSchema = z.strictObject({
  kind: z.literal('object'),
  by: z.literal('match'),
  where: matchWhereSchema,
});
const objectSelectorSchema = z.union([
  objectNameSelectorSchema,
  objectIndexSelectorSchema,
  objectMatchSelectorSchema,
]);

const positionSchema: z.ZodType<CollectionPosition> = z
  .strictObject({
    mode: z.enum(['start', 'end', 'before', 'after']),
    anchor: nonEmptyText.optional(),
  })
  .superRefine((value, context) => {
    if ((value.mode === 'before' || value.mode === 'after') && !value.anchor) {
      context.addIssue({
        code: 'custom',
        message: '`before` and `after` positions require `anchor`.',
        path: ['anchor'],
      });
    }
  });

const destinationSchema = z.strictObject({
  name: nonEmptyText,
});
const changesSchema = z.record(z.string(), z.unknown());

/**
 * One schema per operation shape. `resolveOperationVariant` picks the one the config
 * meant, so a mistake reports the precise field rather than failed union branches.
 */
const operationVariants = {
  copyObject: z.strictObject({
    op: z.literal('copy'),
    selector: objectSelectorSchema,
    destination: destinationSchema,
    leadingComment: commentSchema,
  }),
  modifyFieldPath: z.strictObject({
    op: z.literal('modify'),
    selector: fieldPathSelectorSchema,
    value: definedValueSchema,
  }),
  modifyObject: z.strictObject({
    op: z.literal('modify'),
    selector: objectSelectorSchema,
    changes: changesSchema,
    leadingComment: commentSchema,
  }),
  addTopLevelBlock: z.strictObject({
    op: z.literal('add'),
    position: positionSchema.optional(),
    value: definedValueSchema,
    leadingComment: commentSchema,
  }),
  addCollectionEntry: z.strictObject({
    op: z.literal('add'),
    selector: collectionPathSelectorSchema,
    value: definedValueSchema,
    position: positionSchema.optional(),
    leadingComment: commentSchema,
  }),
  addFieldPath: z.strictObject({
    op: z.literal('add'),
    selector: fieldPathSelectorSchema,
    value: definedValueSchema,
  }),
  removeObject: z.strictObject({
    op: z.literal('remove'),
    selector: objectSelectorSchema,
    leadingComment: commentSchema,
  }),
  removeFieldPath: z.strictObject({
    op: z.literal('remove'),
    selector: fieldPathSelectorSchema,
  }),
  bulk: bulkOperationSchema,
} as const;

type OperationVariant = (typeof operationVariants)[keyof typeof operationVariants];

const operationSchema: z.ZodType<NdfOperation> = z.unknown().transform((value, context) => {
  const variant = resolveOperationVariant(value);
  if (typeof variant === 'string') {
    const operation = value as { op?: unknown; selector?: unknown };
    context.addIssue({
      code: 'custom',
      message: variant,
      path: operation.selector === undefined || operation.op === undefined ? [] : ['selector'],
    });
    return z.NEVER;
  }
  const parsed = variant.safeParse(value);
  if (parsed.success) return parsed.data as NdfOperation;
  forwardSchemaIssues(context, parsed.error.issues, true);
  return z.NEVER;
});

function resolveOperationVariant(value: unknown): OperationVariant | string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'Expected an operation object.';
  }
  const operation = value as Record<string, unknown>;
  if (operation.op === 'bulk') {
    return operationVariants.bulk;
  }
  const selector =
    operation.selector &&
    typeof operation.selector === 'object' &&
    !Array.isArray(operation.selector)
      ? (operation.selector as Record<string, unknown>)
      : undefined;

  // A new top-level block is the one operation with nothing to select yet.
  if (operation.op === 'add' && !selector) return operationVariants.addTopLevelBlock;
  if (!selector) return 'Operation requires a selector object.';

  const isFieldPath = selector.kind === 'field' && selector.by === 'path';
  switch (operation.op) {
    case 'copy':
      return selector.kind === 'object'
        ? operationVariants.copyObject
        : '`copy` expects an object selector using `name`, `index`, or `match`.';
    case 'modify':
      if (isFieldPath) return operationVariants.modifyFieldPath;
      if (selector.kind === 'object') return operationVariants.modifyObject;
      return '`modify` expects a field-path or object selector.';
    case 'add':
      if (selector.kind === 'collection' && selector.by === 'path') {
        return operationVariants.addCollectionEntry;
      }
      if (isFieldPath) return operationVariants.addFieldPath;
      if (selector.kind === 'object') {
        return 'Adding a top-level block takes no `selector`. Remove it, and use `position: { mode: after, anchor: <existing block name> }` to place the new block.';
      }
      return '`add` expects a collection-path or field-path selector, or no selector at all for a new top-level block.';
    case 'remove':
      if (selector.kind === 'object') return operationVariants.removeObject;
      if (isFieldPath) return operationVariants.removeFieldPath;
      return '`remove` expects an object or field-path selector.';
    default:
      return 'Operation `op` must be one of: `copy`, `modify`, `add`, `remove`, or `bulk`.';
  }
}

/**
 * Validated, not resolved: the list is usually a template expression and the
 * operations inside `do` reference a loop variable that exists only during expansion.
 * Dispatched on the presence of `forEach` so a mistake reports its own path.
 */
const forEachSchema: z.ZodType<ForEachOperations> = z.lazy(() =>
  z.strictObject({
    forEach: definedValueSchema,
    as: identifierText,
    do: z.array(authoredOperationSchema).min(1),
  }),
);

const authoredOperationSchema: z.ZodType<AuthoredOperation> = z
  .unknown()
  .transform((value, context) => {
    const isForEach =
      typeof value === 'object' && value !== null && !Array.isArray(value) && 'forEach' in value;
    const parsed = isForEach ? forEachSchema.safeParse(value) : operationSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    forwardSchemaIssues(context, parsed.error.issues);
    return z.NEVER;
  });

function forwardSchemaIssues(
  context: z.RefinementCtx,
  issues: readonly z.core.$ZodIssue[],
  expandUnrecognizedKeys = false,
): void {
  for (const issue of issues) {
    if (expandUnrecognizedKeys && issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        context.addIssue({
          code: 'custom',
          message: 'Property is not supported by the selected operation shape.',
          path: [...issue.path, key],
        });
      }
      continue;
    }
    context.addIssue({
      code: 'custom',
      message: issue.message,
      path: issue.path,
    });
  }
}

/**
 * A bare path is the common case and stays one line. The object form is for the
 * test that has to see the finished run, and says so.
 */
const scriptTestSchema = z.union([
  nonEmptyText.transform((testPath) => ({ path: testPath, when: 'before' as const })),
  z.strictObject({
    path: nonEmptyText,
    when: z.enum(['before', 'after']).optional().default('before'),
  }),
]);

const scriptSchema: z.ZodType<ScriptConfig, unknown> = z.strictObject({
  path: nonEmptyText,
  enabled: z.boolean().optional().default(true),
  tests: z.array(scriptTestSchema).optional().default([]),
});

const fileSourceSchema = z.strictObject({
  root: z.enum(['patch', 'mod', 'game', 'exampleAssets']),
  path: nonEmptyText,
});

const fileExpectationSchema = z.strictObject({
  files: positiveInteger,
});

const fileOperationSchema: z.ZodType<FileOperation> = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.enum(['add', 'copy', 'replace']),
    source: fileSourceSchema,
    destination: nonEmptyText,
    expect: fileExpectationSchema.optional(),
  }),
  z.strictObject({
    op: z.literal('remove'),
    target: nonEmptyText,
    expect: fileExpectationSchema.optional(),
  }),
]);

const readValuesSchema = z.record(
  nonEmptyText,
  z.strictObject({
    file: nonEmptyText,
    path: nonEmptyText,
  }),
);

const tempArtifactSchema: z.ZodType<TempArtifactConfig> = z.union([
  nonEmptyText.transform((path) => ({ path, unsafeToRemove: false })),
  z.strictObject({
    path: nonEmptyText,
    unsafeToRemove: z.boolean().optional().default(false),
  }),
]);

export const modSchema: z.ZodType<ModConfig> = z.strictObject({
  version: configVersionSchema,
  id: identifierText,
  name: nonEmptyText,
  description: z.string().optional(),
  dependsOn: z.array(identifierText).optional().default([]),
  priority: z.number().int().optional().default(0),
  allowWriteToModifiedFiles: z.boolean().optional().default(false),
  variables: z.record(z.string(), z.unknown()).optional(),
  readValues: readValuesSchema.optional(),
  enabled: z.boolean().optional().default(true),
  scripts: z.array(scriptSchema).optional().default([]),
  tempPaths: z.array(tempArtifactSchema).optional().default([]),
});

export const patchSchema: z.ZodType<PatchConfig> = z
  .strictObject({
    version: configVersionSchema,
    id: identifierText,
    name: nonEmptyText,
    description: z.string().optional(),
    enabled: z.boolean().optional().default(true),
    scope: z.enum(['prod', 'dev']),
    dependsOn: z.array(z.string()).optional().default([]),
    variables: z.record(z.string(), z.unknown()).optional(),
    readValues: readValuesSchema.optional(),
    files: z.array(fileOperationSchema).optional().default([]),
    targets: z
      .array(
        z.strictObject({
          file: nonEmptyText,
          expect: z
            .strictObject({
              referenced: z.array(nonEmptyText).min(1),
            })
            .optional(),
          operations: z.array(authoredOperationSchema).min(1),
        }),
      )
      .optional()
      .default([]),
    optional: z.boolean().optional().default(false),
    scripts: z.array(scriptSchema).optional().default([]),
    tempPaths: z.array(tempArtifactSchema).optional().default([]),
  })
  .superRefine((value, context) => {
    if (value.files.length === 0 && value.targets.length === 0 && value.scripts.length === 0) {
      context.addIssue({
        code: 'custom',
        message:
          'Patch configs must declare at least one entry in `files`, `targets`, or `scripts`.',
      });
    }
    if (value.optional && value.targets.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['optional'],
        message:
          'has no game data to depend on because this patch declares no `targets`. Use `enabled` to turn a patch off.',
      });
    }
  });

export const builderProjectSchema: z.ZodType<BuilderProjectConfigInput> = z.strictObject({
  version: configVersionSchema,
  paths: z
    .strictObject({
      gameRoot: nonEmptyText.optional(),
      sourceMods: nonEmptyText.optional(),
      workRoot: nonEmptyText.optional(),
      recoveryRoot: nonEmptyText.optional(),
      operationLockRoot: nonEmptyText.optional(),
      stateTransactionRoot: nonEmptyText.optional(),
    })
    .optional()
    .default({}),
  settings: z
    .strictObject({
      cacheMaxEntries: positiveInteger.optional(),
      cacheMaxBytes: positiveInteger.optional(),
      cacheMaxAgeDays: positiveInteger.optional(),
      scriptCacheMaxEntriesPerNamespace: positiveInteger.optional(),
      scriptCacheMaxBytesPerNamespace: positiveInteger.optional(),
      scriptTargetReadConcurrency: positiveInteger.optional(),
      scriptTimeoutSeconds: positiveInteger.optional(),
      mergeMaxEstimatedDiffWork: positiveInteger.optional(),
      mergeMaxTextBytesPerSide: positiveInteger.optional(),
      mergeMaxTextBytesCombined: positiveInteger.optional(),
      markerMaxEstimatedDiffWork: positiveInteger.optional(),
      markerMaxTextBytesPerSide: positiveInteger.optional(),
      markerMaxTextBytesCombined: positiveInteger.optional(),
    })
    .optional()
    .default({}),
});
