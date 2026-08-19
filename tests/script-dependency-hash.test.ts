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
          'import {',
          '  alpha, // a comment inside the import used to hide this dependency',
          "} from './alpha.ts?variant=one';",
          "export { Component } from './component.tsx';",
          "export { beta } from './nested/beta.ts';",
          "const workerUrl = new URL('./worker.ts', import.meta.url);",
          "await import('./gamma.ts');",
          "const required = require('./required.ts');",
          'const templateRequired = require(`./template-required.ts`);',
          'await import(`./template-dynamic.ts`);',
          'const templateWorkerUrl = new URL(`./template-worker.ts`, import.meta.url);',
          "import chalk from 'chalk';",
          'const importLookingText = "import \'./ignored.ts\'";',
          'void alpha;',
          'void importLookingText;',
          'void required;',
          'void templateRequired;',
          'void templateWorkerUrl;',
          'void workerUrl;',
        ].join('\n'),
      );
      await Bun.write(path.join(tempRoot, 'alpha.ts'), "export { helper } from './helper.ts';\n");
      await Bun.write(
        path.join(tempRoot, 'component.tsx'),
        "import { tsxHelper } from './tsx-helper.ts';\nexport const Component = () => <div>{tsxHelper}</div>;\n",
      );
      await Bun.write(path.join(tempRoot, 'helper.ts'), 'export const helper = 1;\n');
      await Bun.write(path.join(tempRoot, 'nested', 'beta.ts'), 'export const beta = 2;\n');
      await Bun.write(path.join(tempRoot, 'worker.ts'), 'export const worker = true;\n');
      await Bun.write(path.join(tempRoot, 'gamma.ts'), 'export const gamma = 3;\n');
      await Bun.write(path.join(tempRoot, 'required.ts'), 'export const required = 4;\n');
      await Bun.write(path.join(tempRoot, 'template-dynamic.ts'), 'export const dynamic = 5;\n');
      await Bun.write(path.join(tempRoot, 'template-required.ts'), 'export const required = 6;\n');
      await Bun.write(path.join(tempRoot, 'template-worker.ts'), 'export const worker = 7;\n');
      await Bun.write(path.join(tempRoot, 'ignored.ts'), 'throw new Error("not imported");\n');
      await Bun.write(path.join(tempRoot, 'tsx-helper.ts'), "export const tsxHelper = 'ok';\n");

      const sources = await collectScriptDependencySources({
        entryAbsolutePaths: [path.join(tempRoot, 'entry.ts')],
        rootAbsolutePath: tempRoot,
      });

      expect(sources.map((source) => source.relativePath)).toEqual([
        'alpha.ts',
        'component.tsx',
        'entry.ts',
        'gamma.ts',
        'helper.ts',
        path.join('nested', 'beta.ts'),
        'required.ts',
        'template-dynamic.ts',
        'template-required.ts',
        'template-worker.ts',
        'tsx-helper.ts',
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
