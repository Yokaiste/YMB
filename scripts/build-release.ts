import { copyFile, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import packageDefinition from '../package.json' with { type: 'json' };
import { BUILDER_CONFIG } from '../src/builder-config.ts';
import { runCapturedProcess } from './captured-process.ts';
import {
  createReleasePackageDefinition,
  getReleaseMetadata,
  RELEASE_BUNDLES,
  renderReleaseInfoCommand,
  renderReleaseNotes,
  resolveBundleExternals,
  resolveWindowsTarPath,
} from './release-metadata.ts';
import {
  collectBundledComponents,
  describeRuntimeComponent,
  renderThirdPartyNotices,
  THIRD_PARTY_NOTICES_FILE_NAME,
} from './third-party-notices.ts';

const repositoryRoot = path.resolve(import.meta.dir, '..');
const metadata = getReleaseMetadata(repositoryRoot);

if (process.platform !== 'win32') {
  throw new Error(
    'The portable YMB release currently targets Windows x64 and must be built on Windows.',
  );
}
if (Bun.version !== metadata.requiredBunVersion) {
  throw new Error(
    `Build runtime ${Bun.version} does not match packageManager bun@${metadata.requiredBunVersion}.`,
  );
}

// Resolved before anything is written, so an undeclared third-party license stops
// the build instead of producing archives that attribute nothing.
const bundledComponents = collectBundledComponents(
  repositoryRoot,
  Object.keys(packageDefinition.dependencies),
);
const bundledRuntimeNotices = renderThirdPartyNotices({
  components: bundledComponents,
  runtime: describeRuntimeComponent(metadata.requiredBunVersion),
});
const systemRuntimeNotices = renderThirdPartyNotices({ components: bundledComponents });

await rm(metadata.distRoot, { recursive: true, force: true });
await Promise.all([
  mkdir(metadata.appRoot, { recursive: true }),
  mkdir(metadata.runtimeRoot, { recursive: true }),
  mkdir(metadata.typesRoot, { recursive: true }),
  mkdir(path.join(metadata.releaseRoot, 'mods'), { recursive: true }),
]);

await Promise.all(
  RELEASE_BUNDLES.map(({ entrypoint, outputName }) => bundle(entrypoint, outputName)),
);

await emitApiDeclarations();
await Promise.all([
  cp(path.join(repositoryRoot, 'docs'), path.join(metadata.releaseRoot, 'docs'), {
    recursive: true,
  }),
  copyFile(path.join(repositoryRoot, 'README.md'), path.join(metadata.releaseRoot, 'README.md')),
  copyFile(path.join(repositoryRoot, 'LICENSE'), path.join(metadata.releaseRoot, 'LICENSE')),
  copyFile(path.join(repositoryRoot, 'NOTICE'), path.join(metadata.releaseRoot, 'NOTICE')),
  copyFile(
    path.join(repositoryRoot, 'release', 'YMB.bat'),
    path.join(metadata.releaseRoot, 'YMB.bat'),
  ),
  copyFile(
    path.join(repositoryRoot, 'release', 'shell-init.cmd'),
    path.join(metadata.appRoot, 'shell-init.cmd'),
  ),
  copyFile(
    path.join(repositoryRoot, 'release', 'resolve-bun.cmd'),
    path.join(metadata.appRoot, 'resolve-bun.cmd'),
  ),
  copyFile(
    path.join(repositoryRoot, 'release', 'mods-README.md'),
    path.join(metadata.releaseRoot, 'mods', 'README.md'),
  ),
  // Shipped fully commented out, so it documents every setting and pins the
  // builder root without changing any default.
  copyFile(
    path.join(repositoryRoot, BUILDER_CONFIG.builderConfigFileName),
    path.join(metadata.releaseRoot, BUILDER_CONFIG.builderConfigFileName),
  ),
  copyFile(process.execPath, path.join(metadata.runtimeRoot, 'bun.exe')),
  writeFile(
    path.join(metadata.releaseRoot, THIRD_PARTY_NOTICES_FILE_NAME),
    bundledRuntimeNotices,
    'utf8',
  ),
]);

await writeFile(
  path.join(metadata.appRoot, 'release-info.cmd'),
  renderReleaseInfoCommand(metadata),
  'utf8',
);

await writeFile(
  path.join(metadata.releaseRoot, 'package.json'),
  `${JSON.stringify(createReleasePackageDefinition(metadata), undefined, 2)}\n`,
  'utf8',
);

await cp(metadata.releaseRoot, metadata.system.root, { recursive: true });
await rm(path.join(metadata.system.root, 'runtime'), { recursive: true, force: true });
// The no-Bun archive ships no runtime, so it must not claim to attribute one.
await writeFile(
  path.join(metadata.system.root, THIRD_PARTY_NOTICES_FILE_NAME),
  systemRuntimeNotices,
  'utf8',
);
await Promise.all([
  createArchive(metadata.distRoot, metadata.bundled.archivePath),
  createArchive(metadata.systemParentRoot, metadata.system.archivePath),
  writeReleaseNotes(),
]);

const appBytes = await directorySize(metadata.appRoot);
const archiveBytes = Bun.file(metadata.bundled.archivePath).size;
const slimArchiveBytes = Bun.file(metadata.system.archivePath).size;
console.log(`Portable YMB ready: ${metadata.releaseRoot}`);
console.log(`Full archive: ${metadata.bundled.archivePath}`);
console.log(`No-Bun archive: ${metadata.system.archivePath}`);
console.log(
  `Minified app: ${formatBytes(appBytes)} | full: ${formatBytes(archiveBytes)} | no-Bun: ${formatBytes(slimArchiveBytes)}`,
);

async function bundle(entrypoint: string, outputName: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [path.join(repositoryRoot, entrypoint)],
    outdir: metadata.appRoot,
    naming: outputName,
    target: 'bun',
    format: 'esm',
    minify: true,
    sourcemap: 'none',
    external: resolveBundleExternals(outputName),
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `Failed to bundle ${entrypoint}.`);
  }
}

async function emitApiDeclarations(): Promise<void> {
  const compilerPath = path.join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  const { exitCode, stdout, stderr } = await runCapturedProcess(
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
      metadata.typesRoot,
      path.join(repositoryRoot, 'src', 'api.ts'),
    ],
    { cwd: repositoryRoot },
  );
  if (exitCode !== 0) {
    throw new Error(`Failed to emit ymb/api declarations: ${stderr.trim() || stdout.trim()}`);
  }
}

async function createArchive(sourceParent: string, destination: string): Promise<void> {
  const { exitCode, stdout, stderr } = await runCapturedProcess(
    [resolveWindowsTarPath(), '-a', '-c', '-f', destination, 'YMB'],
    { cwd: sourceParent },
  );
  if (exitCode !== 0) {
    throw new Error(`Failed to create ZIP archive: ${stderr.trim() || stdout.trim()}`);
  }
}

async function writeReleaseNotes(): Promise<void> {
  await writeFile(metadata.notesPath, renderReleaseNotes(metadata), 'utf8');
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
