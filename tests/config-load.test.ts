import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDefaultBuilderProjectConfig } from '../src/builder-config.ts';
import { loadBuilderProjectConfig, loadModConfig } from '../src/config/load.ts';
import type { YmbError } from '../src/errors.ts';

async function createConfigRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'ymb-config-load-'));
}

async function loadFailure(load: Promise<unknown>): Promise<YmbError> {
  const failure = await load.catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  return failure as YmbError;
}

describe('builder config loading', () => {
  test('keeps every default the file does not override', async () => {
    const root = await createConfigRoot();
    const configPath = path.join(root, 'ymb.config.yaml');
    try {
      await writeFile(
        configPath,
        'version: 1\npaths:\n  sourceMods: custom-mods\nsettings:\n  cacheMaxEntries: 7\n',
        'utf8',
      );

      const defaults = createDefaultBuilderProjectConfig();
      const config = await loadBuilderProjectConfig(configPath);

      expect(config.paths.sourceMods).toBe('custom-mods');
      expect(config.settings.cacheMaxEntries).toBe(7);
      expect(config.paths.workRoot).toBe(defaults.paths.workRoot);
      expect(config.settings.cacheMaxBytes).toBe(defaults.settings.cacheMaxBytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('falls back to defaults when there is no builder config at all', async () => {
    const root = await createConfigRoot();
    try {
      expect(await loadBuilderProjectConfig(path.join(root, 'ymb.config.yaml'))).toEqual(
        createDefaultBuilderProjectConfig(),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses a builder config path that is a directory', async () => {
    const root = await createConfigRoot();
    const configPath = path.join(root, 'ymb.config.yaml');
    try {
      await mkdir(configPath);

      const failure = await loadFailure(loadBuilderProjectConfig(configPath));
      expect(failure.context.reason).toContain('is not a regular file');
      expect(failure.context.suggestion).toContain('YAML');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('names the builder settings that do not fit the schema', async () => {
    const root = await createConfigRoot();
    const configPath = path.join(root, 'ymb.config.yaml');
    try {
      await writeFile(configPath, 'version: 1\nsettings:\n  cacheMaxEntries: 0\n', 'utf8');

      const failure = await loadFailure(loadBuilderProjectConfig(configPath));
      expect(failure.context.reason).toBe('Builder config fields are invalid.');
      expect(failure.context.details?.join('\n')).toContain('settings.cacheMaxEntries');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reports broken YAML as syntax, not as a schema problem', async () => {
    const root = await createConfigRoot();
    const configPath = path.join(root, 'ymb.config.yaml');
    try {
      await writeFile(configPath, 'version: 1\npaths: [unclosed\n', 'utf8');

      const failure = await loadFailure(loadBuilderProjectConfig(configPath));
      expect(failure.context.reason).toBe('Could not read or parse this YAML file.');
      expect(failure.context.details?.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('source mod config loading', () => {
  test('labels a schema failure with the config kind and the field path', async () => {
    const root = await createConfigRoot();
    const configPath = path.join(root, 'ymb.mod.yaml');
    try {
      await writeFile(configPath, 'version: 1\nid: "bad id!"\nname: Sample\n', 'utf8');

      const failure = await loadFailure(loadModConfig(configPath));
      expect(failure.context.reason).toBe('source mod config fields are invalid.');
      expect(failure.context.details?.join('\n')).toContain('id:');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('lists each branch a union value failed to match, without repeats', async () => {
    const root = await createConfigRoot();
    const configPath = path.join(root, 'ymb.mod.yaml');
    try {
      // `tempPaths` accepts a string or an object, so a number fails both.
      await writeFile(
        configPath,
        'version: 1\nid: sample_mod\nname: Sample\ntempPaths:\n  - 5\n',
        'utf8',
      );

      const failure = await loadFailure(loadModConfig(configPath));
      const details = failure.context.details ?? [];
      expect(details.length).toBeGreaterThan(0);
      expect(details.every((detail) => detail.startsWith('tempPaths.0'))).toBe(true);
      expect(new Set(details).size).toBe(details.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reports the missing root field when the file holds no mapping', async () => {
    const root = await createConfigRoot();
    const configPath = path.join(root, 'ymb.mod.yaml');
    try {
      await writeFile(configPath, '# only a comment\n', 'utf8');

      const failure = await loadFailure(loadModConfig(configPath));
      expect(failure.context.details?.join('\n')).toContain('<root>');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
