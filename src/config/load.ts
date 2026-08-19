import YAML from 'yaml';
import type { z } from 'zod';
import {
  BUILDER_CONFIG,
  type BuilderProjectConfig,
  type BuilderProjectPaths,
  type BuilderProjectSettings,
  createDefaultBuilderProjectConfig,
} from '../builder-config.ts';
import { YmbError } from '../errors.ts';
import { statIfExists } from '../path-utils.ts';
import type { ModConfig, PatchConfig } from '../types.ts';
import { builderProjectSchema, modSchema, patchSchema } from './schemas.ts';

export async function loadBuilderProjectConfig(filePath: string): Promise<BuilderProjectConfig> {
  const configEntry = await statIfExists(filePath);
  if (!configEntry) {
    return createDefaultBuilderProjectConfig();
  }
  if (!configEntry.isFile()) {
    throw new YmbError('ConfigError', {
      absolutePath: filePath,
      reason: `Builder config path \`${BUILDER_CONFIG.builderConfigFileName}\` is not a regular file.`,
      suggestion: 'Replace it with a readable YAML configuration file.',
    });
  }

  const document = await readYamlDocument(filePath);
  assertNoDiscardedConfigKeys(filePath, document.value);
  const parsed = builderProjectSchema.safeParse(document.value);
  if (!parsed.success) {
    throw new YmbError('ConfigError', {
      absolutePath: filePath,
      reason: 'Builder config fields are invalid.',
      suggestion: `Fix the listed fields in \`${BUILDER_CONFIG.builderConfigFileName}\` so they match the documented YMB builder schema.`,
      details: formatSchemaIssues(parsed.error),
    });
  }

  const defaults = createDefaultBuilderProjectConfig();
  return {
    version: defaults.version,
    paths: mergeDefined(defaults.paths, parsed.data.paths ?? {}),
    settings: mergeDefined(defaults.settings, parsed.data.settings ?? {}),
  };
}

export async function loadModConfig(filePath: string): Promise<ModConfig> {
  return parseConfigFile(filePath, 'source mod', modSchema);
}

export async function loadPatchConfig(filePath: string): Promise<PatchConfig> {
  const document = await readYamlDocument(filePath);
  const config = parseConfig(filePath, 'patch', patchSchema, document.value);
  attachOperationLines(config, document);
  return config;
}

/**
 * So a failure points at the config the reader edits instead of an ordinal they
 * count out by hand. A `forEach` reports the line of the loop for every operation it
 * produces: the expanded ones were never written down, and the loop is what is edited.
 */
function attachOperationLines(config: PatchConfig, document: YamlDocument): void {
  for (const [targetIndex, target] of config.targets.entries()) {
    const lines = target.operations.map(
      (_, operationIndex) =>
        document.lineAt(['targets', targetIndex, 'operations', operationIndex]) ?? 0,
    );
    if (lines.some((line) => line > 0)) {
      target.operationLines = lines;
    }
  }

  const fileLines = config.files.map(
    (_, operationIndex) => document.lineAt(['files', operationIndex]) ?? 0,
  );
  if (fileLines.some((line) => line > 0)) {
    config.fileOperationLines = fileLines;
  }
}

async function parseConfigFile<T>(
  filePath: string,
  configLabel: string,
  schema: z.ZodType<T>,
): Promise<T> {
  return parseConfig(filePath, configLabel, schema, (await readYamlDocument(filePath)).value);
}

function parseConfig<T>(
  filePath: string,
  configLabel: string,
  schema: z.ZodType<T>,
  value: unknown,
): T {
  assertNoDiscardedConfigKeys(filePath, value);
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  throw new YmbError('ConfigError', {
    absolutePath: filePath,
    reason: `${configLabel} config fields are invalid.`,
    suggestion: 'Fix the listed fields so they match the documented YMB schema.',
    details: formatSchemaIssues(parsed.error),
  });
}

/** Zod deliberately omits this key, so accepting it would silently alter authored config. */
function assertNoDiscardedConfigKeys(filePath: string, value: unknown): void {
  const discardedPaths: string[] = [];
  const visited = new WeakSet<object>();

  const visit = (current: unknown, path: Array<string | number>): void => {
    if (!current || typeof current !== 'object' || visited.has(current)) {
      return;
    }
    visited.add(current);

    if (Array.isArray(current)) {
      for (const [index, item] of current.entries()) visit(item, [...path, index]);
      return;
    }

    for (const [key, nested] of Object.entries(current)) {
      const nextPath = [...path, key];
      if (key === '__proto__') discardedPaths.push(nextPath.join('.'));
      visit(nested, nextPath);
    }
  };

  visit(value, []);
  if (discardedPaths.length === 0) return;

  throw new YmbError('ConfigError', {
    absolutePath: filePath,
    reason: 'Config contains the reserved `__proto__` key, which cannot be preserved safely.',
    suggestion: 'Rename that key so configuration validation does not discard authored data.',
    details: discardedPaths.map((path) => `Reserved key: ${path}`),
  });
}

interface YamlDocument {
  value: unknown;
  /** 1-based line the node at this path starts on, or `undefined` if there is none. */
  lineAt: (path: Array<string | number>) => number | undefined;
}

async function readYamlDocument(filePath: string): Promise<YamlDocument> {
  try {
    const lineCounter = new YAML.LineCounter();
    const document = YAML.parseDocument(await Bun.file(filePath).text(), { lineCounter });
    // `parseDocument` collects syntax errors instead of throwing, unlike `parse`.
    // Raising the first one keeps broken YAML a syntax failure rather than
    // letting a half-parsed document reach the schema as a pile of field errors.
    const syntaxError = document.errors[0];
    if (syntaxError) {
      throw syntaxError;
    }
    return {
      value: document.toJS(),
      lineAt: (path) => {
        const node: unknown = document.getIn(path, true);
        const range = YAML.isNode(node) ? node.range : undefined;
        return range ? lineCounter.linePos(range[0]).line : undefined;
      },
    };
  } catch (error) {
    throw new YmbError('ConfigError', {
      absolutePath: filePath,
      reason: 'Could not read or parse this YAML file.',
      suggestion: 'Fix the YAML syntax and make sure the file is readable.',
      details: [error instanceof Error ? error.message : String(error)],
    });
  }
}

function formatSchemaIssues(error: z.ZodError): string[] {
  return error.issues.flatMap((issue) => {
    const issuePath = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    if (issue.code !== 'invalid_union') return [`${issuePath}: ${issue.message}`];
    const alternatives = issue.errors
      .map((issues) => issues[0])
      .filter((candidate) => candidate !== undefined)
      .map((candidate) => {
        const path = [...issue.path, ...candidate.path];
        return `${path.length > 0 ? path.join('.') : '<root>'}: ${candidate.message}`;
      });
    return [...new Set(alternatives)].slice(0, 8);
  });
}

function mergeDefined<T extends BuilderProjectPaths | BuilderProjectSettings>(
  defaults: T,
  overrides: Partial<Record<keyof T, T[keyof T] | undefined>>,
): T {
  const merged = { ...defaults };
  for (const [key, value] of Object.entries(overrides) as Array<
    [keyof T, T[keyof T] | undefined]
  >) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}
