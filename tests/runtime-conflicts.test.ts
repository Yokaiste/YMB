import { afterEach, expect, test } from 'bun:test';
import path from 'node:path';
import { runBuild, runSync } from '../src/engine/commands.ts';
import {
  cleanupTempRoots,
  createAbstractBuilderWorkspace,
  createSelection,
  writeModFixture,
  writeWorkspaceFiles,
} from './helpers/abstract-builder.ts';

const tempRoots: string[] = [];
afterEach(() => cleanupTempRoots(tempRoots));

async function writeGenerator(builderPath: string, id: string, target: string) {
  await writeModFixture(builderPath, id, {
    'config/ymb.mod.yaml': `version: 1\nid: ${id}\nname: ${id}\nscripts:\n  - path: generate.ts\n`,
    'config/generate.ts': `export default () => ({ targetRelativePath: ${JSON.stringify(target)}, content: 'Generated is Thing(Value = 2)\\n' });`,
  });
}

test('unlayered scripts in different mods cannot silently overwrite each other', async () => {
  const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);
  await writeGenerator(builderPath, 'first', 'CommonData/shared.ndf');
  await writeGenerator(builderPath, 'second', 'CommonData/SHARED.ndf');
  await expect(
    runBuild(builderPath, createSelection({ modFilters: ['first', 'second'] })),
  ).rejects.toMatchObject({
    category: 'ConflictError',
    context: { absolutePath: 'CommonData/SHARED.ndf' },
  });
  await expect(
    runBuild(builderPath, createSelection({ modFilters: ['first'] })),
  ).resolves.toBeDefined();
});

test('script output cannot also be selected for deletion', async () => {
  const { builderPath, rootPath } = await createAbstractBuilderWorkspace(tempRoots);
  const target = 'CommonData/shared.ndf';
  const original = 'Original is Thing(Value = 1)\n';
  await writeWorkspaceFiles(rootPath, { [target]: original });
  await writeGenerator(builderPath, 'first', target);
  await writeModFixture(builderPath, 'first', {
    'config/patch/remove/ymb.patch.yaml': `version: 1\nid: remove\nname: Remove\nscope: prod\nfiles:\n  - op: remove\n    target: ${target}\n`,
  });
  await expect(
    runSync(builderPath, createSelection({ modFilters: ['first'] })),
  ).rejects.toMatchObject({ category: 'ConflictError', context: { absolutePath: target } });
  expect(await Bun.file(path.join(rootPath, target)).text()).toBe(original);
});

test('script outputs cannot be both a file and its parent directory', async () => {
  const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);
  await writeGenerator(builderPath, 'first', 'CommonData/parent');
  await writeGenerator(builderPath, 'second', 'CommonData/parent/child.ndf');
  await expect(
    runBuild(builderPath, createSelection({ modFilters: ['first', 'second'] })),
  ).rejects.toMatchObject({
    category: 'ConflictError',
    context: { absolutePath: 'CommonData/parent/child.ndf' },
  });
});
