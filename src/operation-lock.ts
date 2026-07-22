import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { BUILDER_CONFIG } from './builder-config.ts';
import { resolveBuilderContext } from './config.ts';
import { YmbError } from './errors.ts';
import { createTemporarySiblingPath, writeFileAtomic } from './path-utils.ts';
import { recoverPendingStateTransactionOrThrow } from './state-transaction.ts';

const INCOMPLETE_LOCK_GRACE_MS = 30_000;

interface OperationLockOwner {
  token: string;
  command: string;
  pid: number;
  hostname: string;
  startedAt: string;
}

export async function withBuilderOperationLock<T>(
  builderPath: string | undefined,
  command: string,
  operation: () => Promise<T>,
): Promise<T> {
  const context = await resolveBuilderContext(builderPath);
  return withOperationLock(context.ymbRoot, command, async () => {
    await recoverPendingStateTransactionOrThrow(context);
    return operation();
  });
}

export async function withOperationLock<T>(
  ymbRoot: string,
  command: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(ymbRoot, BUILDER_CONFIG.operationLockDirectoryName);
  const owner: OperationLockOwner = {
    token: randomUUID(),
    command,
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
  };

  await acquireOperationLock(lockPath, owner);
  try {
    return await operation();
  } finally {
    await releaseOperationLock(lockPath, owner.token);
  }
}

async function acquireOperationLock(lockPath: string, owner: OperationLockOwner): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(lockPath);
      try {
        await writeFileAtomic(resolveOwnerPath(lockPath), `${JSON.stringify(owner, null, 2)}\n`);
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      return;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }

    const existing = await readExistingLock(lockPath);
    if (await canReclaimLock(existing)) {
      const stalePath = createTemporarySiblingPath(lockPath);
      try {
        await rename(lockPath, stalePath);
        await rm(stalePath, { recursive: true, force: true });
        continue;
      } catch (error) {
        await rm(stalePath, { recursive: true, force: true }).catch(() => undefined);
        if (isMissingError(error) || isAlreadyExistsError(error)) {
          continue;
        }
        throw error;
      }
    }

    throw createLockError(lockPath, existing.owner);
  }

  throw createLockError(lockPath, (await readExistingLock(lockPath)).owner);
}

async function releaseOperationLock(lockPath: string, token: string): Promise<void> {
  const existing = await readExistingLock(lockPath);
  if (existing.owner?.token !== token) {
    return;
  }
  await rm(lockPath, { recursive: true, force: true });
}

async function readExistingLock(lockPath: string): Promise<{
  owner?: OperationLockOwner | undefined;
  ageMs: number;
}> {
  let ageMs = 0;
  try {
    ageMs = Math.max(0, Date.now() - (await stat(lockPath)).mtimeMs);
  } catch {
    return { ageMs };
  }

  try {
    const parsed: unknown = JSON.parse(await readFile(resolveOwnerPath(lockPath), 'utf8'));
    return { owner: parseLockOwner(parsed), ageMs };
  } catch {
    return { ageMs };
  }
}

async function canReclaimLock(existing: {
  owner?: OperationLockOwner | undefined;
  ageMs: number;
}): Promise<boolean> {
  if (!existing.owner) {
    return existing.ageMs >= INCOMPLETE_LOCK_GRACE_MS;
  }
  if (existing.owner.hostname !== hostname()) {
    return false;
  }
  return !isProcessRunning(existing.owner.pid);
}

function isProcessRunning(pid: number): boolean {
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isMissingProcessError(error);
  }
}

function parseLockOwner(value: unknown): OperationLockOwner | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.token !== 'string' ||
    typeof candidate.command !== 'string' ||
    typeof candidate.pid !== 'number' ||
    !Number.isInteger(candidate.pid) ||
    candidate.pid <= 0 ||
    typeof candidate.hostname !== 'string' ||
    typeof candidate.startedAt !== 'string'
  ) {
    return undefined;
  }
  return {
    token: candidate.token,
    command: candidate.command,
    pid: candidate.pid,
    hostname: candidate.hostname,
    startedAt: candidate.startedAt,
  };
}

function createLockError(lockPath: string, owner: OperationLockOwner | undefined): YmbError {
  const ownerDescription = owner
    ? `\`${owner.command}\` (PID ${owner.pid}, started ${owner.startedAt})`
    : 'another YMB operation';
  return new YmbError('CommandError', {
    absolutePath: lockPath,
    reason: `${ownerDescription} is already using this builder.`,
    suggestion:
      'Wait for that command to finish. If it crashed, retry after the process exits; YMB will reclaim its stale lock automatically.',
  });
}

function resolveOwnerPath(lockPath: string): string {
  return path.join(lockPath, 'owner.json');
}

function isAlreadyExistsError(error: unknown): boolean {
  return hasErrorCode(error, 'EEXIST');
}

function isMissingError(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR');
}

function isMissingProcessError(error: unknown): boolean {
  return hasErrorCode(error, 'ESRCH');
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
