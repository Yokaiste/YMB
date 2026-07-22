import { describe, expect, test } from 'bun:test';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { CLI_COMMAND_NAMES } from '../src/cli-guide.ts';

const repositoryRoot = path.resolve(import.meta.dir, '..');

describe('portable release assets', () => {
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

  test('master checks publish both archives to a versioned GitHub release', async () => {
    const workflow = await readFile(
      path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'),
      'utf8',
    );
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('push:');
    expect(workflow).toContain("github.ref == 'refs/heads/master'");
    expect(workflow).toContain('actions/checkout@v6');
    expect(workflow).toContain('oven-sh/setup-bun@v2');
    expect(workflow).toContain('bun install --frozen-lockfile');
    expect(workflow).toContain('bun run check');
    expect(workflow).toContain('bun run build');
    expect(workflow).toContain('bun run verify:release');
    expect(workflow).not.toContain('workflow_dispatch:');
    expect(workflow).toContain('gh release edit $tag --latest');
    expect(workflow).toContain('gh release upload $tag $fullArchive $noBunArchive --clobber');
    expect(workflow).toContain('gh release create $tag $fullArchive $noBunArchive');
    expect(workflow).toContain('YMB-v$version-windows-x64.zip');
    expect(workflow).toContain('YMB-v$version-windows-x64-no-bun.zip');
    expect(workflow).toContain('--notes-file $notes');
    expect(workflow).toContain('--latest');
    expect(workflow).not.toContain('actions/upload-artifact');
    expect(() => parse(workflow)).not.toThrow();

    for (const removedWorkflow of ['check.yml', 'release.yml']) {
      const entry = await stat(
        path.join(repositoryRoot, '.github', 'workflows', removedWorkflow),
      ).catch(() => undefined);
      expect(entry).toBeUndefined();
    }
  });
});
