import { expect, test } from 'bun:test';
import { createScriptCacheTools } from '../src/scripts/cache-tools.ts';
import {
  createTestBuilderContext,
  createTestBuildPlan,
  createTestScriptApplication,
} from './helpers/planner.ts';

test('cache paths reject parent and current-directory components even when caching is disabled', async () => {
  const plan = createTestBuildPlan(createTestBuilderContext('cache-fixture'));
  plan.selection.useCache = false;
  const cache = createScriptCacheTools(plan, createTestScriptApplication({ patchId: 'sample' }));
  for (const namespace of ['..', '.', '../other', 'nested/other']) {
    await expect(cache.writeJson(namespace, 'key', {})).rejects.toThrow();
    await expect(
      cache.readJson(namespace, 'key', (_value): _value is object => true),
    ).rejects.toThrow();
  }
});
