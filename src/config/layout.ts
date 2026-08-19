import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { ensure } from '../errors.ts';
import {
  isDirectory,
  isFile,
  isPathInsideOrEqual,
  resolveRealPath,
  statIfExists,
} from '../path-utils.ts';
import type { BuilderContext, Scope } from '../types.ts';
import { loadBuilderProjectConfig } from './load.ts';

export async function resolveBuilderContext(inputPath?: string): Promise<BuilderContext> {
  const candidate = path.resolve(inputPath ?? process.cwd());
  const ymbRoot = await resolveBuilderRoot(candidate);
  const builderConfigPath = path.join(ymbRoot, BUILDER_CONFIG.builderConfigFileName);
  const builderConfig = await loadBuilderProjectConfig(builderConfigPath);
  const modRoot = resolveConfiguredRoot({
    ownerRoot: ymbRoot,
    configPath: builderConfigPath,
    settingKey: 'paths.gameRoot',
    configuredPath: builderConfig.paths.gameRoot,
  });
  const modsRoot = resolveConfiguredRoot({
    ownerRoot: ymbRoot,
    configPath: builderConfigPath,
    settingKey: 'paths.sourceMods',
    configuredPath: builderConfig.paths.sourceMods,
  });
  const buildRoot = resolveConfiguredRoot({
    ownerRoot: ymbRoot,
    configPath: builderConfigPath,
    settingKey: 'paths.workRoot',
    configuredPath: builderConfig.paths.workRoot,
  });
  const stateRoot = resolveConfiguredRoot({
    ownerRoot: ymbRoot,
    configPath: builderConfigPath,
    settingKey: 'paths.recoveryRoot',
    configuredPath: builderConfig.paths.recoveryRoot,
  });
  const operationLockRoot = resolveConfiguredRoot({
    ownerRoot: ymbRoot,
    configPath: builderConfigPath,
    settingKey: 'paths.operationLockRoot',
    configuredPath: builderConfig.paths.operationLockRoot,
  });
  const stateTransactionRoot = resolveConfiguredRoot({
    ownerRoot: ymbRoot,
    configPath: builderConfigPath,
    settingKey: 'paths.stateTransactionRoot',
    configuredPath: builderConfig.paths.stateTransactionRoot,
  });
  const context = {
    ymbRoot,
    builderConfigPath,
    builderConfig,
    modRoot,
    modsRoot,
    gameDataRoot: path.join(modRoot, 'GameData'),
    commonDataRoot: path.join(modRoot, 'CommonData'),
    buildRoot,
    buildOutputRoot: path.join(buildRoot, BUILDER_CONFIG.buildOutputDirectoryName),
    buildCacheRoot: path.join(buildRoot, BUILDER_CONFIG.cacheDirectoryName),
    conflictPreviewRoot: path.join(buildRoot, BUILDER_CONFIG.conflictDirectoryName),
    stateRoot,
    operationLockRoot,
    stateTransactionRoot,
  };
  await assertConfiguredRoots(context);
  await assertDirectory(
    context.ymbRoot,
    'Expected the provided builder directory to exist.',
    `Pass the builder root path directly, or create \`${BUILDER_CONFIG.builderConfigFileName}\` there so YMB can discover it.`,
  );
  await assertDirectory(
    context.gameDataRoot,
    'Expected `GameData` under the configured `paths.gameRoot`.',
    `Set \`paths.gameRoot\` in \`${BUILDER_CONFIG.builderConfigFileName}\` to the directory that contains both \`GameData\` and \`CommonData\`.`,
  );
  await assertDirectory(
    context.commonDataRoot,
    'Expected `CommonData` under the configured `paths.gameRoot`.',
    `Set \`paths.gameRoot\` in \`${BUILDER_CONFIG.builderConfigFileName}\` to the directory that contains both \`GameData\` and \`CommonData\`.`,
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
  rejectNonRegularEntries?: { ownerLabel: string } | undefined;
}

type NamedRoot = readonly [label: string, absolutePath: string];

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
      if (!entry.isFile()) {
        ensure(!options.rejectNonRegularEntries, 'LayoutError', {
          absolutePath: absoluteEntryPath,
          reason: `${options.rejectNonRegularEntries?.ownerLabel ?? 'Scanned directory'} contains a symbolic link or special filesystem entry.`,
          suggestion:
            'Replace it with a regular file or directory physically contained by the source root.',
        });
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
  suggestion: string,
): Promise<void> {
  ensure(await isDirectory(directoryPath), 'LayoutError', {
    absolutePath: directoryPath,
    reason,
    suggestion,
  });
}

function resolveConfiguredRoot(args: {
  ownerRoot: string;
  configPath: string;
  settingKey: string;
  configuredPath: string;
}): string {
  ensure(args.configuredPath.trim().length > 0, 'ConfigError', {
    absolutePath: args.configPath,
    reason: `Builder config setting \`${args.settingKey}\` cannot be empty.`,
    suggestion: 'Set it to a non-empty relative path or absolute path.',
  });

  return path.resolve(args.ownerRoot, args.configuredPath);
}

async function assertConfiguredRoots(context: BuilderContext): Promise<void> {
  const configuredRoots: NamedRoot[] = [
    ['paths.sourceMods', context.modsRoot],
    ['paths.workRoot', context.buildRoot],
    ['paths.recoveryRoot', context.stateRoot],
    ['paths.operationLockRoot', context.operationLockRoot],
    ['paths.stateTransactionRoot', context.stateTransactionRoot],
  ];
  const liveRoots: NamedRoot[] = [
    ['GameData', context.gameDataRoot],
    ['CommonData', context.commonDataRoot],
  ];
  const physicalRoots = await resolvePhysicalRoots(configuredRoots);
  const physicalYmbRoot = await resolveRealPath(context.ymbRoot);
  const physicalLiveRoots = await resolvePhysicalRoots(liveRoots);

  for (const [label, rootPath] of configuredRoots) {
    const physicalRoot = physicalRoots.get(label) ?? rootPath;
    assertNotFilesystemRoot(context, label, physicalRoot);
    ensure(!isSameOrAncestor(physicalRoot, physicalYmbRoot), 'ConfigError', {
      absolutePath: context.builderConfigPath,
      reason: `Builder config setting \`${label}\` cannot contain the builder root.`,
      suggestion:
        'Choose a child directory of the builder root or a separate sibling directory, not a parent directory that would also include the builder files.',
      details: [`${label}: ${rootPath}`, `builder root: ${context.ymbRoot}`],
    });
    assertDoesNotOverlapLiveData(
      context,
      label,
      rootPath,
      physicalRoot,
      liveRoots,
      physicalLiveRoots,
    );
  }

  for (const [leftIndex, [leftLabel, leftPath]] of configuredRoots.entries()) {
    for (const [rightLabel, rightPath] of configuredRoots.slice(leftIndex + 1)) {
      ensure(
        !pathsOverlap(
          physicalRoots.get(leftLabel) ?? leftPath,
          physicalRoots.get(rightLabel) ?? rightPath,
        ),
        'ConfigError',
        {
          absolutePath: context.builderConfigPath,
          reason: `Builder config settings \`${leftLabel}\` and \`${rightLabel}\` cannot overlap.`,
          suggestion:
            'Give each builder root its own separate folder so source mods, work data, recovery data, and locks stay isolated.',
          details: [`${leftLabel}: ${leftPath}`, `${rightLabel}: ${rightPath}`],
        },
      );
    }
  }
}

function assertDoesNotOverlapLiveData(
  context: BuilderContext,
  label: string,
  rootPath: string,
  physicalRoot: string,
  liveRoots: NamedRoot[],
  physicalLiveRoots: Map<string, string>,
): void {
  for (const [liveLabel, livePath] of liveRoots) {
    ensure(
      !pathsOverlap(physicalRoot, physicalLiveRoots.get(liveLabel) ?? livePath),
      'ConfigError',
      {
        absolutePath: context.builderConfigPath,
        reason: `Builder config setting \`${label}\` cannot overlap live WARNO data in \`${liveLabel}\`.`,
        suggestion:
          'Choose a separate source/work/recovery folder, or change `paths.gameRoot` so live files and builder files stay isolated.',
        details: [
          `${label}: ${rootPath}`,
          `paths.gameRoot: ${context.modRoot}`,
          `${liveLabel}: ${livePath}`,
        ],
      },
    );
  }
}

async function resolvePhysicalRoots(roots: NamedRoot[]): Promise<Map<string, string>> {
  return new Map(
    await Promise.all(
      roots.map(async ([label, rootPath]) => [label, await resolveRealPath(rootPath)] as const),
    ),
  );
}

function isSameOrAncestor(rootPath: string, candidatePath: string): boolean {
  return isPathInsideOrEqual(rootPath, candidatePath);
}

async function resolveBuilderRoot(candidatePath: string): Promise<string> {
  const stats = await statIfExists(candidatePath);
  const startDirectory = stats?.isDirectory() ? candidatePath : path.dirname(candidatePath);
  const configuredRoot = await findAncestorDirectory(startDirectory, hasBuilderConfigFile);
  if (configuredRoot) {
    return configuredRoot;
  }

  const defaultRoot = await findAncestorDirectory(startDirectory, isDefaultBuilderRoot);
  if (defaultRoot) {
    return defaultRoot;
  }

  return startDirectory;
}

async function findAncestorDirectory(
  startDirectory: string,
  matcher: (directoryPath: string) => Promise<boolean>,
): Promise<string | undefined> {
  let currentDirectory = startDirectory;
  while (true) {
    if (await matcher(currentDirectory)) {
      return currentDirectory;
    }
    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }
    currentDirectory = parentDirectory;
  }
}

async function hasBuilderConfigFile(directoryPath: string): Promise<boolean> {
  return isFile(path.join(directoryPath, BUILDER_CONFIG.builderConfigFileName));
}

async function isDefaultBuilderRoot(directoryPath: string): Promise<boolean> {
  const parentDirectory = path.dirname(directoryPath);
  if (parentDirectory === directoryPath) {
    return false;
  }

  const [hasModsDirectory, hasGameData, hasCommonData] = await Promise.all([
    isDirectory(path.join(directoryPath, BUILDER_CONFIG.modsDirectoryName)),
    isDirectory(path.join(parentDirectory, 'GameData')),
    isDirectory(path.join(parentDirectory, 'CommonData')),
  ]);
  return hasModsDirectory && hasGameData && hasCommonData;
}

function pathsOverlap(leftPath: string, rightPath: string): boolean {
  return isPathInsideOrEqual(leftPath, rightPath) || isPathInsideOrEqual(rightPath, leftPath);
}

function assertNotFilesystemRoot(context: BuilderContext, label: string, rootPath: string): void {
  ensure(path.resolve(rootPath) !== path.parse(path.resolve(rootPath)).root, 'ConfigError', {
    absolutePath: context.builderConfigPath,
    reason: `Builder config setting \`${label}\` cannot point at a filesystem root.`,
    suggestion:
      'Choose a dedicated project directory instead of a drive root or share root so discovery, cleanup, and writes stay scoped.',
    details: [`${label}: ${rootPath}`],
  });
}
