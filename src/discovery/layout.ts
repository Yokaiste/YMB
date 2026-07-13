import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { ensure } from '../errors.ts';
import { statIfExists } from '../path-utils.ts';

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
    suggestion: `Create \`${BUILDER_CONFIG.rootDirectoryName}/${BUILDER_CONFIG.modsDirectoryName}/<mod>/${BUILDER_CONFIG.configDirectoryName}/${BUILDER_CONFIG.modConfigFileName}\`.`,
  });

  return modLayouts;
}

async function resolveModLayout(modAbsolutePath: string): Promise<ModLayout | undefined> {
  const configAbsolutePath = path.join(modAbsolutePath, BUILDER_CONFIG.configDirectoryName);
  const modConfigPath = path.join(configAbsolutePath, BUILDER_CONFIG.modConfigFileName);
  if (await isFile(modConfigPath)) {
    return {
      modAbsolutePath,
      configAbsolutePath,
      modConfigPath,
      patchAbsolutePath: await resolveOptionalDirectory(
        path.join(configAbsolutePath, BUILDER_CONFIG.patchDirectoryName),
      ),
      replaceAbsolutePath: await resolveOptionalDirectory(
        path.join(configAbsolutePath, BUILDER_CONFIG.replaceDirectoryName),
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
  return (await statIfExists(directoryPath))?.isDirectory() ?? false;
}

async function isFile(filePath: string): Promise<boolean> {
  return (await statIfExists(filePath))?.isFile() ?? false;
}
