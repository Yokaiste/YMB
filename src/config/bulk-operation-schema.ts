import { z } from 'zod';
import type { BulkEdit, BulkOperation } from '../types.ts';
import { commentSchema, definedValueSchema, nonEmptyText } from './shared-schemas.ts';

const numberOrNumericTemplateSchema = z.custom<number | string>(
  (value) =>
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && /^\$\{[\s\S]+\}$/.test(value)),
  { message: 'must be a finite number or an exact template expression' },
);

const conditionValueSchema = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .transform((value) => (Array.isArray(value) ? value : [value]));

const conditionSchema = z
  .strictObject({
    on: z.enum(['name', 'type', 'text', 'field']),
    field: nonEmptyText.optional(),
    is: z.enum(['startsWith', 'endsWith', 'contains', 'notContains']),
    value: conditionValueSchema,
  })
  .superRefine((condition, context) => {
    if (condition.on === 'field' && condition.field === undefined) {
      context.addIssue({
        code: 'custom',
        message: '`on: field` conditions require `field`.',
        path: ['field'],
      });
    }
    if (condition.on !== 'field' && condition.field !== undefined) {
      context.addIssue({
        code: 'custom',
        message: '`field` is only supported by `on: field` conditions.',
        path: ['field'],
      });
    }
  });

const editTargetKeys = ['field', 'mapEntry', 'list'] as const;
const editActionKeys = ['set', 'multiply', 'insert', 'removeEntry', 'setEntry'] as const;
const listActionKeys = ['insert', 'removeEntry', 'setEntry'] as const;

const editSchema = z
  .strictObject({
    field: nonEmptyText.optional(),
    mapEntry: nonEmptyText.optional(),
    list: nonEmptyText.optional(),
    set: definedValueSchema.optional(),
    multiply: numberOrNumericTemplateSchema.optional(),
    insert: z
      .strictObject({
        value: definedValueSchema,
        position: z.enum(['start', 'end']).optional().default('end'),
      })
      .optional(),
    removeEntry: nonEmptyText.optional(),
    setEntry: z
      .strictObject({
        index: z.number().int(),
        value: definedValueSchema,
      })
      .optional(),
    trailingComment: commentSchema,
    minChanges: z.number().int().nonnegative().optional(),
  })
  .superRefine((edit, context) => {
    const targets = editTargetKeys.filter((key) => edit[key] !== undefined);
    if (targets.length !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'Bulk edits require exactly one of `field`, `mapEntry`, or `list`.',
      });
      return;
    }

    const actions = editActionKeys.filter((key) => edit[key] !== undefined);
    if (actions.length !== 1) {
      context.addIssue({
        code: 'custom',
        message:
          'Bulk edits require exactly one of `set`, `multiply`, `insert`, `removeEntry`, or `setEntry`.',
      });
      return;
    }

    const usesList = edit.list !== undefined;
    const usesListAction = listActionKeys.some((key) => edit[key] !== undefined);
    if (usesList !== usesListAction) {
      context.addIssue({
        code: 'custom',
        message: usesList
          ? '`list` edits support `insert`, `removeEntry`, and `setEntry` only.'
          : '`insert`, `removeEntry`, and `setEntry` require a `list` target.',
      });
    }
    if (usesList && edit.trailingComment !== undefined) {
      context.addIssue({
        code: 'custom',
        message: '`trailingComment` is supported by `field` and `mapEntry` edits only.',
        path: ['trailingComment'],
      });
    }
  })
  .transform((edit) => edit as BulkEdit);

export const bulkOperationSchema = z
  .strictObject({
    op: z.literal('bulk'),
    match: z.strictObject({
      mode: z.enum(['all', 'any']).optional().default('all'),
      conditions: z.array(conditionSchema).min(1),
    }),
    edits: z.array(editSchema).min(1),
    leadingComment: commentSchema,
    expect: z
      .strictObject({
        minBlocks: z.number().int().nonnegative().optional().default(1),
      })
      .optional()
      .default({ minBlocks: 1 }),
  })
  .transform((operation) => operation as BulkOperation);
