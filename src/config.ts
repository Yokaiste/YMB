import { readdir } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { BUILDER_CONFIG } from './builder-config.ts';
import { ensure, YmbError } from './errors.ts';
import { statIfExists } from './path-utils.ts';
import type {
  BuilderContext,
  CollectionPosition,
  ModConfig,
  NdfOperation,
  PatchConfig,
  Scope,
  ScriptConfig,
  Selector,
  TempArtifactConfig,
} from './types.ts';

export const SUPPORTED_CONFIG_VERSION = 1;

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

const scopeSchema = z.enum(['prod', 'dev']);

const selectorSchema: z.ZodType<Selector> = z.strictObject({
  kind: z.enum(['field', 'object', 'collection']),
  by: z.enum(['path', 'name', 'match', 'index']),
  value: z.union([z.string(), z.number()]).optional(),
  where: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const positionSchema: z.ZodType<CollectionPosition> = z
  .strictObject({
    mode: z.enum(['start', 'end', 'before', 'after']),
    anchor: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.mode === 'before' || value.mode === 'after') && !value.anchor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '`before` and `after` positions require `anchor`.',
        path: ['anchor'],
      });
    }
  });

function addUnsupportedConfigFieldIssue(
  ctx: z.RefinementCtx,
  field: keyof NdfOperation,
  message: string,
) {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message,
    path: [field],
  });
}

function isObjectSelectorModeSupportedForLookup(selector: Selector): boolean {
  return (
    selector.kind === 'object' &&
    (selector.by === 'name' || selector.by === 'index' || selector.by === 'match')
  );
}

function isFieldPathSelector(selector: Selector): boolean {
  return selector.kind === 'field' && selector.by === 'path';
}

function isCollectionPathSelector(selector: Selector): boolean {
  return selector.kind === 'collection' && selector.by === 'path';
}

const operationSchema: z.ZodType<NdfOperation> = z
  .strictObject({
    op: z.enum(['add', 'remove', 'modify', 'copy']),
    selector: selectorSchema,
    value: z.unknown().optional(),
    changes: z.record(z.string(), z.unknown()).optional(),
    leadingComment: z.string().min(1).optional(),
    destination: z
      .strictObject({
        kind: z.enum(['sibling', 'name']),
        name: z.string().min(1),
      })
      .optional(),
    position: positionSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const isObjectLookup = isObjectSelectorModeSupportedForLookup(value.selector);
    const isFieldPath = isFieldPathSelector(value.selector);
    const isCollectionPath = isCollectionPathSelector(value.selector);

    switch (value.op) {
      case 'copy':
        if (!isObjectLookup) {
          addUnsupportedConfigFieldIssue(
            ctx,
            'selector',
            '`copy` operations support `object` selectors using `by: name`, `by: index`, or `by: match` only.',
          );
        }
        if (!value.destination) {
          addUnsupportedConfigFieldIssue(
            ctx,
            'destination',
            '`copy` operations require `destination`.',
          );
        }
        if (value.value !== undefined) {
          addUnsupportedConfigFieldIssue(ctx, 'value', '`copy` operations do not support `value`.');
        }
        if (value.changes !== undefined) {
          addUnsupportedConfigFieldIssue(
            ctx,
            'changes',
            '`copy` operations do not support `changes`.',
          );
        }
        if (value.position !== undefined) {
          addUnsupportedConfigFieldIssue(
            ctx,
            'position',
            '`copy` operations do not support `position`.',
          );
        }
        break;

      case 'modify':
        if (isFieldPath) {
          if (value.value === undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'value',
              'Field-path `modify` operations require `value`.',
            );
          }
          if (value.changes !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'changes',
              'Field-path `modify` operations do not support `changes`.',
            );
          }
          if (value.destination !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'destination',
              '`modify` operations do not support `destination`.',
            );
          }
          if (value.position !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'position',
              'Field-path `modify` operations do not support `position`.',
            );
          }
          if (value.leadingComment !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'leadingComment',
              'Field-path `modify` operations do not support `leadingComment`.',
            );
          }
          break;
        }

        if (isObjectLookup) {
          if (value.changes === undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'changes',
              'Object `modify` operations require `changes`.',
            );
          }
          if (value.value !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'value',
              'Object `modify` operations do not support `value`.',
            );
          }
          if (value.destination !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'destination',
              '`modify` operations do not support `destination`.',
            );
          }
          if (value.position !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'position',
              'Object `modify` operations do not support `position`.',
            );
          }
          break;
        }

        addUnsupportedConfigFieldIssue(
          ctx,
          'selector',
          '`modify` operations support `field` selectors using `by: path` and `object` selectors using `by: name`, `by: index`, or `by: match` only.',
        );
        break;

      case 'add':
        if (value.selector.kind === 'object') {
          if (value.selector.by !== 'name' && value.selector.by !== 'index') {
            addUnsupportedConfigFieldIssue(
              ctx,
              'selector',
              'Object `add` operations support `by: name` and `by: index` only.',
            );
          }
          if (value.value === undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'value',
              'Object `add` operations require `value`.',
            );
          }
          if (value.changes !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'changes',
              '`add` operations do not support `changes`.',
            );
          }
          if (value.destination !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'destination',
              '`add` operations do not support `destination`.',
            );
          }
          if (value.position !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'position',
              'Object `add` operations do not support `position`.',
            );
          }
          break;
        }

        if (isCollectionPath) {
          if (value.value === undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'value',
              'Collection-path `add` operations require `value`.',
            );
          }
          if (value.changes !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'changes',
              '`add` operations do not support `changes`.',
            );
          }
          if (value.destination !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'destination',
              '`add` operations do not support `destination`.',
            );
          }
          break;
        }

        if (isFieldPath) {
          if (value.value === undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'value',
              'Field-path `add` operations require `value`.',
            );
          }
          if (value.changes !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'changes',
              '`add` operations do not support `changes`.',
            );
          }
          if (value.destination !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'destination',
              '`add` operations do not support `destination`.',
            );
          }
          if (value.position !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'position',
              'Field-path `add` operations do not support `position`.',
            );
          }
          if (value.leadingComment !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'leadingComment',
              'Field-path `add` operations do not support `leadingComment`.',
            );
          }
          break;
        }

        addUnsupportedConfigFieldIssue(
          ctx,
          'selector',
          '`add` operations support `object` selectors using `by: name` or `by: index`, `collection` selectors using `by: path`, and `field` selectors using `by: path` only.',
        );
        break;

      case 'remove':
        if (isObjectLookup) {
          if (value.value !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'value',
              '`remove` operations do not support `value`.',
            );
          }
          if (value.changes !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'changes',
              '`remove` operations do not support `changes`.',
            );
          }
          if (value.destination !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'destination',
              '`remove` operations do not support `destination`.',
            );
          }
          if (value.position !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'position',
              '`remove` operations do not support `position`.',
            );
          }
          break;
        }

        if (isFieldPath) {
          if (value.value !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'value',
              '`remove` operations do not support `value`.',
            );
          }
          if (value.changes !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'changes',
              '`remove` operations do not support `changes`.',
            );
          }
          if (value.destination !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'destination',
              '`remove` operations do not support `destination`.',
            );
          }
          if (value.position !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'position',
              '`remove` operations do not support `position`.',
            );
          }
          if (value.leadingComment !== undefined) {
            addUnsupportedConfigFieldIssue(
              ctx,
              'leadingComment',
              'Field-path `remove` operations do not support `leadingComment`.',
            );
          }
          break;
        }

        addUnsupportedConfigFieldIssue(
          ctx,
          'selector',
          '`remove` operations support `object` selectors using `by: name`, `by: index`, or `by: match`, and `field` selectors using `by: path` only.',
        );
        break;
    }
  });

const scriptSchema: z.ZodType<ScriptConfig> = z.strictObject({
  path: z.string().min(1),
  enabled: z.boolean().optional().default(true),
  tests: z.array(z.string().min(1)).optional().default([]),
});

const tempArtifactSchema: z.ZodType<TempArtifactConfig> = z.union([
  z
    .string()
    .min(1)
    .transform((path) => ({
      path,
      unsafeToRemove: false,
    })),
  z.strictObject({
    path: z.string().min(1),
    unsafeToRemove: z.boolean().optional().default(false),
  }),
]);

const modSchema = z.strictObject({
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

const patchSchema = z
  .strictObject({
    version: configVersionSchema,
    id: nonEmptyId,
    name: z.string().min(1),
    description: z.string().optional(),
    enabled: z.boolean().optional().default(true),
    scope: scopeSchema,
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
  .superRefine((value, ctx) => {
    if (value.targets.length === 0 && value.scripts.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Patch configs must declare at least one entry in `targets` or `scripts`.',
      });
    }
  });

export async function resolveBuilderContext(inputPath?: string): Promise<BuilderContext> {
  const candidate = path.resolve(inputPath ?? process.cwd());
  const stats = await statIfExists(candidate);
  const ymbRoot = stats?.isDirectory() ? candidate : path.dirname(candidate);

  ensure(
    path.basename(ymbRoot).toLowerCase() === BUILDER_CONFIG.rootDirectoryName.toLowerCase(),
    'LayoutError',
    layoutContext(
      ymbRoot,
      `Expected the builder path to point to the \`${BUILDER_CONFIG.rootDirectoryName}\` directory.`,
      `Run the command from \`<ModRoot>/${BUILDER_CONFIG.rootDirectoryName}\` or pass that path explicitly.`,
    ),
  );

  const modRoot = path.dirname(ymbRoot);
  const gameDataRoot = path.join(modRoot, 'GameData');
  const commonDataRoot = path.join(modRoot, 'CommonData');
  const modsRoot = path.join(ymbRoot, BUILDER_CONFIG.modsDirectoryName);
  const buildRoot = path.join(ymbRoot, BUILDER_CONFIG.buildDirectoryName);
  const stateRoot = path.join(ymbRoot, BUILDER_CONFIG.stateDirectoryName);

  await assertDirectory(gameDataRoot, 'Expected `GameData` under the mod root.');
  await assertDirectory(commonDataRoot, 'Expected `CommonData` under the mod root.');
  await assertDirectory(
    ymbRoot,
    'Expected the provided builder directory to exist.',
    `Create the \`${BUILDER_CONFIG.rootDirectoryName}\` directory inside the WARNO mod root.`,
  );

  return { ymbRoot, modRoot, modsRoot, gameDataRoot, commonDataRoot, buildRoot, stateRoot };
}

export async function loadModConfig(filePath: string): Promise<ModConfig> {
  return parseConfigFile(filePath, 'source mod', modSchema);
}

export async function loadPatchConfig(filePath: string): Promise<PatchConfig> {
  return parseConfigFile(filePath, 'patch', patchSchema);
}

export function isScopeIncluded(requestedScope: Scope, patchScope: Scope): boolean {
  return requestedScope === 'dev' || patchScope === 'prod';
}

interface ListFilesOptions {
  skipDirectoryNames?: ReadonlySet<string>;
  skipFileNamesStartingWith?: string[];
  skipDirectoryNamesStartingWith?: string[];
  includeBaseNames?: ReadonlySet<string>;
}

export async function listFilesRecursive(
  directoryPath: string,
  options: ListFilesOptions = {},
): Promise<string[]> {
  const results: string[] = [];
  const pendingDirectories = [directoryPath];
  let pendingIndex = 0;

  while (pendingIndex < pendingDirectories.length) {
    const currentDirectoryPath = pendingDirectories[pendingIndex] as string;
    pendingIndex += 1;
    const entries = await readdir(currentDirectoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const absoluteEntryPath = path.join(currentDirectoryPath, entry.name);
      if (entry.isDirectory()) {
        if (
          options.skipDirectoryNamesStartingWith?.some((prefix) => entry.name.startsWith(prefix))
        ) {
          continue;
        }
        if (options.skipDirectoryNames?.has(entry.name)) {
          continue;
        }

        pendingDirectories.push(absoluteEntryPath);
        continue;
      }

      if (options.skipFileNamesStartingWith?.some((prefix) => entry.name.startsWith(prefix))) {
        continue;
      }
      if (options.includeBaseNames && !options.includeBaseNames.has(entry.name.toLowerCase())) {
        continue;
      }

      results.push(absoluteEntryPath);
    }
  }

  return results.sort((left, right) => left.localeCompare(right));
}

async function readYamlFile(filePath: string): Promise<unknown> {
  try {
    const file = Bun.file(filePath);
    const raw = await file.text();
    return YAML.parse(raw);
  } catch (error) {
    throw new YmbError('ConfigError', {
      absolutePath: filePath,
      reason: 'Could not read or parse this YAML file.',
      suggestion: 'Fix the YAML syntax and make sure the file is readable.',
      details: [error instanceof Error ? error.message : String(error)],
    });
  }
}

async function parseConfigFile<T>(
  filePath: string,
  configLabel: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const parsed = schema.safeParse(await readYamlFile(filePath));
  if (parsed.success) {
    return parsed.data;
  }

  throw new YmbError('ConfigError', {
    absolutePath: filePath,
    reason: `${configLabel} config fields are invalid.`,
    suggestion: 'Fix the listed fields so they match the documented YMB schema.',
    details: formatSchemaIssues(parsed.error),
  });
}

function formatSchemaIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const issuePath = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return `${issuePath}: ${issue.message}`;
  });
}

async function assertDirectory(
  directoryPath: string,
  reason: string,
  suggestion = `Place ${BUILDER_CONFIG.rootDirectoryName} directory inside the mod root, or pass the correct ${BUILDER_CONFIG.rootDirectoryName} path.`,
): Promise<void> {
  const stats = await statIfExists(directoryPath);
  ensure(stats?.isDirectory(), 'LayoutError', layoutContext(directoryPath, reason, suggestion));
}

function layoutContext(absolutePath: string, reason: string, suggestion: string) {
  return {
    absolutePath,
    reason,
    suggestion,
  };
}
