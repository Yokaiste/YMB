import path from 'node:path';
import type { CooperativeYieldController } from '../async.ts';
import { hashText } from '../hash.ts';
import { isFile } from '../path-utils.ts';

interface ScriptDependencySource {
  absolutePath: string;
  relativePath: string;
  sourceHash: string;
}

const IMPORT_META_URL_PATTERN =
  /\bnew\s+URL\s*\(\s*["']([^"'`]+)["']\s*,\s*import\.meta\.url\s*\)/g;
const IMPORT_META_URL_TEMPLATE_PATTERN =
  /\bnew\s+URL\s*\(\s*`([^`$]+)`\s*,\s*import\.meta\.url\s*\)/g;
const IMPORT_META_URL_PATTERNS = [
  IMPORT_META_URL_PATTERN,
  IMPORT_META_URL_TEMPLATE_PATTERN,
] as const;
const SCRIPT_FILE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.js',
  '.jsx',
  '.mjs',
  '.cts',
  '.cjs',
] as const;
const scriptImportScanners = {
  ts: new Bun.Transpiler({ loader: 'ts' }),
  tsx: new Bun.Transpiler({ loader: 'tsx' }),
  js: new Bun.Transpiler({ loader: 'js' }),
  jsx: new Bun.Transpiler({ loader: 'jsx' }),
} as const;

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

    for (const specifier of collectRelativeSpecifiers(source, currentPath)) {
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

function collectRelativeSpecifiers(source: string, sourcePath: string): string[] {
  const specifiers = new Set<string>();
  // Bun's parser sees the same syntax the runtime executes. A regex over source
  // text missed valid imports carrying comments and treated import-looking
  // strings as dependencies, which could leave script-test cache entries stale.
  try {
    for (const imported of resolveScriptImportScanner(sourcePath).scanImports(source)) {
      if (isRelativeSpecifier(imported.path)) {
        specifiers.add(imported.path);
      }
    }
  } catch {
    // Invalid source is reported by the runtime import with script context. A
    // cache-key scan must not replace that useful error with a parser failure.
  }

  // `new URL('./worker.ts', import.meta.url)` is a filesystem dependency rather
  // than a module import, so the module scanner deliberately does not return it.
  for (const pattern of IMPORT_META_URL_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier && isRelativeSpecifier(specifier)) {
        specifiers.add(specifier);
      }
    }
  }
  return [...specifiers];
}

function resolveScriptImportScanner(sourcePath: string): Bun.Transpiler {
  switch (path.extname(sourcePath).toLowerCase()) {
    case '.tsx':
      return scriptImportScanners.tsx;
    case '.jsx':
      return scriptImportScanners.jsx;
    case '.js':
    case '.mjs':
    case '.cjs':
      return scriptImportScanners.js;
    default:
      return scriptImportScanners.ts;
  }
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

async function resolveLocalScriptDependency(
  importerAbsolutePath: string,
  specifier: string,
): Promise<string | undefined> {
  // Bun accepts a query or fragment on a local module URL, but those suffixes
  // are not part of the on-disk file name whose content belongs in the key.
  const fileSpecifier = specifier.replace(/[?#].*$/, '');
  const resolvedBasePath = path.resolve(path.dirname(importerAbsolutePath), fileSpecifier);
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
