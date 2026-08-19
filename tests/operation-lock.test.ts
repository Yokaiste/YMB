import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
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
    const lockPath = path.join(tempRoot, BUILDER_CONFIG.operationLockDirectoryName);
    let releaseFirst: (() => void) | undefined;
    let announceStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    try {
      const firstOperation = withOperationLock(lockPath, 'first', async () => {
        announceStarted?.();
        await release;
        return 'first complete';
      });
      await started;

      await expect(
        withOperationLock(lockPath, 'second', async () => 'should not run'),
      ).rejects.toThrow('`first`');

      releaseFirst?.();
      expect(await firstOperation).toBe('first complete');
      expect(await withOperationLock(lockPath, 'third', async () => 'third complete')).toBe(
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

      expect(await withOperationLock(lockPath, 'replacement', async () => 'reclaimed')).toBe(
        'reclaimed',
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('leaves a lock owned by another machine alone, however old it is', async () => {
    const tempRoot = await createTempRoot();
    const lockPath = path.join(tempRoot, BUILDER_CONFIG.operationLockDirectoryName);
    try {
      await mkdir(lockPath);
      await Bun.write(
        path.join(lockPath, 'owner.json'),
        JSON.stringify({
          token: 'remote-token',
          // The PID would look dead here, but it describes a process on a
          // machine this one cannot ask about.
          command: 'sync',
          pid: 2_147_483_647,
          hostname: `${hostname()}-other`,
          startedAt: '2000-01-01T00:00:00.000Z',
        }),
      );
      await ageLock(lockPath);

      await expect(withOperationLock(lockPath, 'blocked', async () => 'ran')).rejects.toThrow(
        '`sync` (PID 2147483647',
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('does not delete a replacement lock whose owner is still being written', async () => {
    const tempRoot = await createTempRoot();
    const lockPath = path.join(tempRoot, BUILDER_CONFIG.operationLockDirectoryName);
    try {
      await withOperationLock(lockPath, 'first', async () => {
        await rm(lockPath, { recursive: true, force: true });
        await mkdir(lockPath);
      });

      expect((await stat(lockPath)).isDirectory()).toBe(true);
      await expect(withOperationLock(lockPath, 'second', async () => 'ran')).rejects.toThrow(
        'another YMB operation is already using this builder',
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test.each([
    ['no owner file at all', undefined],
    ['an owner file that is not JSON', '{ torn'],
    ['an owner file missing required fields', JSON.stringify({ token: 'partial' })],
    ['an owner file claiming an impossible pid', JSON.stringify({ token: 't', pid: 0 })],
    [
      'an owner file carrying terminal control text',
      JSON.stringify({
        token: 'token',
        command: 'sync\n[x] forged output',
        pid: process.pid,
        hostname: hostname(),
        startedAt: new Date().toISOString(),
      }),
    ],
    [
      'an owner file carrying an invalid timestamp',
      JSON.stringify({
        token: 'token',
        command: 'sync',
        pid: process.pid,
        hostname: hostname(),
        startedAt: 'not-a-date',
      }),
    ],
    ['an oversized owner file', 'x'.repeat(20_000)],
  ])('waits out the grace period for a lock with %s', async (_description, ownerContent) => {
    const tempRoot = await createTempRoot();
    const lockPath = path.join(tempRoot, BUILDER_CONFIG.operationLockDirectoryName);
    try {
      await mkdir(lockPath);
      if (ownerContent !== undefined) {
        await Bun.write(path.join(lockPath, 'owner.json'), ownerContent);
      }

      // Still inside the grace period: the owner may be mid-acquisition.
      await expect(withOperationLock(lockPath, 'blocked', async () => 'ran')).rejects.toThrow(
        'another YMB operation is already using this builder',
      );

      await ageLock(lockPath);
      expect(await withOperationLock(lockPath, 'replacement', async () => 'reclaimed')).toBe(
        'reclaimed',
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

/** Backdates the lock past the 30s incomplete-lock grace. */
async function ageLock(lockPath: string): Promise<void> {
  const longAgo = new Date(Date.now() - 60_000);
  await utimes(lockPath, longAgo, longAgo);
}
