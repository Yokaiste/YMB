import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { preparePlan, runBuild, runRecover, runSync } from '../src/engine/commands.ts';
import { materializeReplaceOutputs } from '../src/engine/materialize.ts';
import { YmbError } from '../src/errors.ts';
import { formatDetailLine } from '../src/report/detail.ts';
import { formatFindingGroups, toObsoleteTargetFindings } from '../src/report/findings.ts';
import {
  cleanupTempRoots,
  createSelection,
  summaryText,
  writeWorkspaceFiles,
} from './helpers/abstract-builder.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  await cleanupTempRoots(tempRoots);
});

interface FileOperationWorkspace {
  rootPath: string;
  builderPath: string;
  patchPath: string;
}

async function createWorkspace(
  patchConfig: string,
  files: Record<string, string | Uint8Array> = {},
): Promise<FileOperationWorkspace> {
  const containerPath = await mkdtemp(path.join(tmpdir(), 'ymb-files-'));
  tempRoots.push(containerPath);
  const rootPath = path.join(containerPath, 'LiveMod');
  const builderPath = path.join(rootPath, 'YMB');
  const patchPath = path.join(builderPath, 'mods', 'file-pack', 'config', 'patch', 'files');
  const siblingFiles = Object.fromEntries(
    Object.entries(files)
      .filter(([relativePath]) => relativePath.startsWith('ExampleAssets/'))
      .map(([relativePath, content]) => [relativePath, content]),
  );
  const modFiles = Object.fromEntries(
    Object.entries(files).filter(([relativePath]) => !relativePath.startsWith('ExampleAssets/')),
  );
  await writeWorkspaceFiles(rootPath, {
    'GameData/.keep': '',
    'CommonData/.keep': '',
    'YMB/mods/file-pack/config/ymb.mod.yaml': `version: 1
id: file_pack
name: File Pack
enabled: true
scripts: []
`,
    'YMB/mods/file-pack/config/patch/files/ymb.patch.yaml': patchConfig,
    ...modFiles,
  });
  await writeWorkspaceFiles(containerPath, siblingFiles);
  return { rootPath, builderPath, patchPath };
}

function patch(filesYaml: string, dependsOn = '[]'): string {
  return `version: 1
id: files.main
name: File operations
enabled: true
scope: prod
dependsOn: ${dependsOn}
files:
${filesYaml}
`;
}

async function expectPlanError(builderPath: string, expectedReason: string): Promise<YmbError> {
  try {
    await preparePlan(builderPath, createSelection({ dryRun: true }));
  } catch (error) {
    expect(error).toBeInstanceOf(YmbError);
    const ymbError = error as YmbError;
    expect(String(ymbError.context.reason).toLowerCase()).toContain(expectedReason.toLowerCase());
    return ymbError;
  }
  throw new Error(`Expected planning to fail with: ${expectedReason}`);
}

describe('file operation planning and materialization', () => {
  test('supports every source root, file and directory sources, templates, and binary bytes', async () => {
    const binary = new Uint8Array([0, 255, 4, 12]);
    const workspace = await createWorkspace(
      patch(`  - op: add
    source: { root: patch, path: assets/single.txt }
    destination: CommonData/Files/\${modId}.txt
    expect: { files: 1 }
  - op: copy
    source: { root: patch, path: assets/tree }
    destination: GameData/Files/tree
    expect: { files: 2 }
  - op: add
    source: { root: mod, path: mod.bin }
    destination: GameData/Files/mod.bin
  - op: copy
    source: { root: game, path: CommonData/Input/game.txt }
    destination: CommonData/Files/game.txt
  - op: add
    source: { root: exampleAssets, path: example.txt }
    destination: GameData/Files/example.txt
`),
      {
        'YMB/mods/file-pack/config/patch/files/assets/single.txt': 'hello ${modName}\n',
        'YMB/mods/file-pack/config/patch/files/assets/tree/a.txt': 'a',
        'YMB/mods/file-pack/config/patch/files/assets/tree/nested/b.bin': binary,
        'YMB/mods/file-pack/config/mod.bin': binary,
        'CommonData/Input/game.txt': 'from game ${modId}',
        'ExampleAssets/example.txt': 'from examples ${modId}',
      },
    );

    const plan = await preparePlan(workspace.builderPath, createSelection({ dryRun: true }));
    expect(plan.selectedReplaceFiles.map((file) => file.targetRelativePath)).toEqual([
      'CommonData/Files/file_pack.txt',
      'CommonData/Files/game.txt',
      'GameData/Files/example.txt',
      'GameData/Files/mod.bin',
      'GameData/Files/tree/a.txt',
      'GameData/Files/tree/nested/b.bin',
    ]);
    expect(plan.selectedReplaceFiles.every((file) => file.sourceType === 'file')).toBe(true);

    const result = await runBuild(workspace.builderPath, createSelection());
    // An exact byte copy cannot carry in-file markers by definition, so it is a
    // note rather than a warning and only appears under `--verbose`.
    expect(result.some((line) => line.startsWith('warning marker'))).toBe(false);
    expect(summaryText(result)).toContain('6 outputs without in-file markers');
    const verboseResult = await runBuild(workspace.builderPath, createSelection({ verbose: true }));
    expect(verboseResult.join('\n')).toContain('Exact byte copy');
    expect(
      await Bun.file(
        path.join(workspace.builderPath, '.ymb-build/output/CommonData/Files/file_pack.txt'),
      ).text(),
    ).toContain('hello File Pack');
    expect(
      new Uint8Array(
        await Bun.file(
          path.join(workspace.builderPath, '.ymb-build/output/GameData/Files/tree/nested/b.bin'),
        ).arrayBuffer(),
      ),
    ).toEqual(binary);
    expect(
      await Bun.file(
        path.join(workspace.builderPath, '.ymb-build/output/CommonData/Files/game.txt'),
      ).text(),
    ).toBe('from game ${modId}');
    expect(
      await Bun.file(
        path.join(workspace.builderPath, '.ymb-build/output/GameData/Files/example.txt'),
      ).text(),
    ).toBe('from examples ${modId}');
  });

  test('keeps external text byte-exact while validating every NDF destination', async () => {
    const validNdf = 'export ExactCopy is TDescriptor()\r\n';
    const workspace = await createWorkspace(
      patch(`  - op: copy
    source: { root: exampleAssets, path: exact.ndf }
    destination: GameData/Files/exact.ndf
  - op: copy
    source: { root: patch, path: invalid.bin }
    destination: GameData/Files/invalid.ndf
`),
      {
        'ExampleAssets/exact.ndf': validNdf,
        'YMB/mods/file-pack/config/patch/files/invalid.bin': 'export Broken is TDescriptor(\n',
      },
    );

    await expect(runBuild(workspace.builderPath, createSelection())).rejects.toBeInstanceOf(
      YmbError,
    );

    await Bun.write(
      path.join(workspace.patchPath, 'ymb.patch.yaml'),
      patch(`  - op: copy
    source: { root: exampleAssets, path: exact.ndf }
    destination: GameData/Files/exact.ndf
`),
    );
    await runBuild(workspace.builderPath, createSelection());
    expect(
      new Uint8Array(
        await Bun.file(
          path.join(workspace.builderPath, '.ymb-build/output/GameData/Files/exact.ndf'),
        ).arrayBuffer(),
      ),
    ).toEqual(new TextEncoder().encode(validNdf));
  });

  test('reports a structured error if a game source disappears after planning', async () => {
    const workspace = await createWorkspace(
      patch(`  - op: copy
    source: { root: game, path: GameData/source.txt }
    destination: GameData/copied.txt
`),
      { 'GameData/source.txt': 'source' },
    );
    const plan = await preparePlan(workspace.builderPath, createSelection({ dryRun: true }));
    await rm(path.join(workspace.rootPath, 'GameData/source.txt'));

    await expect(materializeReplaceOutputs(plan)).rejects.toMatchObject({
      context: expect.objectContaining({
        reason: expect.stringContaining('does not exist'),
      }),
    });
  });

  test('turns non-string path variables into structured path errors', async () => {
    const workspace = await createWorkspace(
      `version: 1
id: files.main
name: File operations
enabled: true
scope: prod
dependsOn: []
variables:
  badDestination: 42
files:
  - op: add
    source: { root: patch, path: source.txt }
    destination: \${badDestination}
`,
      { 'YMB/mods/file-pack/config/patch/files/source.txt': 'source' },
    );

    await expectPlanError(workspace.builderPath, 'Target path must stay inside');
  });

  test('enforces add/replace/remove preconditions and exact match counts', async () => {
    const cases = [
      {
        operation: `  - op: add
    source: { root: patch, path: source.txt }
    destination: GameData/existing.txt`,
        expected: 'requires absent target',
      },
      {
        operation: `  - op: replace
    source: { root: patch, path: source.txt }
    destination: GameData/missing.txt`,
        expected: 'requires existing target',
      },
      {
        operation: `  - op: add
    source: { root: patch, path: tree }
    destination: GameData/tree
    expect: { files: 3 }`,
        expected: 'expected 3 file(s), but matched 2',
      },
    ];

    for (const [index, item] of cases.entries()) {
      const workspace = await createWorkspace(patch(item.operation), {
        'YMB/mods/file-pack/config/patch/files/source.txt': 'source',
        'YMB/mods/file-pack/config/patch/files/tree/a.txt': 'a',
        'YMB/mods/file-pack/config/patch/files/tree/b.txt': 'b',
        'GameData/existing.txt': 'existing',
      });
      await expect(
        preparePlan(workspace.builderPath, createSelection({ dryRun: true })),
      ).rejects.toMatchObject({
        context: expect.objectContaining({
          operationIndex: 0,
          reason: expect.stringContaining(item.expected),
        }),
      });
      expect(index).toBeGreaterThanOrEqual(0);
    }
  });

  test('a removal with nothing left to remove is a warning, not a failure', async () => {
    const workspace = await createWorkspace(
      patch(`  - op: remove
    target: GameData/missing.txt`),
    );

    const buildLines = await runBuild(workspace.builderPath, createSelection());

    expect(buildLines).toContain(
      'warning  1 patch operation: No files at `GameData/missing.txt`. There was nothing to remove. Delete the operation if the game no longer ships this path, or fix the target if it should still match.',
    );
    // One occurrence, so what it found is already in the header above; the line
    // below names the patch and the config line of the operation to delete.
    const occurrence = buildLines.find((line) => line.includes('files.main'));
    expect(occurrence).toBe('           files.main  file-pack/config/patch/files/ymb.patch.yaml:8');
    expect(summaryText(buildLines)).toContain('1 warning');
  });

  test('lets copy create or overwrite destinations while preserving recovery state', async () => {
    const workspace = await createWorkspace(
      patch(`  - op: copy
    source: { root: patch, path: source.txt }
    destination: GameData/existing.txt
  - op: copy
    source: { root: patch, path: source.txt }
    destination: GameData/new.txt
`),
      {
        'GameData/existing.txt': 'original',
        'YMB/mods/file-pack/config/patch/files/source.txt': 'copied',
      },
    );
    await runSync(workspace.builderPath, createSelection());
    expect(await Bun.file(path.join(workspace.rootPath, 'GameData/existing.txt')).text()).toContain(
      'copied',
    );
    expect(await Bun.file(path.join(workspace.rootPath, 'GameData/new.txt')).text()).toContain(
      'copied',
    );
    await runRecover(workspace.builderPath, createSelection());
    expect(await Bun.file(path.join(workspace.rootPath, 'GameData/existing.txt')).text()).toBe(
      'original',
    );
    expect(await Bun.file(path.join(workspace.rootPath, 'GameData/new.txt')).exists()).toBe(false);
  });

  test('applies ordered operations virtually and cancels add-then-remove no-ops', async () => {
    const workspace = await createWorkspace(
      patch(`  - op: remove
    target: GameData/base.txt
  - op: add
    source: { root: patch, path: first.txt }
    destination: GameData/base.txt
  - op: add
    source: { root: patch, path: first.txt }
    destination: GameData/new.txt
  - op: replace
    source: { root: patch, path: second.txt }
    destination: GameData/new.txt
  - op: add
    source: { root: patch, path: first.txt }
    destination: GameData/cancelled.txt
  - op: remove
    target: GameData/cancelled.txt
`),
      {
        'GameData/base.txt': 'base',
        'YMB/mods/file-pack/config/patch/files/first.txt': 'first',
        'YMB/mods/file-pack/config/patch/files/second.txt': 'second',
      },
    );

    const plan = await preparePlan(workspace.builderPath, createSelection({ dryRun: true }));
    expect(plan.selectedFileDeletions).toEqual([]);
    expect(plan.selectedReplaceFiles.map((file) => file.targetRelativePath)).toEqual([
      'GameData/base.txt',
      'GameData/new.txt',
    ]);
    await runBuild(workspace.builderPath, createSelection());
    expect(
      await Bun.file(
        path.join(workspace.builderPath, '.ymb-build/output/GameData/base.txt'),
      ).text(),
    ).toContain('first');
    expect(
      await Bun.file(path.join(workspace.builderPath, '.ymb-build/output/GameData/new.txt')).text(),
    ).toContain('second');
  });

  test('rejects traversal, broad targets, empty directories, and symbolic-link sources', async () => {
    const invalidCases = [
      {
        operation: `  - op: add
    source: { root: patch, path: ../outside.txt }
    destination: GameData/out.txt`,
        expected: 'path',
      },
      {
        operation: `  - op: add
    source: { root: patch, path: source.txt }
    destination: GameData`,
        expected: 'stay inside',
      },
      {
        operation: `  - op: add
    source: { root: patch, path: empty }
    destination: GameData/empty`,
        expected: 'contains no files',
      },
    ];
    for (const item of invalidCases) {
      const workspace = await createWorkspace(patch(item.operation), {
        'YMB/mods/file-pack/config/patch/files/source.txt': 'source',
      });
      await mkdir(path.join(workspace.patchPath, 'empty'), { recursive: true });
      await expectPlanError(workspace.builderPath, item.expected);
    }

    const fileAncestor = await createWorkspace(
      patch(`  - op: add
    source: { root: patch, path: source.txt }
    destination: GameData/parent/child.txt
`),
      {
        'GameData/parent': 'not a directory',
        'YMB/mods/file-pack/config/patch/files/source.txt': 'source',
      },
    );
    await expectPlanError(fileAncestor.builderPath, 'has file ancestor');

    const plannedHierarchy = await createWorkspace(
      patch(`  - op: add
    source: { root: patch, path: source.txt }
    destination: GameData/planned
  - op: add
    source: { root: patch, path: source.txt }
    destination: GameData/planned/child.txt
`),
      { 'YMB/mods/file-pack/config/patch/files/source.txt': 'source' },
    );
    await expectPlanError(plannedHierarchy.builderPath, 'has file ancestor');

    const workspace = await createWorkspace(
      patch(`  - op: add
    source: { root: patch, path: linked.txt }
    destination: GameData/linked.txt
`),
      { 'outside.txt': 'outside' },
    );
    try {
      await symlink(
        path.join(workspace.rootPath, 'outside.txt'),
        path.join(workspace.patchPath, 'linked.txt'),
        'file',
      );
    } catch {
      return;
    }
    await expect(
      preparePlan(workspace.builderPath, createSelection({ dryRun: true })),
    ).rejects.toMatchObject({
      context: expect.objectContaining({ reason: expect.stringContaining('symlink or junction') }),
    });
  });

  test('requires explicit patch dependencies before layering the same target', async () => {
    const workspace = await createWorkspace(
      patch(`  - op: add
    source: { root: patch, path: first.txt }
    destination: GameData/layered.txt
`),
      {
        'YMB/mods/file-pack/config/patch/files/first.txt': 'first',
        'YMB/mods/file-pack/config/patch/second/second.txt': 'second',
        'YMB/mods/file-pack/config/patch/second/ymb.patch.yaml': `version: 1
id: files.second
name: Second
enabled: true
scope: prod
dependsOn: []
files:
  - op: replace
    source: { root: patch, path: second.txt }
    destination: GameData/layered.txt
`,
      },
    );

    await expect(
      preparePlan(workspace.builderPath, createSelection({ dryRun: true })),
    ).rejects.toMatchObject({
      context: expect.objectContaining({
        reason: expect.stringContaining('Multiple file-operation owners'),
      }),
    });

    await Bun.write(
      path.join(workspace.builderPath, 'mods/file-pack/config/patch/second/ymb.patch.yaml'),
      `version: 1
id: files.second
name: Second
enabled: true
scope: prod
dependsOn: [files.main]
files:
  - op: replace
    source: { root: patch, path: second.txt }
    destination: GameData/layered.txt
`,
    );
    const plan = await preparePlan(workspace.builderPath, createSelection({ dryRun: true }));
    expect(plan.selectedReplaceFiles).toHaveLength(1);
    expect(plan.selectedReplaceFiles[0]?.patchId).toBe('files.second');
  });

  test('rejects collisions with mod-wide replace files and NDF patch targets', async () => {
    const replaceCollision = await createWorkspace(
      patch(`  - op: copy
    source: { root: patch, path: source.txt }
    destination: GameData/conflict.txt
`),
      {
        'YMB/mods/file-pack/config/patch/files/source.txt': 'patch',
        'YMB/mods/file-pack/config/replace/GameData/conflict.txt': 'replace',
      },
    );
    await expectPlanError(replaceCollision.builderPath, 'writes the same output path');

    const deletionCollision = await createWorkspace(
      `version: 1
id: files.main
name: File operations
enabled: true
scope: prod
dependsOn: []
files:
  - op: remove
    target: GameData/target.ndf
targets:
  - file: GameData/target.ndf
    operations:
      - op: modify
        selector: { kind: field, by: path, value: Descriptor.Value }
        value: 2
`,
      {
        'GameData/target.ndf': `export Descriptor is TDescriptor
(
  Value = 1
)
`,
      },
    );
    await expectPlanError(
      deletionCollision.builderPath,
      'File deletion collides with a generated patch target',
    );

    const hierarchicalCollision = await createWorkspace(
      patch(`  - op: add
    source: { root: patch, path: source.txt }
    destination: GameData/tree
`),
      {
        'YMB/mods/file-pack/config/patch/files/source.txt': 'patch',
        'YMB/mods/second-pack/config/ymb.mod.yaml': `version: 1
id: second_pack
name: Second Pack
enabled: true
`,
        'YMB/mods/second-pack/config/replace/GameData/tree/child.txt': 'replace',
      },
    );
    await expectPlanError(hierarchicalCollision.builderPath, 'cannot also be the parent directory');
  });
});

describe('file operation sync and recovery', () => {
  test('previews deletions, syncs them idempotently, and restores them on recover', async () => {
    const workspace = await createWorkspace(
      patch(`  - op: remove
    target: GameData/remove
    expect: { files: 2 }
`),
      {
        'GameData/remove/a.txt': 'a',
        'GameData/remove/nested/b.bin': new Uint8Array([1, 2, 3]),
      },
    );
    await runBuild(workspace.builderPath, createSelection());
    const deletionPreview = await Bun.file(
      path.join(workspace.builderPath, '.ymb-build/output/.ymb-deletions.json'),
    ).json();
    expect(deletionPreview.files).toEqual([
      'GameData/remove/a.txt',
      'GameData/remove/nested/b.bin',
    ]);

    await runSync(workspace.builderPath, createSelection());
    expect(await Bun.file(path.join(workspace.rootPath, 'GameData/remove/a.txt')).exists()).toBe(
      false,
    );
    const second = await runSync(workspace.builderPath, createSelection());
    expect(second.join('\n')).toContain(formatDetailLine('current', 'GameData/remove/a.txt'));

    await runRecover(workspace.builderPath, createSelection());
    expect(await Bun.file(path.join(workspace.rootPath, 'GameData/remove/a.txt')).text()).toBe('a');
    expect(
      new Uint8Array(
        await Bun.file(path.join(workspace.rootPath, 'GameData/remove/nested/b.bin')).arrayBuffer(),
      ),
    ).toEqual(new Uint8Array([1, 2, 3]));
  });

  test('rejects recreation of a tracked deletion and restores obsolete deletions on the next sync', async () => {
    const workspace = await createWorkspace(
      patch(`  - op: remove
    target: GameData/remove.txt
`),
      {
        'GameData/remove.txt': 'original',
        'YMB/mods/file-pack/config/patch/files/new.txt': 'new',
      },
    );
    await runSync(workspace.builderPath, createSelection());
    await Bun.write(path.join(workspace.rootPath, 'GameData/remove.txt'), 'manual recreation');
    await expect(runSync(workspace.builderPath, createSelection())).rejects.toMatchObject({
      context: expect.objectContaining({
        reason: expect.stringContaining('changed outside YMB'),
        suggestion: expect.stringContaining('--reset-changed'),
      }),
    });

    await rm(path.join(workspace.rootPath, 'GameData/remove.txt'));
    await Bun.write(
      path.join(workspace.patchPath, 'ymb.patch.yaml'),
      patch(`  - op: add
    source: { root: patch, path: new.txt }
    destination: GameData/new.txt
`),
    );
    const result = await runSync(workspace.builderPath, createSelection());
    expect(result).toEqual(
      expect.arrayContaining(
        formatFindingGroups(toObsoleteTargetFindings(['GameData/remove.txt'], [])),
      ),
    );
    expect(await Bun.file(path.join(workspace.rootPath, 'GameData/remove.txt')).text()).toBe(
      'original',
    );
  });

  test('re-deletes a tracked deletion that came back with its original bytes', async () => {
    const workspace = await createWorkspace(
      patch(`  - op: remove
    target: GameData/remove.txt
`),
      { 'GameData/remove.txt': 'original' },
    );
    const removedPath = path.join(workspace.rootPath, 'GameData/remove.txt');
    await runSync(workspace.builderPath, createSelection());
    expect(await Bun.file(removedPath).exists()).toBe(false);
    // A WARNO update putting the untouched file back is not a conflict: the
    // deletion simply applies again.
    await Bun.write(removedPath, 'original');

    const lines = await runSync(workspace.builderPath, createSelection());

    expect(lines.join('\n')).toContain(formatDetailLine('deleted', 'GameData/remove.txt'));
    expect(await Bun.file(removedPath).exists()).toBe(false);
  });

  test('--reset-changed clears a tracked deletion that came back with other content', async () => {
    const workspace = await createWorkspace(
      patch(`  - op: remove
    target: GameData/remove.txt
`),
      { 'GameData/remove.txt': 'original' },
    );
    const removedPath = path.join(workspace.rootPath, 'GameData/remove.txt');
    await runSync(workspace.builderPath, createSelection());
    await Bun.write(removedPath, 'manual recreation');

    await runSync(workspace.builderPath, createSelection({ resetChanged: true, yes: true }));

    expect(await Bun.file(removedPath).exists()).toBe(false);
  });

  test('rejects missing or corrupted backups for tracked deletions', async () => {
    const missingWorkspace = await createWorkspace(
      patch(`  - op: remove
    target: GameData/remove.txt
`),
      { 'GameData/remove.txt': 'original' },
    );
    await runSync(missingWorkspace.builderPath, createSelection());
    const missingManifest = await Bun.file(
      path.join(missingWorkspace.builderPath, '.ymb-state/manifest.json'),
    ).json();
    const missingBackup = path.join(
      missingWorkspace.builderPath,
      '.ymb-state/originals',
      String(missingManifest.entries[0].backupFileName),
    );
    await rm(missingBackup);
    for (const action of [
      () => runSync(missingWorkspace.builderPath, createSelection()),
      () => runRecover(missingWorkspace.builderPath, createSelection({ dryRun: true })),
    ]) {
      await expect(action()).rejects.toMatchObject({
        context: expect.objectContaining({
          reason: expect.stringContaining('Missing'),
        }),
      });
    }
    await mkdir(missingBackup);
    await expect(runRecover(missingWorkspace.builderPath, createSelection())).rejects.toMatchObject(
      {
        context: expect.objectContaining({
          reason: expect.stringContaining('is not a regular file'),
        }),
      },
    );

    const corruptWorkspace = await createWorkspace(
      patch(`  - op: remove
    target: GameData/remove.txt
`),
      { 'GameData/remove.txt': 'original' },
    );
    await runSync(corruptWorkspace.builderPath, createSelection());
    const corruptManifestPath = path.join(corruptWorkspace.builderPath, '.ymb-state/manifest.json');
    const corruptManifest = await Bun.file(corruptManifestPath).json();
    const corruptBackup = path.join(
      corruptWorkspace.builderPath,
      '.ymb-state/originals',
      String(corruptManifest.entries[0].backupFileName),
    );
    await Bun.write(corruptBackup, 'corrupted');
    await expect(runRecover(corruptWorkspace.builderPath, createSelection())).rejects.toMatchObject(
      {
        context: expect.objectContaining({
          reason: expect.stringContaining('is corrupted'),
        }),
      },
    );
    expect(
      await Bun.file(path.join(corruptWorkspace.rootPath, 'GameData/remove.txt')).exists(),
    ).toBe(false);
    expect((await Bun.file(corruptManifestPath).json()).entries).toHaveLength(1);
  });

  test('recovers added files and copies pristine game bytes after a previous sync', async () => {
    const workspace = await createWorkspace(
      patch(`  - op: replace
    source: { root: patch, path: modified.txt }
    destination: GameData/source.txt
  - op: copy
    source: { root: game, path: GameData/source.txt }
    destination: GameData/copied.txt
`),
      {
        'GameData/source.txt': 'original',
        'YMB/mods/file-pack/config/patch/files/modified.txt': 'modified',
      },
    );
    await runSync(workspace.builderPath, createSelection());
    expect(await Bun.file(path.join(workspace.rootPath, 'GameData/source.txt')).text()).toContain(
      'modified',
    );

    await runBuild(workspace.builderPath, createSelection());
    expect(
      await Bun.file(
        path.join(workspace.builderPath, '.ymb-build/output/GameData/copied.txt'),
      ).text(),
    ).toContain('original');

    await runRecover(workspace.builderPath, createSelection());
    expect(await Bun.file(path.join(workspace.rootPath, 'GameData/source.txt')).text()).toBe(
      'original',
    );
    expect(await Bun.file(path.join(workspace.rootPath, 'GameData/copied.txt')).exists()).toBe(
      false,
    );
  });

  test('copies a deleted game directory from recovery backups on later builds', async () => {
    const workspace = await createWorkspace(
      patch(`  - op: remove
    target: GameData/source
    expect: { files: 2 }
  - op: copy
    source: { root: game, path: GameData/source }
    destination: GameData/copied
    expect: { files: 2 }
`),
      {
        'GameData/source/a.ndf': 'export SourceA is TSource()\n',
        'GameData/source/nested/b.txt': 'b',
      },
    );
    await runSync(workspace.builderPath, createSelection());
    expect(await Bun.file(path.join(workspace.rootPath, 'GameData/source/a.ndf')).exists()).toBe(
      false,
    );

    await runBuild(workspace.builderPath, createSelection());
    expect(
      await Bun.file(
        path.join(workspace.builderPath, '.ymb-build/output/GameData/copied/a.ndf'),
      ).text(),
    ).toBe('export SourceA is TSource()\n');
    expect(
      await Bun.file(
        path.join(workspace.builderPath, '.ymb-build/output/GameData/copied/nested/b.txt'),
      ).text(),
    ).toContain('b');
  });

  test('copies a deleted game file from its recovery backup on later builds', async () => {
    const workspace = await createWorkspace(
      patch(`  - op: remove
    target: GameData/source.txt
`),
      { 'GameData/source.txt': 'original bytes' },
    );
    await runSync(workspace.builderPath, createSelection());
    expect(await Bun.file(path.join(workspace.rootPath, 'GameData/source.txt')).exists()).toBe(
      false,
    );

    await Bun.write(
      path.join(workspace.patchPath, 'ymb.patch.yaml'),
      patch(`  - op: copy
    source: { root: game, path: GameData/source.txt }
    destination: GameData/copied.txt
`),
    );
    await runBuild(workspace.builderPath, createSelection());
    expect(
      await Bun.file(
        path.join(workspace.builderPath, '.ymb-build/output/GameData/copied.txt'),
      ).text(),
    ).toBe('original bytes');
  });

  test('rejects game sources that were created by YMB and have no original bytes', async () => {
    const workspace = await createWorkspace(
      patch(`  - op: add
    source: { root: patch, path: new.txt }
    destination: GameData/generated.txt
`),
      { 'YMB/mods/file-pack/config/patch/files/new.txt': 'generated' },
    );
    await runSync(workspace.builderPath, createSelection());
    await Bun.write(
      path.join(workspace.patchPath, 'ymb.patch.yaml'),
      patch(`  - op: copy
    source: { root: game, path: GameData/generated.txt }
    destination: GameData/copied.txt
`),
    );
    await expectPlanError(workspace.builderPath, 'has no original file to copy');
  });
});
