import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveRuntimeEntrypoint } from '../src/runtime-entrypoint.ts';

describe('runtime entrypoint resolution', () => {
  test('uses TypeScript workers from the source tree', () => {
    const moduleUrl = pathToFileURL(`${import.meta.dir}/../src/scripts/runtime.ts`).href;
    expect(resolveRuntimeEntrypoint(moduleUrl, 'runtime-child')).toEndWith('runtime-child.ts');
  });

  test('prefers bundled JavaScript workers when present', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ymb-runtime-entrypoint-'));
    try {
      await writeFile(path.join(root, 'worker.js'), '');
      const moduleUrl = pathToFileURL(path.join(root, 'ymb.js')).href;
      expect(resolveRuntimeEntrypoint(moduleUrl, 'worker')).toEndWith('worker.js');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
