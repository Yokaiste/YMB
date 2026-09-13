import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { ensure } from '../errors.ts';
import { assertRealPathWithinRoot, isDirectory, isFile } from '../path-utils.ts';

interface ModLayout {
  modAbsolutePath: string;
  configDirectoryPath: string;
  configFilePath: string;
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
    reason: `No source mod folders with \`${BUILDER_CONFIG.modConfigFileName}\` were found directly under \`${modsRoot}\`.`,
    suggestion: `Create \`${path.join(modsRoot, '<mod>', BUILDER_CONFIG.configDirectoryName, BUILDER_CONFIG.modConfigFileName)}\`, or update \`paths.sourceMods\` in \`${BUILDER_CONFIG.builderConfigFileName}\`.`,
  });

  return modLayouts;
}

async function resolveModLayout(modAbsolutePath: string): Promise<ModLayout | undefined> {
  const configDirectoryPath = path.join(modAbsolutePath, BUILDER_CONFIG.configDirectoryName);
  const configFilePath = path.join(configDirectoryPath, BUILDER_CONFIG.modConfigFileName);
  if (await isFile(configFilePath)) {
    await assertRealPathWithinRoot(configDirectoryPath, modAbsolutePath, 'source mod root');
    await assertRealPathWithinRoot(configFilePath, configDirectoryPath, 'source mod config root');
    return {
      modAbsolutePath,
      configDirectoryPath,
      configFilePath,
      patchAbsolutePath: await resolveOptionalDirectory(
        path.join(configDirectoryPath, BUILDER_CONFIG.patchDirectoryName),
        configDirectoryPath,
      ),
      replaceAbsolutePath: await resolveOptionalDirectory(
        path.join(configDirectoryPath, BUILDER_CONFIG.replaceDirectoryName),
        configDirectoryPath,
      ),
    };
  }

  return undefined;
}

async function resolveOptionalDirectory(
  directoryPath: string,
  ownerRoot: string,
): Promise<string | undefined> {
  if (!(await isDirectory(directoryPath))) return undefined;
  await assertRealPathWithinRoot(directoryPath, ownerRoot, 'source mod config root');
  return directoryPath;
}

async function assertDirectory(directoryPath: string): Promise<void> {
  ensure(await isDirectory(directoryPath), 'LayoutError', {
    absolutePath: directoryPath,
    reason: 'Required directory does not exist.',
    suggestion: 'Create the directory or point YMB at the correct builder root.',
  });
}
