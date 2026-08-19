import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { runDoctor, runRecover, runSync } from '../src/engine/commands.ts';
import { formatDetailLine } from '../src/report/detail.ts';
import {
  cleanupTempRoots,
  createAbstractBuilderWorkspace,
  createSelection,
  summaryText,
} from './helpers/abstract-builder.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  await cleanupTempRoots(tempRoots);
});

const PATCHED_TARGET = 'GameData/Generated/Gameplay/Units.ndf';
/** A tracked target YMB created, so its recorded original is "did not exist". */
const GENERATED_TARGET = 'CommonData/Text/sample_pack-generated-by-mod.ndf';

/**
 * Valid NDF that a patch would happily apply to. The point of clobbering with
 * something parseable is that only the reset ordering can keep it out of the
 * result - a parse failure would mask the bug this guards.
 */
const FOREIGN_CONTENT = `export Descriptor_Unit_Foreign is TEntityDescriptor
(
    FrontArmor = 99
)
`;

interface ResetWorkspace {
  rootPath: string;
  builderPath: string;
  targetPath: string;
  generatedTargetPath: string;
  originalContent: string;
  syncedContent: string;
}

/** Syncs once, so the manifest has a recorded original and synced state to drift from. */
async function createSyncedWorkspace(): Promise<ResetWorkspace> {
  const workspace = await createAbstractBuilderWorkspace(tempRoots);
  const targetPath = path.join(workspace.rootPath, ...PATCHED_TARGET.split('/'));
  const originalContent = await Bun.file(targetPath).text();
  await runSync(workspace.builderPath, createSelection());
  const syncedContent = await Bun.file(targetPath).text();
  expect(syncedContent).not.toBe(originalContent);
  return {
    rootPath: workspace.rootPath,
    builderPath: workspace.builderPath,
    targetPath,
    generatedTargetPath: path.join(workspace.rootPath, ...GENERATED_TARGET.split('/')),
    originalContent,
    syncedContent,
  };
}

describe('tracked files that changed outside YMB', () => {
  test('a file put back to its original syncs again with no flag and no error', async () => {
    const workspace = await createSyncedWorkspace();
    // What WARNO's own mod pipeline does: rewrite the file it owns.
    await Bun.write(workspace.targetPath, workspace.originalContent);

    const lines = await runSync(workspace.builderPath, createSelection());

    expect(await Bun.file(workspace.targetPath).text()).toBe(workspace.syncedContent);
    expect(lines.join('\n')).toContain(formatDetailLine('patched', PATCHED_TARGET));
    expect(lines.join('\n')).not.toContain('reset');
  });

  test('a file YMB created and something deleted is written again with no flag', async () => {
    const workspace = await createSyncedWorkspace();
    // `originalExists` is false for this target, so "gone" is its original state.
    await rm(workspace.generatedTargetPath);

    await expect(runSync(workspace.builderPath, createSelection())).resolves.toBeDefined();
    expect(await Bun.file(workspace.generatedTargetPath).exists()).toBe(true);
  });

  test('unknown content stops the sync and the error names the flag and the file', async () => {
    const workspace = await createSyncedWorkspace();
    await Bun.write(workspace.targetPath, FOREIGN_CONTENT);

    await expect(runSync(workspace.builderPath, createSelection())).rejects.toMatchObject({
      category: 'RecoveryError',
      context: expect.objectContaining({
        reason: expect.stringContaining('changed outside YMB'),
        suggestion: expect.stringContaining('--reset-changed'),
        details: expect.arrayContaining([PATCHED_TARGET]),
      }),
    });
    // A refused sync must not have touched anything on the way to refusing.
    expect(await Bun.file(workspace.targetPath).text()).toBe(FOREIGN_CONTENT);
  });

  test('the error counts every changed file, not just the first', async () => {
    const workspace = await createSyncedWorkspace();
    await Bun.write(workspace.targetPath, FOREIGN_CONTENT);
    await Bun.write(workspace.generatedTargetPath, 'something else entirely');

    await expect(runSync(workspace.builderPath, createSelection())).rejects.toMatchObject({
      context: expect.objectContaining({
        reason: expect.stringContaining('2 tracked live files'),
        details: expect.arrayContaining([PATCHED_TARGET, GENERATED_TARGET]),
      }),
    });
  });

  test('--reset-changed restores the original and applies on top of it', async () => {
    const workspace = await createSyncedWorkspace();
    await Bun.write(workspace.targetPath, FOREIGN_CONTENT);

    const lines = await runSync(
      workspace.builderPath,
      createSelection({ resetChanged: true, yes: true }),
    );

    // The result must match a clean sync exactly. Anything else means the patch
    // was applied over the foreign content instead of over the original.
    expect(await Bun.file(workspace.targetPath).text()).toBe(workspace.syncedContent);
    expect(await Bun.file(workspace.targetPath).text()).not.toContain('Descriptor_Unit_Foreign');
    expect(lines.join('\n')).toContain(formatDetailLine('reset', PATCHED_TARGET));
  });

  test('--reset-changed reports what it reset in the summary', async () => {
    const workspace = await createSyncedWorkspace();
    await Bun.write(workspace.targetPath, FOREIGN_CONTENT);

    const lines = await runSync(
      workspace.builderPath,
      createSelection({ resetChanged: true, yes: true }),
    );

    expect(summaryText(lines)).toContain('1 file reset to its original');
  });

  test('--reset-changed rescues a file whose YMB markers were tampered with', async () => {
    const workspace = await createSyncedWorkspace();
    await Bun.write(
      workspace.targetPath,
      workspace.syncedContent.replace('// YMB-END', '// YMB-FINISH'),
    );

    await runSync(workspace.builderPath, createSelection({ resetChanged: true, yes: true }));

    expect(await Bun.file(workspace.targetPath).text()).toBe(workspace.syncedContent);
  });

  test('--reset-changed on a clean tree resets nothing and changes no output', async () => {
    const workspace = await createSyncedWorkspace();

    const lines = await runSync(
      workspace.builderPath,
      createSelection({ resetChanged: true, yes: true }),
    );

    expect(lines.join('\n')).not.toContain('reset');
    expect(summaryText(lines)).not.toContain('reset to its original');
    expect(await Bun.file(workspace.targetPath).text()).toBe(workspace.syncedContent);
  });

  test('a changed file outside the selection does not block a filtered sync', async () => {
    const workspace = await createSyncedWorkspace();
    await Bun.write(workspace.targetPath, FOREIGN_CONTENT);

    // No entry in the manifest belongs to this mod, so the run owns nothing that drifted.
    await expect(
      runSync(workspace.builderPath, createSelection({ modFilters: ['other-pack'] })),
    ).resolves.toBeDefined();
    expect(await Bun.file(workspace.targetPath).text()).toBe(FOREIGN_CONTENT);
  });

  test('a dry run refuses rather than preview a sync built on content nobody kept', async () => {
    const workspace = await createSyncedWorkspace();
    await Bun.write(workspace.targetPath, FOREIGN_CONTENT);

    // A dry run writes nothing, so it cannot put the original back - and without
    // that, the patch would be previewed against the foreign content.
    await expect(
      runSync(workspace.builderPath, createSelection({ resetChanged: true, dryRun: true })),
    ).rejects.toMatchObject({
      context: expect.objectContaining({
        suggestion: expect.stringContaining('without `--dry-run`'),
      }),
    });
    expect(await Bun.file(workspace.targetPath).text()).toBe(FOREIGN_CONTENT);
  });
});

describe('recover against tracked files that changed outside YMB', () => {
  test('a file put back to its original recovers with no flag', async () => {
    const workspace = await createSyncedWorkspace();
    await Bun.write(workspace.targetPath, workspace.originalContent);

    await runRecover(workspace.builderPath, createSelection());

    expect(await Bun.file(workspace.targetPath).text()).toBe(workspace.originalContent);
  });

  test('unknown content stops recover and points at the flag', async () => {
    const workspace = await createSyncedWorkspace();
    await Bun.write(workspace.targetPath, FOREIGN_CONTENT);

    await expect(runRecover(workspace.builderPath, createSelection())).rejects.toMatchObject({
      category: 'RecoveryError',
      context: expect.objectContaining({
        suggestion: expect.stringContaining('--reset-changed'),
      }),
    });
  });

  test('recover --reset-changed puts the original back over unknown content', async () => {
    const workspace = await createSyncedWorkspace();
    await Bun.write(workspace.targetPath, FOREIGN_CONTENT);

    await runRecover(workspace.builderPath, createSelection({ resetChanged: true, yes: true }));

    expect(await Bun.file(workspace.targetPath).text()).toBe(workspace.originalContent);
  });

  test('recover --reset-changed still restores a tracked file that went missing', async () => {
    const workspace = await createSyncedWorkspace();
    await rm(workspace.targetPath);

    await runRecover(workspace.builderPath, createSelection({ resetChanged: true, yes: true }));

    expect(await Bun.file(workspace.targetPath).text()).toBe(workspace.originalContent);
  });
});

describe('doctor separates the two kinds of drift', () => {
  test('a reverted file is reported apart from a changed one', async () => {
    const workspace = await createSyncedWorkspace();
    await Bun.write(workspace.generatedTargetPath, FOREIGN_CONTENT);
    await Bun.write(workspace.targetPath, workspace.originalContent);

    const lines = await runDoctor(workspace.builderPath, createSelection());
    const report = lines.join('\n');

    const installed = lines.summary?.find((fact) => fact.label === 'installed')?.value ?? '';

    expect(report).toContain(GENERATED_TARGET);
    expect(report).toContain(PATCHED_TARGET);
    expect(report).toContain('Changed after the last sync');
    expect(report).toContain('Back at its original bytes');
    expect(report).toContain('--reset-changed');
    expect(installed).toContain('1 file changed since sync');
    expect(installed).toContain('1 file back at its original');
  });
});
