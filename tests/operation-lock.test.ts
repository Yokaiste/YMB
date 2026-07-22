import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { BUILDER_CONFIG } from '../src/builder-config.ts';
import { withOperationLock } from '../src/operation-lock.ts';

async function createTempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'ymb-operation-lock-'));
}

describe('builder operation lock', () => {
  test('blocks overlapping mutating operations and releases after completion', async () => {
    const tempRoot = await createTempRoot();
    let releaseFirst: (() => void) | undefined;
    let announceStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    try {
      const firstOperation = withOperationLock(tempRoot, 'first', async () => {
        announceStarted?.();
        await release;
        return 'first complete';
      });
      await started;

      await expect(
        withOperationLock(tempRoot, 'second', async () => 'should not run'),
      ).rejects.toThrow('`first`');

      releaseFirst?.();
      expect(await firstOperation).toBe('first complete');
      expect(await withOperationLock(tempRoot, 'third', async () => 'third complete')).toBe(
        'third complete',
      );
    } finally {
      releaseFirst?.();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('reclaims a lock owned by a process that no longer exists', async () => {
    const tempRoot = await createTempRoot();
    const lockPath = path.join(tempRoot, BUILDER_CONFIG.operationLockDirectoryName);
    try {
      await mkdir(lockPath);
      await Bun.write(
        path.join(lockPath, 'owner.json'),
        JSON.stringify({
          token: 'stale-token',
          command: 'crashed',
          pid: 2_147_483_647,
          hostname: hostname(),
          startedAt: '2000-01-01T00:00:00.000Z',
        }),
      );

      expect(await withOperationLock(tempRoot, 'replacement', async () => 'reclaimed')).toBe(
        'reclaimed',
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
