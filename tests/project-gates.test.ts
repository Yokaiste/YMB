import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import biomeDefinition from '../biome.json' with { type: 'json' };
import packageDefinition from '../package.json' with { type: 'json' };
import builderTsconfig from '../tsconfig.json' with { type: 'json' };
import modsTsconfig from '../tsconfig.mods.json' with { type: 'json' };

const repositoryRoot = path.resolve(import.meta.dir, '..');
const scripts = packageDefinition.scripts as Record<string, string>;

/** A mod must never fail the builder's gate, and the builder must pass with no mod present. */
describe('builder and source-mod gates stay separate', () => {
  test('the builder gate never reads a source-mod checkout', () => {
    for (const name of ['check', 'lint', 'typecheck', 'prettier', 'biome', 'test', 'fix']) {
      expect(scripts[name]).toBeTruthy();
      expect(scripts[name]).not.toContain('mods');
    }

    // Prettier and Biome both walk the whole tree, so `mods/` has to be ignored
    // by the file they already honour rather than by a second ignore mechanism.
    expect(scripts.prettier).toContain('--ignore-path .gitignore');
    expect(builderTsconfig.include.some((entry) => entry.includes('mods'))).toBe(false);
  });

  test('one formatter and one linter, never both formatting', () => {
    // Biome's formatter was configured identically to Prettier, so every file was
    // formatted twice to the same bytes. Prettier keeps the job because it also
    // reads the Markdown and YAML Biome ignores.
    expect(biomeDefinition.formatter.enabled).toBe(false);
    for (const name of ['biome', 'biome:fix', 'biome:mods', 'biome:mods:fix']) {
      expect(scripts[name]).toBeTruthy();
      expect(scripts[name]).not.toContain('biome format');
    }
  });

  test('the mod gate applies the builder rules without redeclaring them', () => {
    for (const name of ['check:mods', 'lint:mods', 'typecheck:mods', 'fix:mods']) {
      expect(scripts[name]).toBeTruthy();
    }
    expect(scripts['check:all']).toBe('bun run check && bun run check:mods');
    expect(scripts['fix:all']).toBe('bun run fix && bun run fix:mods');

    // The mod tsconfig may only point the same compiler at different files. Any
    // `compilerOptions` here would let mod code drift from builder rules.
    expect(modsTsconfig.extends).toBe('./tsconfig.json');
    expect(Object.keys(modsTsconfig)).toEqual(['extends', 'include']);
    expect(modsTsconfig.include).toContain('mods/**/*.ts');

    // Mod scripts import `ymb/api`, so the builder sources have to be in the
    // same program for the mod gate to resolve those types at all.
    expect(modsTsconfig.include).toContain('src/**/*.ts');

    // `.gitignore` hides mods from Biome and Prettier, so the mod gate has to
    // opt back out of it explicitly or it would silently check nothing. Prettier
    // has no `--no-ignore`, so it is pointed at an ignore file of its own.
    expect(scripts['biome:mods']).toContain('--vcs-use-ignore-file=false');
    for (const name of ['prettier:mods', 'prettier:mods:fix']) {
      expect(scripts[name]).toContain('--ignore-path .prettierignore.mods');
    }
  });

  test('the source-mod ignore file does not hide the mods it exists to check', async () => {
    // Without this the mod gate reports success over zero files, which is exactly
    // the failure `--ignore-path .prettierignore.mods` was added to prevent.
    const ignore = await readFile(path.join(repositoryRoot, '.prettierignore.mods'), 'utf8');
    const rules = ignore
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));

    expect(rules.length).toBeGreaterThan(0);
    expect(rules.some((rule) => rule.replace(/^!/, '').startsWith('mods'))).toBe(false);
  });

  test('a fresh install with no source mods still passes the mod gate', () => {
    // `mods/` ships holding only `.gitkeep` and `AGENTS.md`. Prettier treats an
    // unmatched pattern as an error unless told otherwise, which would make
    // `check:mods` fail on a clean install.
    expect(scripts['prettier:mods']).toContain('--no-error-on-unmatched-pattern');
  });

  test('builder sources import the public API the way a mod script does', async () => {
    // `ymb/api` exports a class. A relative import is the same file from source,
    // but the release bundles each entrypoint separately: a relative import gets
    // inlined per bundle, and the packaged build then holds several classes all
    // named `ScriptToolError`, none of them `instanceof` any other. The specifier
    // stays external instead, so every bundle shares the one shipped module.
    const sources = new Bun.Glob('**/*.ts').scan({
      cwd: path.join(repositoryRoot, 'src'),
      onlyFiles: true,
    });
    const offenders: string[] = [];
    let importers = 0;
    for await (const relativePath of sources) {
      if (relativePath === 'api.ts') continue;
      const source = await readFile(path.join(repositoryRoot, 'src', relativePath), 'utf8');
      if (/from\s+'(?:\.\.?\/)+api\.ts'/.test(source)) offenders.push(relativePath);
      if (source.includes("from 'ymb/api'")) importers += 1;
    }

    expect(offenders).toEqual([]);
    // Without this the check passes the day someone deletes the last importer.
    expect(importers).toBeGreaterThan(0);
  });

  test('git ignores source-mod checkouts but keeps their shared guidance', async () => {
    const ignore = await readFile(path.join(repositoryRoot, '.gitignore'), 'utf8');
    const rules = ignore.split('\n').map((line) => line.trim());

    // Without this, `git add -A` in the builder swallows an entire unrelated
    // repository, and `git status` is unreadable while any mod is checked out.
    expect(rules).toContain('mods/*');
    expect(rules).toContain('!mods/.gitkeep');
    expect(rules).toContain('!mods/AGENTS.md');
  });
});
