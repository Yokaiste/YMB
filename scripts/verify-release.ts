import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import packageDefinition from '../package.json' with { type: 'json' };
import { type CapturedProcessResult, runCapturedProcess } from './captured-process.ts';
import {
  API_BUNDLE_OUTPUT_NAME,
  API_MODULE_SPECIFIER,
  getReleaseMetadata,
  RELEASE_BUNDLES,
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
  if (!help.includes('Usage: ymb') || !help.includes('New here? Do this:')) {
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

  // The importer has to sit inside the release root for `ymb/api` to resolve
  // through the shipped `package.json` exports.
  const smokePath = path.join(absoluteRoot, 'mods', `.api-smoke-${randomUUID()}.ts`);
  await writeFile(
    smokePath,
    [
      `import { ScriptToolError } from '${API_MODULE_SPECIFIER}';`,
      `import * as shipped from '../app/${API_BUNDLE_OUTPUT_NAME}';`,
      "const error = new ScriptToolError({ reason: 'smoke', suggestion: 'smoke' });",
      "if (error.name !== 'ScriptToolError') process.exit(1);",
      // Every bundle imports the same specifier a mod script does, so the
      // exports map has to land on the one shipped module. Two modules here
      // means two classes, and `instanceof` between builder and mod is false.
      'if (shipped.ScriptToolError !== ScriptToolError) process.exit(2);',
      'if (!(error instanceof shipped.ScriptToolError)) process.exit(3);',
    ].join('\n'),
    'utf8',
  );
  try {
    await run([bunPath, smokePath], absoluteRoot);
  } finally {
    await rm(smokePath, { force: true });
  }
  await verifySingleApiInstance(absoluteRoot);

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
  } finally {
    await rm(extractRoot, { recursive: true, force: true });
  }
}

/**
 * The builder and a mod script only agree about `ScriptToolError` while there is a
 * single copy of it. A bundler that inlines it produces one class per bundle, none
 * `instanceof` any other. Invisible from source, where every import lands on the
 * same file, so it is checked against the built bundles.
 */
async function verifySingleApiInstance(releaseRoot: string): Promise<void> {
  for (const { outputName } of RELEASE_BUNDLES) {
    const bundle = await readFile(path.join(releaseRoot, 'app', outputName), 'utf8');
    const definesClass = containsStringLiteral(bundle, 'ScriptToolError');

    if (outputName === API_BUNDLE_OUTPUT_NAME) {
      if (!definesClass) {
        throw new Error(
          `app/${outputName} no longer defines ScriptToolError, so mod scripts import nothing to compare against.`,
        );
      }
      continue;
    }
    if (definesClass) {
      throw new Error(
        `app/${outputName} carries its own copy of ScriptToolError instead of importing ${API_MODULE_SPECIFIER}, so \`instanceof\` between it and app/${API_BUNDLE_OUTPUT_NAME} is always false.`,
      );
    }
    if (
      bundle.includes('ScriptToolError') &&
      !containsStringLiteral(bundle, API_MODULE_SPECIFIER)
    ) {
      throw new Error(
        `app/${outputName} uses ScriptToolError without importing ${API_MODULE_SPECIFIER}.`,
      );
    }
  }
}

/** Minified output quotes either way, and only a definition writes the name. */
function containsStringLiteral(bundle: string, value: string): boolean {
  return bundle.includes(`"${value}"`) || bundle.includes(`'${value}'`);
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

    assertRejectedBun(withoutSystemBun, 'was not found on PATH', 'a missing system Bun');

    // A `bun.exe` that cannot report the required version stands in for every
    // wrong-version install: the resolver reads no version and must refuse.
    await writeFile(path.join(stubRoot, 'bun.exe'), 'not a real executable', 'utf8');
    const wrongBun = await runResolver(resolverPath, releaseRoot, `${stubRoot};${systemOnlyPath}`);
    assertRejectedBun(wrongBun, 'YMB needs Bun', 'a system Bun of the wrong version');
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

function assertRejectedBun(
  result: { exitCode: number; output: string },
  expectedFragment: string,
  situation: string,
): void {
  if (result.exitCode === 0) {
    throw new Error(`The release runtime resolver accepted ${situation}.`);
  }
  if (
    !result.output.includes(expectedFragment) ||
    !result.output.includes(metadata.fullReleaseUrl)
  ) {
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
