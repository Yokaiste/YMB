import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { ensure } from '../errors.ts';

export interface ModLayout {
  modAbsolutePath: string;
  configAbsolutePath: string;
  modConfigPath: string;
  patchAbsolutePath?: string | undefined;
  replaceAbsolutePath?: string | undefined;
}

export async function collectModLayouts(modsRoot: string): Promise<ModLayout[]> {
  await assertDirectory(modsRoot);

  const modEntries = await readdir(modsRoot, { withFileTypes: true });
  const modLayouts: ModLayout[] = [];

  for (const entry of modEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) {
      continue;
    }

    const modLayout = await resolveModLayout(path.join(modsRoot, entry.name));
    if (modLayout) {
      modLayouts.push(modLayout);
    }
  }

  ensure(modLayouts.length > 0, 'LayoutError', {
    absolutePath: modsRoot,
    reason: `No source mod folders with \`${BUILDER_CONFIG.modConfigFileName}\` were found directly under \`${BUILDER_CONFIG.rootDirectoryName}/${BUILDER_CONFIG.modsDirectoryName}\`.`,
    suggestion: `Create a folder under \`${BUILDER_CONFIG.rootDirectoryName}/${BUILDER_CONFIG.modsDirectoryName}\` and place \`${BUILDER_CONFIG.modConfigFileName}\` in that folder or in its \`${BUILDER_CONFIG.configDirectoryName}\` subfolder.`,
  });

  return modLayouts;
}

async function resolveModLayout(modAbsolutePath: string): Promise<ModLayout | undefined> {
  const directConfigPath = path.join(modAbsolutePath, BUILDER_CONFIG.modConfigFileName);
  if (await isFile(directConfigPath)) {
    return {
      modAbsolutePath,
      configAbsolutePath: modAbsolutePath,
      modConfigPath: directConfigPath,
      patchAbsolutePath: await resolveOptionalDirectory(
        path.join(modAbsolutePath, BUILDER_CONFIG.patchDirectoryName),
      ),
      replaceAbsolutePath: await resolveOptionalDirectory(
        path.join(modAbsolutePath, BUILDER_CONFIG.replaceDirectoryName),
      ),
    };
  }

  const nestedConfigRoot = path.join(modAbsolutePath, BUILDER_CONFIG.configDirectoryName);
  const nestedConfigPath = path.join(nestedConfigRoot, BUILDER_CONFIG.modConfigFileName);
  if (await isFile(nestedConfigPath)) {
    return {
      modAbsolutePath,
      configAbsolutePath: nestedConfigRoot,
      modConfigPath: nestedConfigPath,
      patchAbsolutePath: await resolveOptionalDirectory(
        path.join(nestedConfigRoot, BUILDER_CONFIG.patchDirectoryName),
      ),
      replaceAbsolutePath: await resolveOptionalDirectory(
        path.join(nestedConfigRoot, BUILDER_CONFIG.replaceDirectoryName),
      ),
    };
  }

  return undefined;
}

async function resolveOptionalDirectory(directoryPath: string): Promise<string | undefined> {
  return (await isDirectory(directoryPath)) ? directoryPath : undefined;
}

async function assertDirectory(directoryPath: string): Promise<void> {
  ensure(await isDirectory(directoryPath), 'LayoutError', {
    absolutePath: directoryPath,
    reason: 'Required directory does not exist.',
    suggestion: 'Create the directory or point YMB at the correct builder root.',
  });
}

async function isDirectory(directoryPath: string): Promise<boolean> {
  try {
    return (await stat(directoryPath)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}
