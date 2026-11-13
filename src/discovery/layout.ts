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
    reason: 'No mod projects found in this folder.',
    suggestion: `Run \`init --id first_mod --name "My First Mod"\` to create one. For an existing project, check \`<project>/config/${BUILDER_CONFIG.modConfigFileName}\` or change \`paths.sourceMods\` in \`${BUILDER_CONFIG.builderConfigFileName}\`.`,
  });

  return modLayouts;
}

async function resolveModLayout(modAbsolutePath: string): Promise<ModLayout | undefined> {
  const configDirectoryPath = path.join(modAbsolutePath, BUILDER_CONFIG.configDirectoryName);
  const configFilePath = path.join(configDirectoryPath, BUILDER_CONFIG.modConfigFileName);
  if (await isFile(configFilePath)) {
    await assertRealPathWithinRoot(configDirectoryPath, modAbsolutePath, 'mod project root');
    await assertRealPathWithinRoot(configFilePath, configDirectoryPath, 'mod project config root');
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
  await assertRealPathWithinRoot(directoryPath, ownerRoot, 'mod project config root');
  return directoryPath;
}

async function assertDirectory(directoryPath: string): Promise<void> {
  ensure(await isDirectory(directoryPath), 'LayoutError', {
    absolutePath: directoryPath,
    reason: 'The mod projects folder is missing.',
    suggestion: 'Run `init` to create a project, or check `paths.sourceMods` in ymb.config.yaml.',
  });
}
