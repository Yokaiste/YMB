import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { deriveInitId, runInit } from '../src/init.ts';
import { pathExists } from '../src/path-utils.ts';
import { cleanupTempRoots, createAbstractBuilderWorkspace } from './helpers/abstract-builder.ts';

const tempRoots: string[] = [];

afterAll(async () => {
  await cleanupTempRoots(tempRoots);
});

describe('init', () => {
  /** Counting an absent `--description` as a missing answer sent the documented command to an interactive prompt. */
  test('creates the scaffold from a name and id alone, with no terminal to prompt on', async () => {
    const workspace = await createAbstractBuilderWorkspace(tempRoots);

    const result = await runInit(workspace.builderPath, { id: 'starter_pack', name: 'Starter' });

    expect(result.lines).toContain('Source mod id: starter_pack');
    const configPath = path.join(
      workspace.builderPath,
      'mods',
      'starter_pack',
      'config',
      'ymb.mod.yaml',
    );
    expect(await pathExists(configPath)).toBeTrue();
    expect(await Bun.file(configPath).text()).not.toContain('description:');
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
    expect(configText).toContain('description: "A one line summary"');
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
