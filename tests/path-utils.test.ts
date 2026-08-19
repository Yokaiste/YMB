import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashBytes, hashFile } from '../src/hash.ts';
import {
  assertRealPathWithinRoot,
  copyFileAtomic,
  createTemporarySiblingPath,
  isPathInside,
  isPathInsideOrEqual,
} from '../src/path-utils.ts';

async function createTempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'ymb-path-utils-'));
}

describe('assertRealPathWithinRoot', () => {
  test('accepts existing and not-yet-created paths inside the root', async () => {
    const tempRoot = await createTempRoot();
    try {
      const insideDir = path.join(tempRoot, 'GameData', 'nested');
      await mkdir(insideDir, { recursive: true });
      await Bun.write(path.join(insideDir, 'existing.ndf'), 'Data is 1');

      await assertRealPathWithinRoot(path.join(insideDir, 'existing.ndf'), tempRoot, 'mod root');
      await assertRealPathWithinRoot(
        path.join(tempRoot, 'GameData', 'missing', 'new.ndf'),
        tempRoot,
        'mod root',
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('accepts a target when the owner is the filesystem root', async () => {
    const tempRoot = await createTempRoot();
    try {
      await assertRealPathWithinRoot(tempRoot, path.parse(tempRoot).root, 'filesystem root');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects a directory link that points outside the root', async () => {
    const tempRoot = await createTempRoot();
    const outsideRoot = await createTempRoot();
    try {
      await mkdir(path.join(tempRoot, 'GameData'), { recursive: true });
      const linkPath = path.join(tempRoot, 'GameData', 'escape');
      await symlink(outsideRoot, linkPath, 'junction');

      const attempt = assertRealPathWithinRoot(
        path.join(linkPath, 'payload.ndf'),
        tempRoot,
        'mod root',
      );
      await expect(attempt).rejects.toThrow('resolves outside its mod root');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test('rejects paths that already sit outside the root', async () => {
    const tempRoot = await createTempRoot();
    const outsideRoot = await createTempRoot();
    try {
      const attempt = assertRealPathWithinRoot(
        path.join(outsideRoot, 'file.ndf'),
        tempRoot,
        'mod root',
      );
      await expect(attempt).rejects.toThrow('resolves outside its mod root');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

describe('path containment', () => {
  const root = path.resolve('workspace');

  test('accepts child names beginning with two dots without accepting traversal', () => {
    expect(isPathInside(root, path.join(root, '..cache'))).toBe(true);
    expect(isPathInside(root, path.join(root, '..cache', 'entry.bin'))).toBe(true);
    expect(isPathInside(root, path.join(root, '..', 'outside'))).toBe(false);
    expect(isPathInsideOrEqual(root, root)).toBe(true);
    expect(isPathInside(root, root)).toBe(false);
  });
});

describe('atomic temporary paths', () => {
  test('stay short even when the destination filename is long', () => {
    const destination = path.join('C:\\deep', 'a'.repeat(180), `${'b'.repeat(64)}.json`);
    const temporaryPath = createTemporarySiblingPath(destination);

    expect(path.dirname(temporaryPath)).toBe(path.dirname(destination));
    expect(path.basename(temporaryPath)).toMatch(/^\.ymb-\d+-[0-9a-f-]+\.tmp$/);
    expect(temporaryPath.length).toBeLessThan(destination.length);
  });

  test('atomic copies preserve binary bytes and leave no temporary sibling', async () => {
    const tempRoot = await createTempRoot();
    try {
      const sourcePath = path.join(tempRoot, 'source.bin');
      const destinationPath = path.join(tempRoot, 'destination.bin');
      const content = new Uint8Array(128 * 1024 + 3);
      for (let index = 0; index < content.length; index += 1) content[index] = index % 251;
      await Bun.write(sourcePath, content);
      await Bun.write(destinationPath, 'old destination');

      await copyFileAtomic(sourcePath, destinationPath);

      expect(await Bun.file(destinationPath).bytes()).toEqual(content);
      expect(await hashFile(destinationPath)).toBe(hashBytes(content));
      expect((await readdir(tempRoot)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('a failed atomic copy preserves its destination and cleans up', async () => {
    const tempRoot = await createTempRoot();
    try {
      const destinationPath = path.join(tempRoot, 'destination.bin');
      await Bun.write(destinationPath, 'keep me');

      await expect(
        copyFileAtomic(path.join(tempRoot, 'missing.bin'), destinationPath),
      ).rejects.toThrow();

      expect(await Bun.file(destinationPath).text()).toBe('keep me');
      expect((await readdir(tempRoot)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
