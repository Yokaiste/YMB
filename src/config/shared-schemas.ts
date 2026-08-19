import { z } from 'zod';

/**
 * Schema pieces more than one config shape is built from. A value meaning the same
 * thing in two configs is declared once, so it also reports itself the same way.
 */

/** Any text a modder types: never blank, because a blank one is a mistake. */
export const nonEmptyText = z.string().min(1);

/** An identifier YMB can put in a path, a marker, or a command line. */
export const identifierText = nonEmptyText.regex(/^[A-Za-z0-9._-]+$/, {
  message: 'must use only letters, numbers, dots, underscores, and hyphens',
});

export const positiveInteger = z.number().int().positive();

/**
 * An optional `//` comment an operation attaches to what it wrote. Both the
 * leading and the trailing kind take the same text under the same rule.
 */
export const commentSchema = nonEmptyText.optional();

/**
 * `.optional()` cannot express this: a key written with no value is a mistake worth
 * naming, while `value: false` is perfectly ordinary.
 */
export const definedValueSchema = z.custom<unknown>((value) => value !== undefined, {
  message: 'is required and cannot be undefined',
});
