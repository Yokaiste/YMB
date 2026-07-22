import { z } from 'zod';
import type {
  CollectionPosition,
  ModConfig,
  NdfOperation,
  PatchConfig,
  ScriptConfig,
  TempArtifactConfig,
} from '../types.ts';
import { bulkOperationSchema } from './bulk-operation-schema.ts';

const SUPPORTED_CONFIG_VERSION = 1;

const nonEmptyId = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._-]+$/, {
    message: 'must use only letters, numbers, dots, underscores, and hyphens',
  });

const configVersionSchema = z
  .number()
  .int()
  .positive()
  .refine((value) => value <= SUPPORTED_CONFIG_VERSION, {
    message: `is newer than this YMB build supports (max \`${SUPPORTED_CONFIG_VERSION}\`); update YMB`,
  });

const matchWhereSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
const fieldPathSelectorSchema = z.strictObject({
  kind: z.literal('field'),
  by: z.literal('path'),
  value: z.string().min(1),
});
const collectionPathSelectorSchema = z.strictObject({
  kind: z.literal('collection'),
  by: z.literal('path'),
  value: z.string().min(1),
});
const objectNameSelectorSchema = z.strictObject({
  kind: z.literal('object'),
  by: z.literal('name'),
  value: z.string().min(1),
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
const objectAddSelectorSchema = z.union([objectNameSelectorSchema, objectIndexSelectorSchema]);

const positionSchema: z.ZodType<CollectionPosition> = z
  .strictObject({
    mode: z.enum(['start', 'end', 'before', 'after']),
    anchor: z.string().min(1).optional(),
  })
  .superRefine((value, context) => {
    if ((value.mode === 'before' || value.mode === 'after') && !value.anchor) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '`before` and `after` positions require `anchor`.',
        path: ['anchor'],
      });
    }
  });

const destinationSchema = z.strictObject({
  kind: z.enum(['sibling', 'name']),
  name: z.string().min(1),
});
const leadingCommentSchema = z.string().min(1).optional();
const definedValueSchema = z.custom<unknown>((value) => value !== undefined, {
  message: 'is required and cannot be undefined',
});
const changesSchema = z.record(z.string(), z.unknown());

const operationVariants = [
  z.strictObject({
    op: z.literal('copy'),
    selector: objectSelectorSchema,
    destination: destinationSchema,
    leadingComment: leadingCommentSchema,
  }),
  z.strictObject({
    op: z.literal('modify'),
    selector: fieldPathSelectorSchema,
    value: definedValueSchema,
  }),
  z.strictObject({
    op: z.literal('modify'),
    selector: objectSelectorSchema,
    changes: changesSchema,
    leadingComment: leadingCommentSchema,
  }),
  z.strictObject({
    op: z.literal('add'),
    selector: objectAddSelectorSchema,
    value: definedValueSchema,
    leadingComment: leadingCommentSchema,
  }),
  z.strictObject({
    op: z.literal('add'),
    selector: collectionPathSelectorSchema,
    value: definedValueSchema,
    position: positionSchema.optional(),
    leadingComment: leadingCommentSchema,
  }),
  z.strictObject({
    op: z.literal('add'),
    selector: fieldPathSelectorSchema,
    value: definedValueSchema,
  }),
  z.strictObject({
    op: z.literal('remove'),
    selector: objectSelectorSchema,
    leadingComment: leadingCommentSchema,
  }),
  z.strictObject({
    op: z.literal('remove'),
    selector: fieldPathSelectorSchema,
  }),
  bulkOperationSchema,
] as const;

const operationSchema: z.ZodType<NdfOperation> = z.unknown().transform((value, context) => {
  const variant = resolveOperationVariant(value);
  if (typeof variant === 'string') {
    const operation = value as { op?: unknown; selector?: unknown };
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: variant,
      path: operation.selector === undefined || operation.op === undefined ? [] : ['selector'],
    });
    return z.NEVER;
  }
  const parsed = variant.safeParse(value);
  if (parsed.success) return parsed.data as NdfOperation;
  for (const issue of parsed.error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Property is not supported by the selected operation shape.`,
          path: [...issue.path, key],
        });
      }
      continue;
    }
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: issue.message,
      path: issue.path,
    });
  }
  return z.NEVER;
});

function resolveOperationVariant(value: unknown): (typeof operationVariants)[number] | string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'Expected an operation object.';
  }
  const operation = value as Record<string, unknown>;
  if (operation.op === 'bulk') {
    return operationVariants[8];
  }
  const selector =
    operation.selector &&
    typeof operation.selector === 'object' &&
    !Array.isArray(operation.selector)
      ? (operation.selector as Record<string, unknown>)
      : undefined;
  if (!selector) return 'Operation requires a selector object.';

  switch (operation.op) {
    case 'copy':
      return selector.kind === 'object'
        ? operationVariants[0]
        : '`copy` expects an object selector using `name`, `index`, or `match`.';
    case 'modify':
      if (selector.kind === 'field' && selector.by === 'path') return operationVariants[1];
      if (selector.kind === 'object') return operationVariants[2];
      return '`modify` expects a field-path or object selector.';
    case 'add':
      if (selector.kind === 'object' && (selector.by === 'name' || selector.by === 'index')) {
        return operationVariants[3];
      }
      if (selector.kind === 'collection' && selector.by === 'path') return operationVariants[4];
      if (selector.kind === 'field' && selector.by === 'path') return operationVariants[5];
      return '`add` expects an object name/index, collection-path, or field-path selector.';
    case 'remove':
      if (selector.kind === 'object') return operationVariants[6];
      if (selector.kind === 'field' && selector.by === 'path') return operationVariants[7];
      return '`remove` expects an object or field-path selector.';
    default:
      return 'Operation `op` must be one of: `copy`, `modify`, `add`, `remove`, or `bulk`.';
  }
}

const scriptSchema: z.ZodType<ScriptConfig> = z.strictObject({
  path: z.string().min(1),
  enabled: z.boolean().optional().default(true),
  tests: z.array(z.string().min(1)).optional().default([]),
});

const tempArtifactSchema: z.ZodType<TempArtifactConfig> = z.union([
  z
    .string()
    .min(1)
    .transform((path) => ({ path, unsafeToRemove: false })),
  z.strictObject({
    path: z.string().min(1),
    unsafeToRemove: z.boolean().optional().default(false),
  }),
]);

export const modSchema: z.ZodType<ModConfig> = z.strictObject({
  version: configVersionSchema,
  id: nonEmptyId,
  name: z.string().min(1),
  description: z.string().optional(),
  dependsOn: z.array(nonEmptyId).optional().default([]),
  priority: z.number().int().optional().default(0),
  allowWriteToModifiedFiles: z.boolean().optional().default(false),
  variables: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional().default(true),
  scripts: z.array(scriptSchema).optional().default([]),
  tempPaths: z.array(tempArtifactSchema).optional().default([]),
});

export const patchSchema: z.ZodType<PatchConfig> = z
  .strictObject({
    version: configVersionSchema,
    id: nonEmptyId,
    name: z.string().min(1),
    description: z.string().optional(),
    enabled: z.boolean().optional().default(true),
    scope: z.enum(['prod', 'dev']),
    dependsOn: z.array(z.string()).optional().default([]),
    variables: z.record(z.string(), z.unknown()).optional(),
    targets: z
      .array(
        z.strictObject({
          file: z.string().min(1),
          operations: z.array(operationSchema).min(1),
        }),
      )
      .optional()
      .default([]),
    scripts: z.array(scriptSchema).optional().default([]),
    tempPaths: z.array(tempArtifactSchema).optional().default([]),
  })
  .superRefine((value, context) => {
    if (value.targets.length === 0 && value.scripts.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Patch configs must declare at least one entry in `targets` or `scripts`.',
      });
    }
  });
