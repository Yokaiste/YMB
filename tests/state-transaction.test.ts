import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveBuilderContext } from '../src/config.ts';
import { runValidate } from '../src/engine.ts';
import {
  beginStateTransaction,
  loadPendingStateTransaction,
  recordStateTransactionTarget,
  recoverPendingStateTransactionOrThrow,
} from '../src/state-transaction.ts';
import {
  cleanupTempRoots,
  createAbstractBuilderWorkspace,
  createSelection,
} from './helpers/abstract-builder.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  await cleanupTempRoots(tempRoots);
});

describe('state transactions', () => {
  test('restores live files and recovery state after an interrupted operation', async () => {
    const workspace = await createAbstractBuilderWorkspace(tempRoots);
    const context = await resolveBuilderContext(workspace.builderPath);
    const existingTarget = 'GameData/Generated/Gameplay/Units.ndf';
    const createdTarget = 'CommonData/Text/created-during-sync.ndf';
    const existingAbsolutePath = path.join(workspace.modRootPath, ...existingTarget.split('/'));
    const createdAbsolutePath = path.join(workspace.modRootPath, ...createdTarget.split('/'));
    const originalLiveContent = await Bun.file(existingAbsolutePath).text();
    const originalStateContent = '{"entries":[]}\n';
    await mkdir(context.stateRoot, { recursive: true });
    await Bun.write(path.join(context.stateRoot, 'manifest.json'), originalStateContent);

    const transaction = await beginStateTransaction(context, 'sync');
    await recordStateTransactionTarget(transaction, existingTarget);
    await recordStateTransactionTarget(transaction, createdTarget);
    await Bun.write(existingAbsolutePath, 'partially synced existing file');
    await mkdir(path.dirname(createdAbsolutePath), { recursive: true });
    await Bun.write(createdAbsolutePath, 'partially synced new file');
    await Bun.write(path.join(context.stateRoot, 'manifest.json'), '{"partial":true}\n');

    expect(await loadPendingStateTransaction(context)).toBeDefined();
    await expect(runValidate(workspace.builderPath, createSelection())).rejects.toThrow(
      'Recovered files and recovery state from interrupted `sync`',
    );

    expect(await Bun.file(existingAbsolutePath).text()).toBe(originalLiveContent);
    expect(await Bun.file(createdAbsolutePath).exists()).toBe(false);
    expect(await Bun.file(path.join(context.stateRoot, 'manifest.json')).text()).toBe(
      originalStateContent,
    );
    expect(await loadPendingStateTransaction(context)).toBeUndefined();
  });

  test('fails closed and preserves the journal when a target snapshot is corrupted', async () => {
    const workspace = await createAbstractBuilderWorkspace(tempRoots);
    const context = await resolveBuilderContext(workspace.builderPath);
    const target = 'GameData/Generated/Gameplay/Units.ndf';
    const targetAbsolutePath = path.join(workspace.modRootPath, ...target.split('/'));
    const transaction = await beginStateTransaction(context, 'recover');
    await recordStateTransactionTarget(transaction, target);
    const snapshotRoot = path.join(transaction.root, 'targets-before');
    const snapshotNames = await readdir(snapshotRoot);
    await Bun.write(path.join(snapshotRoot, snapshotNames[0] as string), 'corrupted snapshot');
    await Bun.write(targetAbsolutePath, 'partial recovery output');

    await expect(recoverPendingStateTransactionOrThrow(context)).rejects.toThrow(
      'is missing or corrupted',
    );

    expect(await Bun.file(targetAbsolutePath).text()).toBe('partial recovery output');
    expect(await Bun.file(path.join(transaction.root, 'transaction.json')).exists()).toBe(true);
  });
});
