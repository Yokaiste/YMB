import { afterEach, describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runBuild, runRecover, runSync } from '../src/engine/commands.ts';
import { loadManifest } from '../src/markers.ts';
import {
  cleanupTempRoots,
  createAbstractBuilderWorkspace,
  createSelection,
  writeModFixture,
  writeWorkspaceFiles,
} from './helpers/abstract-builder.ts';

const tempRoots: string[] = [];
const selection = createSelection({ modFilters: ['rewrite_pack'] });

afterEach(() => cleanupTempRoots(tempRoots));

describe('tracked script inputs', () => {
  for (const binary of [false, true]) {
    test(`scripts can reread the original of a synced deletion as ${binary ? 'bytes' : 'text'}`, async () => {
      const { builderPath, rootPath } = await createAbstractBuilderWorkspace(tempRoots);
      await writeWorkspaceFiles(rootPath, { 'CommonData/input.txt': 'original\n' });
      await writeModFixture(builderPath, 'rewrite-pack', {
        'config/ymb.mod.yaml':
          'version: 1\nid: rewrite_pack\nname: Rewrite\nscripts:\n  - path: generate.ts\n',
        'config/generate.ts': `export default async (context) => ({ targetRelativePath: 'CommonData/output.txt', content: await context.${binary ? 'readBinaryTarget' : 'readTarget'}('CommonData/input.txt') });`,
        'config/patch/remove/ymb.patch.yaml':
          'version: 1\nid: remove\nname: Remove\nscope: prod\nfiles:\n  - op: remove\n    target: CommonData/input.txt\n',
      });
      await runSync(builderPath, selection);
      expect(await Bun.file(path.join(rootPath, 'CommonData/input.txt')).exists()).toBe(false);
      await runSync(builderPath, selection);
      expect(await Bun.file(path.join(rootPath, 'CommonData/output.txt')).text()).toBe(
        'original\n',
      );
      await runRecover(builderPath, selection);
      expect(await Bun.file(path.join(rootPath, 'CommonData/input.txt')).text()).toBe('original\n');
    });
  }
  for (const binary of [false, true]) {
    test(`repeated ${binary ? 'binary' : 'markerless text'} transformations read the original`, async () => {
      const { builderPath, rootPath } = await createAbstractBuilderWorkspace(tempRoots);
      const target = binary ? 'CommonData/count.bin' : 'CommonData/count.csv';
      const original = binary ? new Uint8Array([1, 0, 255]) : '1\n';
      const expected = binary ? new Uint8Array([2, 0, 255]) : new TextEncoder().encode('2\n');
      await writeWorkspaceFiles(rootPath, { [target]: original });
      await writeModFixture(builderPath, 'rewrite-pack', {
        'config/ymb.mod.yaml':
          'version: 1\nid: rewrite_pack\nname: Rewrite\nscripts:\n  - path: generate.ts\n',
        'config/generate.ts': `export default async (context) => {
          const targetRelativePath = ${JSON.stringify(target)};
          const input = await context.${binary ? 'readBinaryTarget' : 'readTarget'}(targetRelativePath);
          ${binary ? 'input[0] += 1;' : ''}
          return { targetRelativePath, content: ${binary ? 'input' : '`${Number(input) + 1}\\n`'} };
        };`,
      });

      await runSync(builderPath, selection);
      await runSync(builderPath, selection);
      expect(await Bun.file(path.join(rootPath, target)).bytes()).toEqual(expected);
      await runBuild(builderPath, selection);
      expect(await Bun.file(path.join(builderPath, '.ymb-build/output', target)).bytes()).toEqual(
        expected,
      );
      await runRecover(builderPath, selection);
      expect(await Bun.file(path.join(rootPath, target)).bytes()).toEqual(
        typeof original === 'string' ? new TextEncoder().encode(original) : original,
      );
    });
  }

  test('a build rejects a corrupted original even when its live output is intact', async () => {
    const { builderPath, rootPath } = await createAbstractBuilderWorkspace(tempRoots);
    const target = 'GameData/Counter.ndf';
    await writeWorkspaceFiles(rootPath, { [target]: 'Counter is Thing(\n    Value = 1\n)\n' });
    await writeModFixture(builderPath, 'rewrite-pack', {
      'config/ymb.mod.yaml': 'version: 1\nid: rewrite_pack\nname: Rewrite\n',
      'config/patch/counter/ymb.patch.yaml': `version: 1
id: counter
name: Counter
scope: prod
targets:
  - file: ${target}
    operations:
      - op: modify
        selector: { kind: field, by: path, value: Counter.Value }
        value: 2
`,
    });
    await runSync(builderPath, selection);
    const stateRoot = path.join(builderPath, '.ymb-state');
    const [entry] = (await loadManifest(stateRoot)).entries;
    assert.ok(entry);
    await Bun.write(
      path.join(stateRoot, 'originals', entry.backupFileName),
      'Counter is Thing(\n    Value = 9\n)\n',
    );

    await expect(runBuild(builderPath, selection)).rejects.toThrow('corrupted');
  });
});

describe('unchanged output ownership', () => {
  for (const binary of [false, true]) {
    test(`refreshes ${binary ? 'binary' : 'marked text'} contributors when only the owner changes`, async () => {
      const { builderPath, rootPath } = await createAbstractBuilderWorkspace(tempRoots);
      const target = binary ? 'CommonData/owned.bin' : 'GameData/Owned.ndf';
      const original = binary ? new Uint8Array([1]) : 'Owned is Thing(Value = 2)\n';
      await writeWorkspaceFiles(rootPath, { [target]: original });
      await writeModFixture(builderPath, 'rewrite-pack', {
        'config/ymb.mod.yaml': 'version: 1\nid: rewrite_pack\nname: Rewrite\n',
        'config/patch/owner/ymb.patch.yaml':
          'version: 1\nid: first\nname: Owner\nscope: prod\nscripts:\n  - path: generate.ts\n',
        'config/patch/owner/generate.ts': `export default () => ({
          targetRelativePath: ${JSON.stringify(target)},
          content: ${binary ? 'new Uint8Array([2])' : JSON.stringify('Owned is Thing(Value = 2)\n')},
        });`,
      });
      await runSync(builderPath, selection);
      await Bun.write(
        path.join(builderPath, 'mods/rewrite-pack/config/patch/owner/ymb.patch.yaml'),
        'version: 1\nid: second\nname: Owner\nscope: prod\nscripts:\n  - path: generate.ts\n',
      );
      await runSync(builderPath, selection);
      const manifest = await loadManifest(path.join(builderPath, '.ymb-state'));
      expect(manifest.entries[0]?.contributors).toEqual([
        { modId: 'rewrite_pack', modName: 'Rewrite', patchId: 'second' },
      ]);
      await runRecover(builderPath, createSelection({ ...selection, patchFilters: ['second'] }));
      expect(await Bun.file(path.join(rootPath, target)).bytes()).toEqual(
        typeof original === 'string' ? new TextEncoder().encode(original) : original,
      );
    });
  }
});
