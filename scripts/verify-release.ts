import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import packageDefinition from '../package.json' with { type: 'json' };
import { BUILDER_CONFIG, createDefaultBuilderProjectConfig } from '../src/builder-config.ts';
import { loadBuilderProjectConfig } from '../src/config/load.ts';
import { type CapturedProcessResult, runCapturedProcess } from './captured-process.ts';
import {
  API_MODULE_SPECIFIER,
  getReleaseMetadata,
  RELEASE_REQUIRED_FILES,
  type ReleaseRuntime,
  resolveWindowsTarPath,
} from './release-metadata.ts';
import {
  collectBundledComponents,
  describeRuntimeComponent,
  THIRD_PARTY_NOTICES_FILE_NAME,
} from './third-party-notices.ts';

const repositoryRoot = path.resolve(import.meta.dir, '..');
const metadata = getReleaseMetadata(repositoryRoot);

interface VerifyReleaseOptions {
  runtime: ReleaseRuntime;
}

async function verifyRelease(releaseRoot: string, options: VerifyReleaseOptions): Promise<void> {
  const absoluteRoot = path.resolve(releaseRoot);
  for (const relativePath of RELEASE_REQUIRED_FILES) {
    const entry = await stat(path.join(absoluteRoot, relativePath)).catch(() => undefined);
    if (!entry?.isFile()) {
      throw new Error(`Release is missing required file: ${relativePath}`);
    }
  }

  assert.deepEqual(
    await loadBuilderProjectConfig(path.join(absoluteRoot, BUILDER_CONFIG.builderConfigFileName)),
    createDefaultBuilderProjectConfig(),
    'A release must not contain local customization or machine paths.',
  );

  await verifyThirdPartyNotices(absoluteRoot, options, metadata.requiredBunVersion);

  const releaseInfo = await readFile(path.join(absoluteRoot, 'app', 'release-info.cmd'), 'utf8');
  if (
    !releaseInfo.includes(`YMB_REQUIRED_BUN=${metadata.requiredBunVersion}`) ||
    !releaseInfo.includes(metadata.bundled.archiveName)
  ) {
    throw new Error('Release runtime metadata does not identify the required Bun or full archive.');
  }
  const bundledBunPath = path.join(absoluteRoot, 'runtime', 'bun.exe');
  const bundledBun = await stat(bundledBunPath).catch(() => undefined);
  if (options.runtime === 'bundled' && !bundledBun?.isFile()) {
    throw new Error('Full release is missing runtime/bun.exe.');
  }
  if (options.runtime === 'system' && bundledBun) {
    throw new Error('No-Bun release unexpectedly contains runtime/bun.exe.');
  }
  const bunPath = options.runtime === 'bundled' ? bundledBunPath : 'bun';
  const cliPath = path.join(absoluteRoot, 'app', 'ymb.js');
  const version = (await run([bunPath, '--version'], absoluteRoot)).trim();
  if (version !== metadata.requiredBunVersion) {
    throw new Error(
      `Portable Bun version ${version} does not match required ${metadata.requiredBunVersion}.`,
    );
  }

  const help = await run([bunPath, cliPath, '--help'], absoluteRoot);
  if (!help.includes('Usage: ymb') || !help.includes('--help')) {
    throw new Error('Bundled YMB help did not render the expected command guide.');
  }

  if (process.platform === 'win32') {
    const launcherHelp = await run(
      ['cmd.exe', '/d', '/c', path.join(absoluteRoot, 'YMB.bat'), '--help'],
      absoluteRoot,
    );
    if (!launcherHelp.includes('Usage: ymb')) {
      throw new Error('Release launcher did not render YMB help.');
    }
    await verifyBunResolution(absoluteRoot, options);
  }

  await verifyPackagedBuild(absoluteRoot, bunPath, cliPath);

  const releasePackage = JSON.parse(
    await readFile(path.join(absoluteRoot, 'package.json'), 'utf8'),
  );
  if (releasePackage.version !== metadata.version) {
    throw new Error('Release package version does not match the source package version.');
  }
}

async function verifyReleaseArchive(
  archivePath: string,
  options: VerifyReleaseOptions,
): Promise<void> {
  const absoluteArchivePath = path.resolve(archivePath);
  const archive = await stat(absoluteArchivePath).catch(() => undefined);
  if (!archive?.isFile()) {
    throw new Error(`Release archive is missing: ${absoluteArchivePath}`);
  }

  const extractRoot = await mkdtemp(path.join(tmpdir(), 'ymb-release-archive-'));
  try {
    await extractArchive(absoluteArchivePath, extractRoot);
    const releaseRoot = path.join(extractRoot, metadata.releaseRootName);
    if (!(await stat(path.join(releaseRoot, 'YMB.bat')).catch(() => undefined))?.isFile()) {
      throw new Error(
        `${absoluteArchivePath} does not contain the top-level ${metadata.releaseRootName} folder.`,
      );
    }
    await verifyRelease(releaseRoot, options);
    if (process.platform === 'win32') {
      // CI TEMP can use an 8.3 alias while Bun resolves worker entrypoints to long paths.
      const shortRoot = (
        await run(['cmd.exe', '/d', '/c', 'for %I in (.) do @echo %~sI'], releaseRoot)
      ).trim();
      await verifyPackagedBuild(
        shortRoot,
        options.runtime === 'bundled' ? path.join(releaseRoot, 'runtime', 'bun.exe') : 'bun',
        path.join(releaseRoot, 'app', 'ymb.js'),
      );
    }
  } finally {
    await rm(extractRoot, { recursive: true, force: true });
  }
}

/** Exercise every worker and the public API through a disposable preview build. */
async function verifyPackagedBuild(
  releaseRoot: string,
  bunPath: string,
  cliPath: string,
): Promise<void> {
  // Kept under the release so mod imports resolve through its own package exports.
  const fixtureRoot = await mkdtemp(path.join(releaseRoot, 'mods', '.release-smoke-'));
  const builderRoot = path.join(fixtureRoot, 'YMB');
  const patchRoot = path.join(builderRoot, 'mods', 'sample', 'config', 'patch', 'sample');
  const input = 'Item is TItem (\n    Value = 1\n)\n';
  try {
    await mkdir(path.join(fixtureRoot, 'GameData'), { recursive: true });
    await mkdir(path.join(fixtureRoot, 'CommonData'), { recursive: true });
    await mkdir(patchRoot, { recursive: true });
    await Bun.write(path.join(fixtureRoot, 'GameData', 'input.ndf'), input);
    await Bun.write(path.join(builderRoot, 'ymb.config.yaml'), 'version: 1\n');
    await Bun.write(
      path.join(patchRoot, '..', '..', 'ymb.mod.yaml'),
      'version: 1\nid: sample\nname: Sample\n',
    );
    await Bun.write(
      path.join(patchRoot, 'ymb.patch.yaml'),
      `version: 1
id: sample.patch
name: Sample patch
scope: prod
targets:
  - file: GameData/input.ndf
    operations:
      - op: modify
        selector: { kind: field, by: path, value: Item.Value }
        value: 2
scripts:
  - path: generate.ts
    tests: [generate.test.ts]
`,
    );
    await Bun.write(
      path.join(patchRoot, 'generate.ts'),
      `import { ScriptToolError } from '${API_MODULE_SPECIFIER}';
export function checkApi(tools) {
  try { tools.values.string(123, 'sample'); }
  catch (error) {
    if (error instanceof ScriptToolError) return;
    throw new Error('The packaged worker and mod script must share ScriptToolError.');
  }
  throw new Error('Invalid input must be rejected.');
}
export default async function generate(context) {
  checkApi(context.tools);
  const content = await context.readTarget('GameData/input.ndf');
  context.tools.assert.ok(context.tools.ndf.readPath(content, 'Value') === '2', {
    reason: 'The script did not receive the patched input.', suggestion: 'Check worker composition.',
  });
  return { targetRelativePath: 'CommonData/output.ndf', content };
}
`,
    );
    await Bun.write(
      path.join(patchRoot, 'generate.test.ts'),
      `import { checkApi } from './generate.ts';
export default function test(context) {
  checkApi(context.tools);
  return { results: [{ name: 'shared API', status: 'passed' }] };
}
`,
    );
    const result = JSON.parse(
      await run(
        [bunPath, cliPath, 'build', '--ymb-path', builderRoot, '--no-cache', '--json'],
        releaseRoot,
      ),
    );
    assert.equal(result.ok, true);
    assert.equal(result.data.counts.files, 2);
    assert.equal(result.data.counts.scriptTests, 1);
    const output = await Bun.file(
      path.join(builderRoot, '.ymb-build', 'output', 'CommonData', 'output.ndf'),
    ).text();
    assert.match(output, /Value = 2/);
    assert.equal(await Bun.file(path.join(fixtureRoot, 'GameData', 'input.ndf')).text(), input);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

/**
 * A release that ships someone else's code must at least say so and point at their
 * terms, so this is checked with the same weight as a missing binary.
 */
async function verifyThirdPartyNotices(
  releaseRoot: string,
  options: VerifyReleaseOptions,
  requiredBunVersion: string,
): Promise<void> {
  const notices = await readFile(path.join(releaseRoot, THIRD_PARTY_NOTICES_FILE_NAME), 'utf8');
  const components = collectBundledComponents(
    repositoryRoot,
    Object.keys(packageDefinition.dependencies),
  );

  for (const component of components) {
    if (!notices.includes(`| ${component.name} | ${component.version} |`)) {
      throw new Error(
        `${THIRD_PARTY_NOTICES_FILE_NAME} does not attribute bundled ${component.name} ${component.version}.`,
      );
    }
    if (!notices.includes(`<${component.url}>`)) {
      throw new Error(
        `${THIRD_PARTY_NOTICES_FILE_NAME} does not link the ${component.licenseId} terms of ${component.name}.`,
      );
    }
  }

  const runtime = describeRuntimeComponent(requiredBunVersion);
  const attributesRuntime = notices.includes(`<${runtime.url}>`);
  if (options.runtime === 'bundled' && !attributesRuntime) {
    throw new Error(
      `Full release ships runtime/bun.exe but ${THIRD_PARTY_NOTICES_FILE_NAME} does not link the terms of Bun ${requiredBunVersion}.`,
    );
  }
  if (options.runtime === 'system' && attributesRuntime) {
    throw new Error(
      `No-Bun release ships no runtime but ${THIRD_PARTY_NOTICES_FILE_NAME} claims to attribute one.`,
    );
  }
}

/**
 * `resolve-bun.cmd` prefers `runtime/bun.exe`, then `PATH`, then refuses. Both halves
 * fail invisibly on a machine that has Bun installed, and nothing in the TypeScript
 * suite can reach a `.cmd`, so the real resolver runs here against a built `PATH`.
 */
async function verifyBunResolution(
  releaseRoot: string,
  options: VerifyReleaseOptions,
): Promise<void> {
  const resolverPath = path.join(releaseRoot, 'app', 'resolve-bun.cmd');
  // `where.exe` itself lives in System32, so the resolver still genuinely searches -
  // it just finds nothing.
  const systemOnlyPath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const stubRoot = await mkdtemp(path.join(tmpdir(), 'ymb-bun-stub-'));

  try {
    const withoutSystemBun = await runResolver(resolverPath, releaseRoot, systemOnlyPath);

    if (options.runtime === 'bundled') {
      // The entire promise of the full archive: it works for someone who has never
      // installed Bun. Falling through to `PATH` here would still pass on a machine
      // that has one, so the check has to remove that machine's Bun first.
      if (withoutSystemBun.exitCode !== 0) {
        throw new Error(
          'The full release did not resolve its own bundled Bun when none was on PATH, so it is not self-contained.',
        );
      }
      return;
    }

    assertRejectedBun(withoutSystemBun, 'a missing system Bun');

    // A `bun.exe` that cannot report the required version stands in for every
    // wrong-version install: the resolver reads no version and must refuse.
    await writeFile(path.join(stubRoot, 'bun.exe'), 'not a real executable', 'utf8');
    const wrongBun = await runResolver(resolverPath, releaseRoot, `${stubRoot};${systemOnlyPath}`);
    assertRejectedBun(wrongBun, 'a system Bun of the wrong version');
  } finally {
    await rm(stubRoot, { recursive: true, force: true });
  }
}

function runResolver(
  resolverPath: string,
  releaseRoot: string,
  searchPath: string,
): Promise<CapturedProcessResult> {
  return runCapturedProcess(['cmd.exe', '/d', '/c', resolverPath], {
    cwd: releaseRoot,
    env: withSearchPath(releaseRoot, searchPath),
  });
}

/**
 * `cmd.exe` needs `SystemRoot` and `ComSpec` to start at all. Windows treats `PATH`
 * and `Path` as one variable, so every spelling is dropped before the replacement.
 */
function withSearchPath(releaseRoot: string, searchPath: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.toUpperCase() !== 'PATH') {
      env[key] = value;
    }
  }
  env.PATH = searchPath;
  env.YMB_HOME = releaseRoot;
  return env;
}

function assertRejectedBun(result: { exitCode: number; output: string }, situation: string): void {
  if (result.exitCode === 0) {
    throw new Error(`The release runtime resolver accepted ${situation}.`);
  }
  if (!result.output.includes(metadata.fullReleaseUrl)) {
    throw new Error(
      `The release runtime resolver rejected ${situation} without explaining how to fix it.`,
    );
  }
}

async function run(command: string[], cwd: string): Promise<string> {
  const result = await runCapturedProcess(command, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`${command[0]} failed (${result.exitCode}): ${result.output.trim()}`);
  }
  return result.stdout;
}

async function extractArchive(archivePath: string, destinationRoot: string): Promise<void> {
  const { exitCode, stdout, stderr } = await runCapturedProcess([
    resolveWindowsTarPath(),
    '-xf',
    archivePath,
    '-C',
    destinationRoot,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Failed to extract ${archivePath}: ${stderr.trim() || stdout.trim()}`);
  }
}

if (import.meta.main) {
  const explicitRoot = process.argv[2];
  if (explicitRoot) {
    const runtime = process.argv.includes('--system-bun') ? 'system' : 'bundled';
    await verifyRelease(explicitRoot, { runtime });
    console.log(`Verified ${runtime} release: ${path.resolve(explicitRoot)}`);
  } else {
    await verifyRelease(metadata.bundled.root, { runtime: 'bundled' });
    await verifyRelease(metadata.system.root, { runtime: 'system' });
    await verifyReleaseArchive(metadata.bundled.archivePath, { runtime: 'bundled' });
    await verifyReleaseArchive(metadata.system.archivePath, { runtime: 'system' });
    console.log(`Verified full release: ${path.resolve(metadata.bundled.root)}`);
    console.log(`Verified no-Bun release: ${path.resolve(metadata.system.root)}`);
    console.log(`Verified full archive: ${path.resolve(metadata.bundled.archivePath)}`);
    console.log(`Verified no-Bun archive: ${path.resolve(metadata.system.archivePath)}`);
  }
}
