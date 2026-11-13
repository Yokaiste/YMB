import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { ensure } from '../errors.ts';
import {
  isDirectory,
  isPathInsideOrEqual,
  pathExists,
  pathsOverlap,
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
    'The YMB folder does not exist.',
    `Run from the extracted YMB folder, or pass its path with \`--ymb-path\`.`,
  );
  await assertDirectory(
    context.gameDataRoot,
    '`GameData` is missing from the WARNO mod folder.',
    `Create a WARNO mod with the game tools first. Set \`paths.gameRoot\` in \`${BUILDER_CONFIG.builderConfigFileName}\` to its folder containing \`GameData\` and \`CommonData\`.`,
  );
  await assertDirectory(
    context.commonDataRoot,
    '`CommonData` is missing from the WARNO mod folder.',
    `Create a WARNO mod with the game tools first. Set \`paths.gameRoot\` in \`${BUILDER_CONFIG.builderConfigFileName}\` to its folder containing \`GameData\` and \`CommonData\`.`,
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
            'Copy the actual file or folder into the project; links to another location are not supported here.',
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
    reason: `\`${args.settingKey}\` is empty.`,
    suggestion: 'Set a folder path. Relative paths start at the YMB folder.',
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
    ensure(!isPathInsideOrEqual(physicalRoot, physicalYmbRoot), 'ConfigError', {
      absolutePath: context.builderConfigPath,
      reason: `\`${label}\` includes the YMB folder itself.`,
      suggestion:
        'Choose a separate folder or a subfolder of YMB so cleanup cannot include the tool itself.',
      details: [`${label}: ${rootPath}`, `YMB folder: ${context.ymbRoot}`],
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
          reason: `\`${leftLabel}\` and \`${rightLabel}\` share a folder or contain one another.`,
          suggestion:
            'Give each path its own folder. Project files, temporary output, and saved originals must stay separate.',
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
        reason: `\`${label}\` overlaps the WARNO mod files in \`${liveLabel}\`.`,
        suggestion: 'Choose a folder outside GameData and CommonData, or correct `paths.gameRoot`.',
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

async function resolveBuilderRoot(candidatePath: string): Promise<string> {
  const stats = await statIfExists(candidatePath);
  const startDirectory = stats?.isDirectory() ? candidatePath : path.dirname(candidatePath);
  return (
    (await findAncestorDirectory(
      startDirectory,
      async (directoryPath) =>
        (await pathExists(path.join(directoryPath, BUILDER_CONFIG.builderConfigFileName))) ||
        (await isDefaultBuilderRoot(directoryPath)),
    )) ?? startDirectory
  );
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

function assertNotFilesystemRoot(context: BuilderContext, label: string, rootPath: string): void {
  ensure(path.resolve(rootPath) !== path.parse(path.resolve(rootPath)).root, 'ConfigError', {
    absolutePath: context.builderConfigPath,
    reason: `\`${label}\` points at an entire drive or network share.`,
    suggestion:
      'Choose a dedicated subfolder so YMB only scans and cleans files that belong to this setup.',
    details: [`${label}: ${rootPath}`],
  });
}
