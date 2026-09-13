import { stat } from 'node:fs/promises';
import path from 'node:path';
import { getReleaseMetadata, planReleaseCommands } from './release-metadata.ts';

const repositoryRoot = path.resolve(import.meta.dir, '..');
const metadata = getReleaseMetadata(repositoryRoot);

// Nothing already published may be removed before every new archive is known to
// exist, or a failed build would leave the tag with no downloads at all.
await assertReleaseInputsExist();

const commands = planReleaseCommands(metadata, {
  releaseExists: await releaseExists(metadata.tag),
  commitSha: process.env.GITHUB_SHA || 'HEAD',
});
for (const command of commands) {
  await run(command);
}
console.log(`Published ${metadata.tag} from package.json version ${metadata.version}.`);

async function assertReleaseInputsExist(): Promise<void> {
  for (const requiredPath of [
    metadata.bundled.archivePath,
    metadata.system.archivePath,
    metadata.notesPath,
  ]) {
    const entry = await stat(requiredPath).catch(() => undefined);
    if (!entry?.isFile()) {
      throw new Error(`Required release file is missing: ${requiredPath}`);
    }
  }
}

async function releaseExists(tag: string): Promise<boolean> {
  const child = Bun.spawn(['gh', 'release', 'view', tag], {
    cwd: repositoryRoot,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return (await child.exited) === 0;
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: repositoryRoot,
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command[0]} failed with exit code ${exitCode}.`);
  }
}
