import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import packageDefinition from '../package.json' with { type: 'json' };
import {
  API_BUNDLE_OUTPUT_NAME,
  API_MODULE_SPECIFIER,
  createReleasePackageDefinition,
  getReleaseMetadata,
  planReleaseCommands,
  RELEASE_BUNDLES,
  RELEASE_REQUIRED_FILES,
  resolveBundleExternals,
  resolveWindowsTarPath,
} from '../scripts/release-metadata.ts';
import { BUILDER_CONFIG, createDefaultBuilderProjectConfig } from '../src/builder-config.ts';
import { CLI_COMMAND_NAMES } from '../src/cli-guide.ts';
import { loadBuilderProjectConfig } from '../src/config/load.ts';

const repositoryRoot = path.resolve(import.meta.dir, '..');

describe('portable release assets', () => {
  test('release metadata centralizes archive names and release identifiers', () => {
    const metadata = getReleaseMetadata(repositoryRoot);
    expect(metadata.tag).toBe(`v${packageDefinition.version}`);
    expect(metadata.title).toBe(`YMB v${packageDefinition.version}`);
    expect(metadata.bundled.archiveName).toBe(`YMB-v${packageDefinition.version}-windows-x64.zip`);
    expect(metadata.system.archiveName).toBe(
      `YMB-v${packageDefinition.version}-windows-x64-no-bun.zip`,
    );
    expect(metadata.fullReleaseUrl).toEndWith(`/${metadata.tag}/${metadata.bundled.archiveName}`);
    expect(metadata.notesPath).toBe(path.join(repositoryRoot, 'dist', 'release-notes.md'));
  });

  test('every bundle shares one copy of the public API module', () => {
    // `ScriptToolError` is a class, and both sides compare it with `instanceof`:
    // a mod script catching what `context.tools` raises, and the builder reading
    // `options` off what a script raises. Inlining the module into each bundle
    // ships one class per bundle, so both comparisons answer false in a packaged
    // release while passing from source.
    const apiBundle = RELEASE_BUNDLES.find((entry) => entry.outputName === API_BUNDLE_OUTPUT_NAME);
    expect(apiBundle?.entrypoint).toBe('src/api.ts');
    expect(resolveBundleExternals(API_BUNDLE_OUTPUT_NAME)).toEqual([]);

    for (const { outputName } of RELEASE_BUNDLES) {
      if (outputName === API_BUNDLE_OUTPUT_NAME) continue;
      expect(resolveBundleExternals(outputName)).toEqual([API_MODULE_SPECIFIER]);
    }

    // Externalizing only works because the shipped exports map resolves that
    // specifier back to the one bundle, for mod scripts and bundles alike.
    const releasePackage = createReleasePackageDefinition(getReleaseMetadata(repositoryRoot));
    expect(releasePackage.exports['./api'].import).toBe(`./app/${API_BUNDLE_OUTPUT_NAME}`);
    expect(RELEASE_REQUIRED_FILES).toContain(`app/${API_BUNDLE_OUTPUT_NAME}`);
  });

  test('launcher supports direct execution and opens the scoped shell by default', async () => {
    const launcher = await readFile(path.join(repositoryRoot, 'release', 'YMB.bat'), 'utf8');
    expect(launcher).toContain('resolve-bun.cmd');
    expect(launcher).toContain('"%YMB_BUN%"');
    expect(launcher).toContain('app\\ymb.js');
    expect(launcher).toContain('cmd.exe /D /K');
  });

  test('runtime resolver validates system Bun and recommends the full archive', async () => {
    const resolver = await readFile(
      path.join(repositoryRoot, 'release', 'resolve-bun.cmd'),
      'utf8',
    );
    expect(resolver).toContain('where.exe bun.exe');
    expect(resolver).toContain('YMB_REQUIRED_BUN');
    expect(resolver).toContain('YMB_FULL_RELEASE_URL');
    expect(resolver).toContain('missing_bun');
    expect(resolver).toContain('wrong_bun');
  });

  test('scoped shell registers every public command and renders help on startup', async () => {
    const shell = await readFile(path.join(repositoryRoot, 'release', 'shell-init.cmd'), 'utf8');
    for (const command of CLI_COMMAND_NAMES) {
      expect(shell).toContain(`doskey ${command}=`);
    }
    expect(shell).toContain('doskey help=');
    expect(shell).toContain('"%YMB_CLI%" --help');
  });

  test('CI builds releases on the Bun version the build itself demands', async () => {
    const workflow = parse(
      await readFile(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8'),
    );

    // `build-release.ts` refuses to run unless the runtime matches
    // `packageManager`, so an unpinned setup step breaks releasing the moment
    // Bun publishes a newer version.
    const setupSteps = Object.values(workflow.jobs as Record<string, { steps: unknown[] }>)
      .flatMap((job) => job.steps as Array<{ uses?: string; with?: Record<string, string> }>)
      .filter((step) => step.uses?.startsWith('oven-sh/setup-bun'));
    expect(setupSteps.length).toBeGreaterThan(0);
    for (const step of setupSteps) {
      expect(step.with?.['bun-version-file'] ?? step.with?.['bun-version']).toBeTruthy();
    }

    // Releasing must gate on a green check job and must never cancel itself
    // between removing and recreating a release.
    const release = workflow.jobs.release as {
      needs: string;
      if: string;
      concurrency: { 'cancel-in-progress': boolean };
    };
    expect(release.needs).toBe('check');
    expect(release.if).toContain("github.event_name == 'push'");
    expect(release.concurrency['cancel-in-progress']).toBe(false);
  });

  test('republishing a version replaces the release instead of adding to it', () => {
    const metadata = getReleaseMetadata(repositoryRoot);
    const fresh = planReleaseCommands(metadata, { releaseExists: false, commitSha: 'abc123' });
    const republished = planReleaseCommands(metadata, { releaseExists: true, commitSha: 'abc123' });

    // A first publish must not try to delete anything that is not there.
    expect(fresh.some((command) => command.includes('delete'))).toBe(false);
    expect(republished[0]).toEqual([
      'gh',
      'release',
      'delete',
      metadata.tag,
      '--yes',
      '--cleanup-tag',
    ]);

    // Both paths end by creating the tag and release from the same archives, and
    // never patch an existing release in place.
    for (const plan of [fresh, republished]) {
      expect(plan.at(-1)?.slice(0, 3)).toEqual(['gh', 'release', 'create']);
      expect(plan.at(-1)).toContain(metadata.bundled.archivePath);
      expect(plan.at(-1)).toContain(metadata.system.archivePath);
      expect(plan.flat()).not.toContain('edit');
      expect(plan.flat()).not.toContain('--clobber');
      expect(plan.findIndex((command) => command[0] === 'git')).toBeLessThan(plan.length - 1);
    }
  });

  test('the shipped builder config documents every setting without changing one', async () => {
    const configPath = path.join(repositoryRoot, BUILDER_CONFIG.builderConfigFileName);
    const config = await readFile(configPath, 'utf8');

    // `version` has to stay active - a fully commented file parses as null and
    // fails the schema instead of falling back to defaults.
    const activeLines = config
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(activeLines).toEqual(['version: 1']);

    // Everything else must be present as commented documentation, so a reader
    // can uncomment a line instead of hunting through the docs for its name.
    const defaults = createDefaultBuilderProjectConfig();
    for (const key of [...Object.keys(defaults.paths), ...Object.keys(defaults.settings)]) {
      expect(config).toContain(`#   ${key}:`);
    }
    expect(config).toContain('# paths:');
    expect(config).toContain('# settings:');

    // The whole point: shipping this file must resolve exactly like shipping none.
    expect(await loadBuilderProjectConfig(configPath)).toEqual(defaults);
    expect(RELEASE_REQUIRED_FILES).toContain(BUILDER_CONFIG.builderConfigFileName);
  });

  test('archive steps pin Windows bsdtar instead of trusting PATH', async () => {
    const tarPath = resolveWindowsTarPath();
    expect(path.isAbsolute(tarPath)).toBe(true);
    expect(tarPath.toLowerCase()).toEndWith('system32\\tar.exe');

    // Git Bash ships GNU tar at /usr/bin/tar.exe, which reads `D:\...zip` as a
    // remote host and fails. A bare spawn makes the release build depend on which
    // shell launched it.
    for (const script of ['build-release.ts', 'verify-release.ts']) {
      const source = await readFile(path.join(repositoryRoot, 'scripts', script), 'utf8');
      expect(source).toContain('resolveWindowsTarPath()');
      expect(source).not.toContain("'tar.exe'");
    }
  });

  test('publish verifies every archive before removing anything published', async () => {
    const publish = await readFile(
      path.join(repositoryRoot, 'scripts', 'publish-release.ts'),
      'utf8',
    );
    const verifyIndex = publish.indexOf('await assertReleaseInputsExist();');
    const planIndex = publish.indexOf('planReleaseCommands(');
    expect(verifyIndex).toBeGreaterThan(-1);
    expect(planIndex).toBeGreaterThan(verifyIndex);
  });
});
