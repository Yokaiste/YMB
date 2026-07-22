import { copyFile, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import packageDefinition from '../package.json' with { type: 'json' };
import { verifyRelease } from './verify-release.ts';

const repositoryRoot = path.resolve(import.meta.dir, '..');
const distRoot = path.join(repositoryRoot, 'dist');
const releaseRoot = path.join(distRoot, 'YMB');
const appRoot = path.join(releaseRoot, 'app');
const runtimeRoot = path.join(releaseRoot, 'runtime');
const typesRoot = path.join(releaseRoot, 'types');
const slimParentRoot = path.join(distRoot, 'no-bun');
const slimReleaseRoot = path.join(slimParentRoot, 'YMB');
const requiredBunVersion = packageDefinition.packageManager.replace(/^bun@/, '');
const archiveName = `YMB-v${packageDefinition.version}-windows-x64.zip`;
const archivePath = path.join(distRoot, archiveName);
const slimArchiveName = `YMB-v${packageDefinition.version}-windows-x64-no-bun.zip`;
const slimArchivePath = path.join(distRoot, slimArchiveName);
const fullReleaseUrl = `${packageDefinition.homepage}/releases/download/v${packageDefinition.version}/${archiveName}`;
const releaseNotesPath = path.join(distRoot, 'release-notes.md');

if (process.platform !== 'win32') {
  throw new Error(
    'The portable YMB release currently targets Windows x64 and must be built on Windows.',
  );
}
if (Bun.version !== requiredBunVersion) {
  throw new Error(
    `Build runtime ${Bun.version} does not match packageManager bun@${requiredBunVersion}.`,
  );
}

await rm(distRoot, { recursive: true, force: true });
await Promise.all([
  mkdir(appRoot, { recursive: true }),
  mkdir(runtimeRoot, { recursive: true }),
  mkdir(typesRoot, { recursive: true }),
  mkdir(path.join(releaseRoot, 'mods'), { recursive: true }),
]);

await Promise.all([
  bundle('index.ts', 'ymb.js'),
  bundle('src/api.ts', 'api.js'),
  bundle('src/scripts/runtime-child.ts', 'runtime-child.js'),
  bundle('src/scripts/test-runtime-child.ts', 'test-runtime-child.js'),
  bundle('src/engine/patch-runtime-child.ts', 'patch-runtime-child.js'),
]);

await emitApiDeclarations();
await Promise.all([
  cp(path.join(repositoryRoot, 'docs'), path.join(releaseRoot, 'docs'), { recursive: true }),
  copyFile(path.join(repositoryRoot, 'README.md'), path.join(releaseRoot, 'README.md')),
  copyFile(path.join(repositoryRoot, 'LICENSE'), path.join(releaseRoot, 'LICENSE')),
  copyFile(path.join(repositoryRoot, 'NOTICE'), path.join(releaseRoot, 'NOTICE')),
  copyFile(path.join(repositoryRoot, 'release', 'YMB.bat'), path.join(releaseRoot, 'YMB.bat')),
  copyFile(
    path.join(repositoryRoot, 'release', 'shell-init.cmd'),
    path.join(appRoot, 'shell-init.cmd'),
  ),
  copyFile(
    path.join(repositoryRoot, 'release', 'resolve-bun.cmd'),
    path.join(appRoot, 'resolve-bun.cmd'),
  ),
  copyFile(
    path.join(repositoryRoot, 'release', 'mods-README.md'),
    path.join(releaseRoot, 'mods', 'README.md'),
  ),
  copyFile(process.execPath, path.join(runtimeRoot, 'bun.exe')),
]);

await writeFile(
  path.join(appRoot, 'release-info.cmd'),
  [
    '@echo off',
    `set "YMB_REQUIRED_BUN=${requiredBunVersion}"`,
    `set "YMB_FULL_RELEASE_URL=${fullReleaseUrl}"`,
    '',
  ].join('\r\n'),
  'utf8',
);

await writeFile(
  path.join(releaseRoot, 'package.json'),
  `${JSON.stringify(
    {
      name: packageDefinition.name,
      version: packageDefinition.version,
      private: true,
      type: 'module',
      engines: { bun: requiredBunVersion },
      exports: {
        './api': {
          types: './types/api.d.ts',
          import: './app/api.js',
          default: './app/api.js',
        },
      },
    },
    undefined,
    2,
  )}\n`,
  'utf8',
);

await verifyRelease(releaseRoot, { runtime: 'bundled' });
await cp(releaseRoot, slimReleaseRoot, { recursive: true });
await rm(path.join(slimReleaseRoot, 'runtime'), { recursive: true, force: true });
await verifyRelease(slimReleaseRoot, { runtime: 'system' });
await Promise.all([
  createArchive(distRoot, archivePath),
  createArchive(slimParentRoot, slimArchivePath),
  writeReleaseNotes(),
]);

const appBytes = await directorySize(appRoot);
const archiveBytes = Bun.file(archivePath).size;
const slimArchiveBytes = Bun.file(slimArchivePath).size;
console.log(`Portable YMB ready: ${releaseRoot}`);
console.log(`Full archive: ${archivePath}`);
console.log(`No-Bun archive: ${slimArchivePath}`);
console.log(
  `Minified app: ${formatBytes(appBytes)} | full: ${formatBytes(archiveBytes)} | no-Bun: ${formatBytes(slimArchiveBytes)}`,
);

async function bundle(entrypoint: string, outputName: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [path.join(repositoryRoot, entrypoint)],
    outdir: appRoot,
    naming: outputName,
    target: 'bun',
    format: 'esm',
    minify: true,
    sourcemap: 'none',
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `Failed to bundle ${entrypoint}.`);
  }
}

async function emitApiDeclarations(): Promise<void> {
  const compilerPath = path.join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  const child = Bun.spawn(
    [
      process.execPath,
      compilerPath,
      '--ignoreConfig',
      '--declaration',
      '--emitDeclarationOnly',
      '--module',
      'preserve',
      '--target',
      'esnext',
      '--skipLibCheck',
      '--outDir',
      typesRoot,
      path.join(repositoryRoot, 'src', 'api.ts'),
    ],
    { cwd: repositoryRoot, stdout: 'pipe', stderr: 'pipe' },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Failed to emit ymb/api declarations: ${stderr.trim() || stdout.trim()}`);
  }
}

async function createArchive(sourceParent: string, destination: string): Promise<void> {
  const child = Bun.spawn(['tar.exe', '-a', '-c', '-f', destination, 'YMB'], {
    cwd: sourceParent,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Failed to create ZIP archive: ${stderr.trim() || stdout.trim()}`);
  }
}

async function writeReleaseNotes(): Promise<void> {
  await writeFile(
    releaseNotesPath,
    `# YMB ${packageDefinition.version}\n\n## Which archive should I download?\n\n### Recommended: ${archiveName}\n\nChoose this archive unless you deliberately manage Bun yourself. It includes the exact Bun ${requiredBunVersion} runtime required by YMB and works without installing dependencies.\n\n### Smaller: ${slimArchiveName}\n\nChoose this archive only when Bun ${requiredBunVersion} is already installed system-wide and available on PATH. The launcher checks the installed version and stops with a link to the full archive when Bun is missing or incompatible.\n\n## Install\n\n1. Download one archive above.\n2. Extract its top-level \`YMB\` folder beside your WARNO mod's \`GameData\` and \`CommonData\` folders.\n3. Double-click \`YMB.bat\`.\n4. Run \`doctor\`, then use \`validate\` and \`build\`.\n\nThe full archive is the safest choice for most users.\n`,
    'utf8',
  );
}

async function directorySize(root: string): Promise<number> {
  const glob = new Bun.Glob('**/*');
  let size = 0;
  for await (const relativePath of glob.scan({ cwd: root, onlyFiles: true })) {
    size += Bun.file(path.join(root, relativePath)).size;
  }
  return size;
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}
