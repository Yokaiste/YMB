import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadCachedPatchOutput, saveCachedPatchOutput } from '../src/engine/patch-cache.ts';
import { createTestBuilderContext, createTestBuildPlan } from './helpers/planner.ts';

test('corrupt patch metadata becomes a cache miss instead of a broken report', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ymb-patch-cache-'));
  try {
    const context = createTestBuilderContext('cache-fixture');
    context.buildCacheRoot = root;
    const plan = createTestBuildPlan(context);
    const notice = {
      absolutePath: 'GameData/Fixture.ndf',
      modId: 'sample',
      modName: 'Sample',
      patchId: 'sample.patch',
      operationIndex: 0,
      reason: 'Already set.',
      suggestion: 'Remove the finished operation.',
    };
    await saveCachedPatchOutput(plan, 'key', '// Valid\n', {
      notices: [notice],
      prioritizedModId: 'sample',
    });
    expect(await loadCachedPatchOutput(plan, 'key')).toEqual({
      text: '// Valid\n',
      notices: [notice],
      prioritizedModId: 'sample',
    });
    for (const extra of [
      { notices: [null] },
      { notices: [{ ...notice, reason: 1 }] },
      { notices: [{ ...notice, operationIndex: -1 }] },
      { notices: [{ ...notice, operationLine: '2' }] },
      { notices: 'broken' },
      { prioritizedModId: 42 },
    ]) {
      await saveCachedPatchOutput(plan, 'key', '// Valid\n', extra);
      expect(await loadCachedPatchOutput(plan, 'key')).toBeUndefined();
    }
    await saveCachedPatchOutput(plan, 'key', '// Valid\n');
    expect((await loadCachedPatchOutput(plan, 'key'))?.notices).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
