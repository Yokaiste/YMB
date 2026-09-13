import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deriveInitId, runInit } from '../src/init.ts';
import { pathExists } from '../src/path-utils.ts';
import { cleanupTempRoots, createAbstractBuilderWorkspace } from './helpers/abstract-builder.ts';

const tempRoots: string[] = [];

afterAll(async () => {
  await cleanupTempRoots(tempRoots);
});

describe('init', () => {
  test.each([undefined, 'version: 1\npaths:\n  sourceMods: ../Source Packs\n'])(
    'starter documentation links resolve locally with configured source folders: %s',
    async (builderConfig) => {
      const workspace = await createAbstractBuilderWorkspace(tempRoots, {
        builderDirectoryName: 'Build Tools',
        ...(builderConfig ? { builderConfig } : {}),
      });
      for (const name of ['getting-started.md', 'configuration.md']) {
        await Bun.write(path.join(workspace.builderPath, 'docs', name), '# Sample documentation');
      }
      const created = await runInit(workspace.builderPath, { id: 'example', name: 'Example' });
      const modRoot = path.join(created.modsRoot, 'example');
      const readme = await Bun.file(path.join(modRoot, 'README.md')).text();
      const links = [...readme.matchAll(/\]\(([^)]+)\)/g)].flatMap(([, link]) =>
        link ? [link] : [],
      );
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        expect(link).not.toMatch(/^(?:[a-z]+:|\/)/i);
        expect(await pathExists(path.resolve(modRoot, decodeURIComponent(link)))).toBe(true);
      }
    },
  );

  /** Counting an absent `--description` as a missing answer sent the documented command to an interactive prompt. */
  test('creates the scaffold from a name and id alone, with no terminal to prompt on', async () => {
    const workspace = await createAbstractBuilderWorkspace(tempRoots);

    await runInit(workspace.builderPath, { id: 'starter_pack', name: 'Starter' });

    const configPath = path.join(
      workspace.builderPath,
      'mods',
      'starter_pack',
      'config',
      'ymb.mod.yaml',
    );
    expect(await pathExists(configPath)).toBeTrue();
    expect(Bun.YAML.parse(await Bun.file(configPath).text())).toMatchObject({
      id: 'starter_pack',
      name: 'Starter',
    });
  });

  test('keeps a description that was passed', async () => {
    const workspace = await createAbstractBuilderWorkspace(tempRoots);

    await runInit(workspace.builderPath, {
      id: 'described_pack',
      name: 'Described',
      description: 'A one line summary',
    });

    const configText = await Bun.file(
      path.join(workspace.builderPath, 'mods', 'described_pack', 'config', 'ymb.mod.yaml'),
    ).text();
    expect(Bun.YAML.parse(configText)).toMatchObject({ description: 'A one line summary' });
  });

  test('starter tests stay independent of the installed name and destination', async () => {
    const workspace = await createAbstractBuilderWorkspace(tempRoots);
    const created = await runInit(workspace.builderPath, { id: 'example', name: 'Original name' });
    expect(created.data?.id).toBe('example');
    for (const file of created.data?.files ?? []) expect(await pathExists(file)).toBe(true);
    const companion = await import(
      pathToFileURL(
        path.join(
          workspace.builderPath,
          'mods',
          'example',
          'config',
          'generate-build-info.test.ts',
        ),
      ).href
    );
    for (const name of ['Renamed', 'Names with "quotes"']) {
      const result = await companion.default({
        mod: { id: 'different', name },
        variables: { generatedInfoTarget: 'GameData/Changed.ndf' },
      });
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.every((entry: { status: string }) => entry.status === 'passed')).toBe(
        true,
      );
    }
  });
});

describe('init helpers', () => {
  test('returns undefined when neither a name nor an explicit id is available', () => {
    expect(deriveInitId(undefined, undefined)).toBeUndefined();
    expect(deriveInitId('', '')).toBeUndefined();
  });

  test('derives a stable id from the display name when no explicit id is provided', () => {
    expect(deriveInitId('My First Pack', undefined)).toBe('my_first_pack');
    expect(deriveInitId('  My First Pack  ', '   ')).toBe('my_first_pack');
  });

  test('prefers an explicit id over the derived slug', () => {
    expect(deriveInitId('My First Pack', 'custom.pack')).toBe('custom.pack');
  });
});
