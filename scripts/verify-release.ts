import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import packageDefinition from '../package.json' with { type: 'json' };

const requiredRelativePaths = [
  'YMB.bat',
  'README.md',
  'LICENSE',
  'NOTICE',
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

interface VerifyReleaseOptions {
  runtime: 'bundled' | 'system';
}

export async function verifyRelease(
  releaseRoot: string,
  options: VerifyReleaseOptions,
): Promise<void> {
  const absoluteRoot = path.resolve(releaseRoot);
  for (const relativePath of requiredRelativePaths) {
    const entry = await stat(path.join(absoluteRoot, relativePath)).catch(() => undefined);
    if (!entry?.isFile()) {
      throw new Error(`Release is missing required file: ${relativePath}`);
    }
  }

  const requiredBunVersion = packageDefinition.packageManager.replace(/^bun@/, '');
  const fullArchiveName = `YMB-v${packageDefinition.version}-windows-x64.zip`;
  const releaseInfo = await readFile(path.join(absoluteRoot, 'app', 'release-info.cmd'), 'utf8');
  if (
    !releaseInfo.includes(`YMB_REQUIRED_BUN=${requiredBunVersion}`) ||
    !releaseInfo.includes(fullArchiveName)
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
  if (version !== requiredBunVersion) {
    throw new Error(
      `Portable Bun version ${version} does not match required ${requiredBunVersion}.`,
    );
  }

  const help = await run([bunPath, cliPath, '--help'], absoluteRoot);
  if (!help.includes('Usage: ymb') || !help.includes('Recommended Flow:')) {
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
  }

  const smokeRoot = await mkdtemp(path.join(tmpdir(), 'ymb-release-smoke-'));
  try {
    const smokePath = path.join(absoluteRoot, 'mods', `.api-smoke-${path.basename(smokeRoot)}.ts`);
    await writeFile(
      smokePath,
      [
        "import { ScriptToolError } from 'ymb/api';",
        "const error = new ScriptToolError({ reason: 'smoke', suggestion: 'smoke' });",
        "if (error.name !== 'ScriptToolError') process.exit(1);",
      ].join('\n'),
      'utf8',
    );
    try {
      await run([bunPath, smokePath], absoluteRoot);
    } finally {
      await rm(smokePath, { force: true });
    }
  } finally {
    await rm(smokeRoot, { recursive: true, force: true });
  }

  const releasePackage = JSON.parse(
    await readFile(path.join(absoluteRoot, 'package.json'), 'utf8'),
  );
  if (releasePackage.version !== packageDefinition.version) {
    throw new Error('Release package version does not match the source package version.');
  }
}

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command[0]} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  }
  return stdout;
}

if (import.meta.main) {
  const explicitRoot = process.argv[2];
  if (explicitRoot) {
    const runtime = process.argv.includes('--system-bun') ? 'system' : 'bundled';
    await verifyRelease(explicitRoot, { runtime });
    console.log(`Verified ${runtime} release: ${path.resolve(explicitRoot)}`);
  } else {
    const distRoot = path.join(import.meta.dir, '..', 'dist');
    const fullRoot = path.join(distRoot, 'YMB');
    const slimRoot = path.join(distRoot, 'no-bun', 'YMB');
    await verifyRelease(fullRoot, { runtime: 'bundled' });
    await verifyRelease(slimRoot, { runtime: 'system' });
    console.log(`Verified full release: ${path.resolve(fullRoot)}`);
    console.log(`Verified no-Bun release: ${path.resolve(slimRoot)}`);
  }
}
