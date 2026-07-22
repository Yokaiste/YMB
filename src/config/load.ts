import YAML from 'yaml';
import type { z } from 'zod';
import { YmbError } from '../errors.ts';
import type { ModConfig, PatchConfig } from '../types.ts';
import { modSchema, patchSchema } from './schemas.ts';

export async function loadModConfig(filePath: string): Promise<ModConfig> {
  return parseConfigFile(filePath, 'source mod', modSchema);
}

export async function loadPatchConfig(filePath: string): Promise<PatchConfig> {
  return parseConfigFile(filePath, 'patch', patchSchema);
}

async function parseConfigFile<T>(
  filePath: string,
  configLabel: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const parsed = schema.safeParse(await readYamlFile(filePath));
  if (parsed.success) return parsed.data;

  throw new YmbError('ConfigError', {
    absolutePath: filePath,
    reason: `${configLabel} config fields are invalid.`,
    suggestion: 'Fix the listed fields so they match the documented YMB schema.',
    details: formatSchemaIssues(parsed.error),
  });
}

async function readYamlFile(filePath: string): Promise<unknown> {
  try {
    return YAML.parse(await Bun.file(filePath).text());
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
