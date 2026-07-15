import path from 'node:path';
import type { CooperativeYieldController } from '../async.ts';
import { hashText } from '../hash.ts';
import { statIfExists } from '../path-utils.ts';

interface ScriptDependencySource {
  absolutePath: string;
  relativePath: string;
  sourceHash: string;
}

const LOCAL_IMPORT_PATTERN =
  /\bimport\s+(?:type\s+)?(?:[\s\w{},*$]*?\s+from\s+)?["']([^"'`]+)["']/g;
const LOCAL_EXPORT_PATTERN = /\bexport\s+(?:type\s+)?[\s\w{},*$]*?\s+from\s+["']([^"'`]+)["']/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*["']([^"'`]+)["']\s*\)/g;
const IMPORT_META_URL_PATTERN =
  /\bnew\s+URL\s*\(\s*["']([^"'`]+)["']\s*,\s*import\.meta\.url\s*\)/g;
const IMPORT_SPECIFIER_PATTERNS = [
  LOCAL_IMPORT_PATTERN,
  LOCAL_EXPORT_PATTERN,
  DYNAMIC_IMPORT_PATTERN,
  IMPORT_META_URL_PATTERN,
] as const;
const SCRIPT_FILE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cts', '.cjs'] as const;

export async function collectScriptDependencySources(args: {
  entryAbsolutePaths: string[];
  rootAbsolutePath: string;
  yieldController?: CooperativeYieldController;
}): Promise<ScriptDependencySource[]> {
  const { entryAbsolutePaths, rootAbsolutePath, yieldController } = args;
  const discovered = new Map<string, ScriptDependencySource>();
  const pending = [...new Set(entryAbsolutePaths.map((filePath) => path.resolve(filePath)))];

  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (!currentPath || discovered.has(currentPath) || !(await isFile(currentPath))) {
      continue;
    }

    await yieldController?.maybeYield();
    const source = await Bun.file(currentPath).text();
    discovered.set(currentPath, {
      absolutePath: currentPath,
      relativePath: path.relative(rootAbsolutePath, currentPath),
      sourceHash: hashText(source),
    });

    for (const specifier of collectRelativeSpecifiers(source)) {
      const resolvedDependency = await resolveLocalScriptDependency(currentPath, specifier);
      if (resolvedDependency && !discovered.has(resolvedDependency)) {
        pending.push(resolvedDependency);
      }
    }
  }

  return [...discovered.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

function collectRelativeSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const pattern of IMPORT_SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier && isRelativeSpecifier(specifier)) {
        specifiers.add(specifier);
      }
    }
  }
  return [...specifiers];
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

async function resolveLocalScriptDependency(
  importerAbsolutePath: string,
  specifier: string,
): Promise<string | undefined> {
  const resolvedBasePath = path.resolve(path.dirname(importerAbsolutePath), specifier);
  for (const candidatePath of buildDependencyCandidates(resolvedBasePath)) {
    if (await isFile(candidatePath)) {
      return candidatePath;
    }
  }
  return undefined;
}

function buildDependencyCandidates(resolvedBasePath: string): string[] {
  const parsedPath = path.parse(resolvedBasePath);
  if (parsedPath.ext) {
    return [resolvedBasePath];
  }

  return [
    ...SCRIPT_FILE_EXTENSIONS.map((extension) => `${resolvedBasePath}${extension}`),
    ...SCRIPT_FILE_EXTENSIONS.map((extension) => path.join(resolvedBasePath, `index${extension}`)),
  ];
}

async function isFile(candidatePath: string): Promise<boolean> {
  return (await statIfExists(candidatePath))?.isFile() ?? false;
}
