import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertRealPathWithinRoot } from '../src/path-utils.ts';

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
