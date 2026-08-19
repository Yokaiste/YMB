import { existsSync } from 'node:fs';
import path from 'node:path';
import packageDefinition from '../package.json' with { type: 'json' };

export type ReleaseRuntime = 'bundled' | 'system';

/**
 * Bare `tar.exe` resolves through `PATH`, and Git Bash puts GNU tar first. GNU tar
 * reads an absolute destination as a `host:path` remote spec and fails, so pin the
 * real binary.
 */
export function resolveWindowsTarPath(): string {
  const tarPath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  if (!existsSync(tarPath)) {
    throw new Error(
      `Windows bsdtar is required to pack or inspect release archives, but ${tarPath} does not exist.`,
    );
  }
  return tarPath;
}

interface ReleaseVariantMetadata {
  runtime: ReleaseRuntime;
  archiveName: string;
  archivePath: string;
  root: string;
}

interface ReleaseMetadata {
  repositoryRoot: string;
  distRoot: string;
  releaseRootName: string;
  releaseRoot: string;
  appRoot: string;
  runtimeRoot: string;
  typesRoot: string;
  systemParentRoot: string;
  requiredBunVersion: string;
  version: string;
  tag: string;
  title: string;
  notesPath: string;
  fullReleaseUrl: string;
  bundled: ReleaseVariantMetadata;
  system: ReleaseVariantMetadata;
}

export const RELEASE_REQUIRED_FILES = [
  'YMB.bat',
  'README.md',
  'LICENSE',
  'NOTICE',
  'THIRD-PARTY-NOTICES.md',
  'ymb.config.yaml',
  'package.json',
  'docs/README.md',
  'mods/README.md',
  'app/ymb.js',
  'app/api.js',
  'app/runtime-child.js',
  'app/test-runtime-child.js',
  'app/patch-runtime-child.js',
  'app/shell-init.cmd',
  'app/resolve-bun.cmd',
  'app/release-info.cmd',
  'types/api.d.ts',
] as const;

/**
 * Republishing replaces the whole release rather than adding assets, so a tag can
 * never serve a mix of two builds. Pure, so the ordering is testable.
 */
export function planReleaseCommands(
  metadata: ReleaseMetadata,
  options: { releaseExists: boolean; commitSha: string },
): string[][] {
  return [
    ...(options.releaseExists
      ? [['gh', 'release', 'delete', metadata.tag, '--yes', '--cleanup-tag']]
      : []),
    ['git', 'tag', '--force', metadata.tag, options.commitSha],
    ['git', 'push', 'origin', `refs/tags/${metadata.tag}`, '--force'],
    [
      'gh',
      'release',
      'create',
      metadata.tag,
      metadata.bundled.archivePath,
      metadata.system.archivePath,
      '--verify-tag',
      '--latest',
      '--title',
      metadata.title,
      '--notes-file',
      metadata.notesPath,
    ],
  ];
}

/** How every bundle, and every mod script, spells the public API module. */
export const API_MODULE_SPECIFIER = 'ymb/api';
export const API_BUNDLE_OUTPUT_NAME = 'api.js';

export const RELEASE_BUNDLES = [
  { entrypoint: 'index.ts', outputName: 'ymb.js' },
  { entrypoint: 'src/api.ts', outputName: API_BUNDLE_OUTPUT_NAME },
  { entrypoint: 'src/scripts/runtime-child.ts', outputName: 'runtime-child.js' },
  { entrypoint: 'src/scripts/test-runtime-child.ts', outputName: 'test-runtime-child.js' },
  { entrypoint: 'src/engine/patch-runtime-child.ts', outputName: 'patch-runtime-child.js' },
] as const;

/**
 * `ymb/api` carries a class: a mod script catches `ScriptToolError` with `instanceof`
 * and the builder reads `error.options` off it. Inlining it per bundle would ship one
 * class per bundle, so both checks answer `false` in a release while passing from
 * source. Every bundle but the API imports the specifier instead.
 */
export function resolveBundleExternals(outputName: string): string[] {
  return outputName === API_BUNDLE_OUTPUT_NAME ? [] : [API_MODULE_SPECIFIER];
}

export function getReleaseMetadata(repositoryRoot: string): ReleaseMetadata {
  const version = packageDefinition.version;
  const tag = `v${version}`;
  const releaseRootName = 'YMB';
  const distRoot = path.join(repositoryRoot, 'dist');
  const releaseRoot = path.join(distRoot, releaseRootName);
  const systemParentRoot = path.join(distRoot, 'no-bun');
  const bundledArchiveName = `${releaseRootName}-${tag}-windows-x64.zip`;
  const systemArchiveName = `${releaseRootName}-${tag}-windows-x64-no-bun.zip`;
  const requiredBunVersion = packageDefinition.packageManager.replace(/^bun@/, '');

  return {
    repositoryRoot,
    distRoot,
    releaseRootName,
    releaseRoot,
    appRoot: path.join(releaseRoot, 'app'),
    runtimeRoot: path.join(releaseRoot, 'runtime'),
    typesRoot: path.join(releaseRoot, 'types'),
    systemParentRoot,
    requiredBunVersion,
    version,
    tag,
    title: `${releaseRootName} ${tag}`,
    notesPath: path.join(distRoot, 'release-notes.md'),
    fullReleaseUrl: `${packageDefinition.homepage}/releases/download/${tag}/${bundledArchiveName}`,
    bundled: {
      runtime: 'bundled',
      archiveName: bundledArchiveName,
      archivePath: path.join(distRoot, bundledArchiveName),
      root: releaseRoot,
    },
    system: {
      runtime: 'system',
      archiveName: systemArchiveName,
      archivePath: path.join(distRoot, systemArchiveName),
      root: path.join(systemParentRoot, releaseRootName),
    },
  };
}

export function renderReleaseInfoCommand(metadata: ReleaseMetadata): string {
  return [
    '@echo off',
    `set "YMB_REQUIRED_BUN=${metadata.requiredBunVersion}"`,
    `set "YMB_FULL_RELEASE_URL=${metadata.fullReleaseUrl}"`,
    '',
  ].join('\r\n');
}

export function createReleasePackageDefinition(metadata: ReleaseMetadata) {
  return {
    name: packageDefinition.name,
    version: metadata.version,
    private: true,
    type: 'module',
    engines: { bun: metadata.requiredBunVersion },
    exports: {
      './api': {
        types: './types/api.d.ts',
        import: './app/api.js',
        default: './app/api.js',
      },
    },
  };
}

export function renderReleaseNotes(metadata: ReleaseMetadata): string {
  return `## Which archive should I download?\n\n### Recommended: ${metadata.bundled.archiveName}\n\nChoose this archive unless you deliberately manage Bun yourself. It includes the exact Bun ${metadata.requiredBunVersion} runtime required by YMB and works without installing dependencies.\n\n### Smaller: ${metadata.system.archiveName}\n\nChoose this archive only when Bun ${metadata.requiredBunVersion} is already installed system-wide and available on PATH. The launcher checks the installed version and stops with a link to the full archive when Bun is missing or incompatible.\n\n## Install\n\n1. Download one archive above.\n2. Extract its top-level \`YMB\` folder beside your WARNO mod's \`GameData\` and \`CommonData\` folders.\n3. Double-click \`YMB.bat\`.\n4. Run \`doctor\`, then use \`validate\` and \`build\`.\n`;
}
