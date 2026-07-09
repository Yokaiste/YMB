import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectScriptDependencySources } from '../src/scripts/dependency-hash.ts';

describe('script dependency hash helpers', () => {
  test('collects transitive local script dependencies from static and runtime references', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ymb-script-deps-'));

    try {
      await mkdir(path.join(tempRoot, 'nested'), { recursive: true });
      await Bun.write(
        path.join(tempRoot, 'entry.ts'),
        [
          "import { alpha } from './alpha.ts';",
          "export { beta } from './nested/beta.ts';",
          "const workerUrl = new URL('./worker.ts', import.meta.url);",
          "await import('./gamma.ts');",
          "import chalk from 'chalk';",
          'void alpha;',
          'void workerUrl;',
        ].join('\n'),
      );
      await Bun.write(path.join(tempRoot, 'alpha.ts'), "export { helper } from './helper.ts';\n");
      await Bun.write(path.join(tempRoot, 'helper.ts'), 'export const helper = 1;\n');
      await Bun.write(path.join(tempRoot, 'nested', 'beta.ts'), 'export const beta = 2;\n');
      await Bun.write(path.join(tempRoot, 'worker.ts'), 'export const worker = true;\n');
      await Bun.write(path.join(tempRoot, 'gamma.ts'), 'export const gamma = 3;\n');

      const sources = await collectScriptDependencySources({
        entryAbsolutePaths: [path.join(tempRoot, 'entry.ts')],
        rootAbsolutePath: tempRoot,
      });

      expect(sources.map((source) => source.relativePath)).toEqual([
        'alpha.ts',
        'entry.ts',
        'gamma.ts',
        'helper.ts',
        path.join('nested', 'beta.ts'),
        'worker.ts',
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('dedupes cycles and resolves extensionless local imports', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ymb-script-deps-cycle-'));

    try {
      await mkdir(path.join(tempRoot, 'shared'), { recursive: true });
      await Bun.write(
        path.join(tempRoot, 'entry.ts'),
        "import './a';\nexport * from './shared';\n",
      );
      await Bun.write(
        path.join(tempRoot, 'a.ts'),
        "import './entry.ts';\nexport const a = true;\n",
      );
      await Bun.write(path.join(tempRoot, 'shared', 'index.ts'), 'export const shared = true;\n');

      const sources = await collectScriptDependencySources({
        entryAbsolutePaths: [path.join(tempRoot, 'entry.ts')],
        rootAbsolutePath: tempRoot,
      });

      expect(sources.map((source) => source.relativePath)).toEqual([
        'a.ts',
        'entry.ts',
        path.join('shared', 'index.ts'),
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
