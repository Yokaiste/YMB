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
      `Cannot find Windows tar at ${tarPath}. Restore the Windows tar.exe before building or checking release archives.`,
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
  'AGENTS.md',
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
  const requiredBunVersion = Bun.version;

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
  return `## Download

| Archive | Choose it when |
| --- | --- |
| **${metadata.bundled.archiveName}** | You want to start modding. Includes Bun ${metadata.requiredBunVersion}; no separate runtime installation. |
| ${metadata.system.archiveName} | You already have exactly Bun ${metadata.requiredBunVersion} on PATH. Smaller download, same builder. |

Both packages are for Windows x64. The launcher checks Bun's version and points you to the full package if it cannot use your installation.

## First install

1. Create a mod folder with WARNO's modding tools if you do not have one yet.
2. Download an archive above and extract its \`YMB\` folder beside that mod's \`GameData\` and \`CommonData\` folders. Open the extracted folder, not the ZIP.
3. Double-click \`YMB.bat\`. Run \`init\` for a starter project, or put an author's editable mod project in \`YMB/mods/\`.
4. Run \`doctor\` to check the paths and discovered projects.
5. Run \`build\` and inspect the preview in \`YMB/.ymb-build/output/\`.
6. When the preview is ready, run \`sync --yes\`. Then run \`GenerateMod.bat\` in the WARNO mod folder and enable the mod in the game.

Start with \`docs/getting-started.md\` to put your mod's title on WARNO's menu. Continue in the same project with unit-health edits, bulk rules, settings, and scripts. \`docs/README.md\` gives the lesson order; \`AGENTS.md\` guides agents working on mod projects. YMB builds the editable game files; WARNO's tools compile them for play.

## Update an existing installation

Back up the current YMB folder first. Extract into a separate folder, then replace the old installation's tool files with the new package. Keep your \`mods/\`, \`ymb.config.yaml\`, and recovery folder (\`.ymb-state/\` by default). Do not overwrite your config with the empty one from the download.

When switching from the full package to no-Bun, remove the old \`YMB/runtime/\` folder after backing it up. The launcher prefers that bundled runtime over Bun on PATH.

Open the updated launcher, run \`doctor\`, and make a new preview with \`build\` before applying it. A WARNO game update also needs its mod data refreshed; follow \`docs/workflow.md\` for that sequence.

## For scripts and AI agents: JSON output changed

\`--json\` now returns \`schemaVersion: 2\`. Successful commands put their results in \`data\`; selection-based commands also return \`selection\`. Read paths, counts, and recovery actions there. The duplicate human report fields \`summary\`, \`details\`, \`locations\`, and \`nextSteps\` have been removed, along with init's top-level \`created\` and \`modsRoot\` fields. Errors keep their structured \`errors\` array. Update consumers that read the removed fields; the command names and config keys are unchanged.

Sync's \`data.deletions\` now contains \`{path, action}\` records instead of path strings. File actions, obsolete files, resets, and backup cleanup are available as structured data.

JSON mode also rejects conflicts that need a decision instead of opening an interactive prompt. Set the project's ordering explicitly and run again. See the included \`docs/workflow.md\` for the version 2 fields and migration steps.

## Help and credits

Use [YSM Community Discord](https://discord.gg/33Sqn6dTjf) for help, feedback, and bug reports. For a failure, post in its troubleshooting forum with your YMB version, command, and error.

YMB's terms are in \`LICENSE\`; bundled software is listed in \`THIRD-PARTY-NOTICES.md\`. Public mods built with YMB must credit it with a working [source link](https://github.com/Yokaiste/YMB).
`;
}
