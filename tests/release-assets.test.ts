import { describe, expect, test } from 'bun:test';
import path from 'node:path';
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
} from '../scripts/release-metadata.ts';

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
    expect(metadata.requiredBunVersion).toBe(Bun.version);
    expect(createReleasePackageDefinition(metadata).engines.bun).toBe(Bun.version);
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
});
