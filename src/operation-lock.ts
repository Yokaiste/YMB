import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { resolveBuilderContext } from './config/layout.ts';
import { reportProjectRoot } from './engine/progress.ts';
import { YmbError } from './errors.ts';
import { createTemporarySiblingPath, writeFileAtomic } from './path-utils.ts';
import { recoverPendingStateTransactionOrThrow } from './state-transaction.ts';

const INCOMPLETE_LOCK_GRACE_MS = 30_000;
const MAX_LOCK_OWNER_BYTES = 16 * 1024;
const MAX_LOCK_TEXT_LENGTH = 255;

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
  operation: (context: Awaited<ReturnType<typeof resolveBuilderContext>>) => Promise<T>,
): Promise<T> {
  const context = await resolveBuilderContext(builderPath);
  reportProjectRoot(context.buildRoot);
  return withOperationLock(context.operationLockRoot, command, async () => {
    await recoverPendingStateTransactionOrThrow(context);
    return operation(context);
  });
}

export async function withOperationLock<T>(
  lockPath: string,
  command: string,
  operation: () => Promise<T>,
): Promise<T> {
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
  await mkdir(path.dirname(lockPath), { recursive: true });
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
  // Only the token proves ownership. The directory can be deleted and recreated
  // while an operation is running; removing a new lock merely because its owner
  // file is not written yet would let two mutating commands overlap.
  if (!existing.owner || existing.owner.token !== token) {
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
    const ownerPath = resolveOwnerPath(lockPath);
    const ownerStats = await stat(ownerPath);
    if (!ownerStats.isFile() || ownerStats.size > MAX_LOCK_OWNER_BYTES) {
      return { ageMs };
    }
    const parsed: unknown = JSON.parse(await readFile(ownerPath, 'utf8'));
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
    !isSafeLockText(candidate.token) ||
    typeof candidate.command !== 'string' ||
    !isSafeLockText(candidate.command) ||
    typeof candidate.pid !== 'number' ||
    !Number.isSafeInteger(candidate.pid) ||
    candidate.pid <= 0 ||
    typeof candidate.hostname !== 'string' ||
    !isSafeLockText(candidate.hostname) ||
    typeof candidate.startedAt !== 'string' ||
    !isSafeLockText(candidate.startedAt) ||
    !Number.isFinite(Date.parse(candidate.startedAt))
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

function isSafeLockText(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_LOCK_TEXT_LENGTH &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
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
