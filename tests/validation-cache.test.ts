import { afterEach, describe, expect, test } from 'bun:test';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resetValidationMemoForTests,
  resolveNdfValidationCachePath,
  validateNdfPersistentlyMemoized,
} from '../src/engine/validation-memo.ts';
import { hashText } from '../src/hash.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  resetValidationMemoForTests();
  while (tempRoots.length > 0) {
    await rm(tempRoots.pop() as string, { recursive: true, force: true });
  }
});

describe('persistent NDF validation cache', () => {
  test('reuses only an exact-content validation result', async () => {
    const cacheRoot = await mkdtemp(path.join(tmpdir(), 'ymb-validation-cache-'));
    tempRoots.push(cacheRoot);
    const valid = 'Descriptor is TDescriptor\n(\n  Value = 1\n)\n';
    const invalid = 'Descriptor is TDescriptor\n(\n  Value = ]\n)\n';

    expect(await validateNdfPersistentlyMemoized(valid, 'valid.ndf', cacheRoot)).toBe(false);
    resetValidationMemoForTests();
    expect(await validateNdfPersistentlyMemoized(valid, 'valid.ndf', cacheRoot)).toBe(true);

    const validCachePath = resolveNdfValidationCachePath(cacheRoot, hashText(valid));
    const invalidCachePath = resolveNdfValidationCachePath(cacheRoot, hashText(invalid));
    await copyFile(validCachePath, invalidCachePath);
    resetValidationMemoForTests();

    await expect(
      validateNdfPersistentlyMemoized(invalid, 'invalid.ndf', cacheRoot),
    ).rejects.toThrow('Unbalanced delimiter `]`');
  });
});
