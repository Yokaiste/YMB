import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { ensure } from '../errors.ts';
import { statIfExists } from '../path-utils.ts';
import type { BuilderContext, Scope } from '../types.ts';

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
  const context = {
    ymbRoot,
    modRoot,
    modsRoot: path.join(ymbRoot, BUILDER_CONFIG.modsDirectoryName),
    gameDataRoot: path.join(modRoot, 'GameData'),
    commonDataRoot: path.join(modRoot, 'CommonData'),
    buildRoot: path.join(ymbRoot, BUILDER_CONFIG.buildDirectoryName),
    stateRoot: path.join(ymbRoot, BUILDER_CONFIG.stateDirectoryName),
  };
  await assertDirectory(context.gameDataRoot, 'Expected `GameData` under the mod root.');
  await assertDirectory(context.commonDataRoot, 'Expected `CommonData` under the mod root.');
  await assertDirectory(
    context.ymbRoot,
    'Expected the provided builder directory to exist.',
    `Create the \`${BUILDER_CONFIG.rootDirectoryName}\` directory inside the WARNO mod root.`,
  );
  return context;
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
  for (let index = 0; index < pendingDirectories.length; index += 1) {
    const currentDirectoryPath = pendingDirectories[index];
    if (currentDirectoryPath === undefined) break;
    for (const entry of await readdir(currentDirectoryPath, { withFileTypes: true })) {
      const absoluteEntryPath = path.join(currentDirectoryPath, entry.name);
      if (entry.isDirectory()) {
        if (
          options.skipDirectoryNamesStartingWith?.some((prefix) => entry.name.startsWith(prefix)) ||
          options.skipDirectoryNames?.has(entry.name)
        ) {
          continue;
        }
        pendingDirectories.push(absoluteEntryPath);
        continue;
      }
      if (
        options.skipFileNamesStartingWith?.some((prefix) => entry.name.startsWith(prefix)) ||
        (options.includeBaseNames && !options.includeBaseNames.has(entry.name.toLowerCase()))
      ) {
        continue;
      }
      results.push(absoluteEntryPath);
    }
  }
  return results.sort((left, right) => left.localeCompare(right));
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
  return { absolutePath, reason, suggestion };
}
