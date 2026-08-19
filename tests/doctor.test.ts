import { afterEach, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { runDoctor, runSync } from '../src/engine/commands.ts';
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

/**
 * `doctor` is what people run before asking for help, so it has to answer the
 * questions they arrive with rather than only restate resolved paths.
 */
describe('doctor reports installed state', () => {
  test('says plainly when nothing has been synced', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);

    const lines = await runDoctor(builderPath, createSelection());

    expect(lines).toContain('installed -> nothing synced yet');
    expect(summaryText(lines)).not.toContain('tracked file');
    expect(lines.nextSteps).toEqual(['Run `validate` if these paths look correct.']);
  });

  test('counts tracked files and names the mods that own them', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);
    await runSync(builderPath, createSelection({ yes: true }));

    const lines = await runDoctor(builderPath, createSelection());

    expect(lines.some((line) => line.startsWith('installed -> '))).toBe(true);
    expect(lines.some((line) => line.includes('sample_pack'))).toBe(true);
    expect(summaryText(lines)).toContain('tracked file');
  });

  test('names files changed after the sync and what to do about them', async () => {
    const { builderPath, modRootPath } = await createAbstractBuilderWorkspace(tempRoots);
    await runSync(builderPath, createSelection({ yes: true }));

    const clean = await runDoctor(builderPath, createSelection());
    expect(clean.some((line) => line.includes('Changed after the last sync'))).toBe(false);

    // Stands in for both a hand edit and a WARNO update overwriting the file:
    // either way the next sync refuses to run, and `doctor` should say so first.
    const targetPath = path.join(modRootPath, 'GameData', 'Generated', 'Gameplay', 'Units.ndf');
    await Bun.write(targetPath, 'edited by hand\n');

    const drifted = await runDoctor(builderPath, createSelection());
    const driftReport = drifted.join('\n');
    // One heading naming the fix, with the file listed beneath it - not the fix
    // repeated once per file.
    expect(driftReport).toContain('Changed after the last sync');
    expect(driftReport).toContain('recover --yes --reset-changed');
    expect(driftReport).toContain('Units.ndf');
    expect(summaryText(drifted)).toContain('changed since sync');
  });

  test('reports the runtime it is running on', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);

    const lines = await runDoctor(builderPath, createSelection());

    expect(lines.some((line) => line === `bun -> ${Bun.version}`)).toBe(true);
  });
});
