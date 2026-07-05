import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { runBuild, runCleanup, runRecover, runSync, runValidate } from '../src/engine.ts';
import { setPatchPriorityResolverForTesting } from '../src/patch-priority.ts';
import {
  cleanupTempRoots,
  createAbstractBuilderWorkspace,
  syntheticBuilderPath,
  writeModFixture,
} from './helpers/abstract-builder.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  setPatchPriorityResolverForTesting(undefined);
  await cleanupTempRoots(tempRoots);
});

async function createTempBuilder(): Promise<string> {
  return (await createAbstractBuilderWorkspace(tempRoots)).builderPath;
}

async function directoryExists(directoryPath: string): Promise<boolean> {
  try {
    await readdir(directoryPath);
    return true;
  } catch {
    return false;
  }
}

describe('build and sync workflow', () => {
  test('build writes output and sync + recover round-trip the file state', async () => {
    const builderPath = await createTempBuilder();
    const modRootName = path.basename(path.dirname(builderPath));
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    const buildLines = await runBuild(builderPath, selection);
    expect(buildLines.join('\n')).toContain('patch -> GameData/Generated/Gameplay/Units.ndf');
    expect(buildLines.join('\n')).toContain(
      'script -> GameData/Generated/Gameplay/ArmorSummary.ndf',
    );
    expect(buildLines.join('\n')).toContain(
      'script -> CommonData/Text/sample_pack-generated-by-mod.ndf',
    );

    const builtFile = await Bun.file(
      path.join(
        builderPath,
        '.ymb-build',
        'output',
        'GameData',
        'Generated',
        'Gameplay',
        'Units.ndf',
      ),
    ).text();
    expect(builtFile).toContain('// YMB-START');
    expect(builtFile).toContain('FrontArmor = 7');
    expect(builtFile).toContain('Descriptor_Unit_sample_pack_T80UM');

    const builtArmorSummary = await Bun.file(
      path.join(
        builderPath,
        '.ymb-build',
        'output',
        'GameData',
        'Generated',
        'Gameplay',
        'ArmorSummary.ndf',
      ),
    ).text();
    expect(builtArmorSummary).toContain('// YMB-START');
    expect(builtArmorSummary).toContain('// YMB-ADD-START');
    expect(builtArmorSummary).toContain('ArmorBonus = 7');
    expect(builtArmorSummary).toContain('ContainsClone = True');

    const builtModSummary = await Bun.file(
      path.join(
        builderPath,
        '.ymb-build',
        'output',
        'CommonData',
        'Text',
        'sample_pack-generated-by-mod.ndf',
      ),
    ).text();
    expect(builtModSummary).toContain('// YMB-START');
    expect(builtModSummary).toContain('// YMB-ADD-START');
    expect(builtModSummary).toContain('Label = "Sample Pack"');
    expect(builtModSummary).toContain('Text = "Replaced content for Sample Pack"');

    const builtReplaceFile = await Bun.file(
      path.join(
        builderPath,
        '.ymb-build',
        'output',
        'CommonData',
        'Text',
        `${modRootName}-replaced.ndf`,
      ),
    ).text();
    expect(builtReplaceFile).toContain('// YMB-START');
    expect(builtReplaceFile).toContain('// YMB-ADD-START');
    expect(builtReplaceFile).toContain('Replaced content for Sample Pack');

    await runSync(builderPath, selection);

    const syncedFile = await Bun.file(
      path.join(path.dirname(builderPath), 'GameData', 'Generated', 'Gameplay', 'Units.ndf'),
    ).text();
    expect(syncedFile).toContain('// YMB-START');
    expect(syncedFile).toContain('FrontArmor = 7');

    const replacedFile = await Bun.file(
      path.join(path.dirname(builderPath), 'CommonData', 'Text', `${modRootName}-replaced.ndf`),
    ).text();
    expect(replacedFile).toContain('YMB-START');
    expect(replacedFile).toContain('Replaced content for Sample Pack');

    const syncedArmorSummary = await Bun.file(
      path.join(path.dirname(builderPath), 'GameData', 'Generated', 'Gameplay', 'ArmorSummary.ndf'),
    ).text();
    expect(syncedArmorSummary).toContain('YMB-START');
    expect(syncedArmorSummary).toContain('ArmorBonus = 7');

    const syncedModSummary = await Bun.file(
      path.join(
        path.dirname(builderPath),
        'CommonData',
        'Text',
        'sample_pack-generated-by-mod.ndf',
      ),
    ).text();
    expect(syncedModSummary).toContain('YMB-START');
    expect(syncedModSummary).toContain('Replaced content for Sample Pack');

    await runRecover(builderPath, selection);

    const recoveredFile = await Bun.file(
      path.join(path.dirname(builderPath), 'GameData', 'Generated', 'Gameplay', 'Units.ndf'),
    ).text();
    expect(recoveredFile).not.toContain('YMB-START');
    expect(recoveredFile).toContain('FrontArmor = 5');

    expect(
      await Bun.file(
        path.join(
          path.dirname(builderPath),
          'GameData',
          'Generated',
          'Gameplay',
          'ArmorSummary.ndf',
        ),
      ).exists(),
    ).toBe(false);
    expect(
      await Bun.file(
        path.join(
          path.dirname(builderPath),
          'CommonData',
          'Text',
          'sample_pack-generated-by-mod.ndf',
        ),
      ).exists(),
    ).toBe(false);
  });

  test('validate, build, and sync run configured script tests', async () => {
    const builderPath = await createTempBuilder();
    const buildSelection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };
    const validateSelection = {
      ...buildSelection,
      dryRun: true,
    };

    const validateLines = await runValidate(builderPath, validateSelection);
    expect(validateLines).toContain(
      'script test ok -> generate-mod-summary.test.ts :: mod-level summary script returns the expected output',
    );
    expect(validateLines).toContain(
      'script test ok -> generate-armor-summary.test.ts :: patch-level armor summary script returns the expected output',
    );

    const buildLines = await runBuild(builderPath, buildSelection);
    expect(buildLines).toContain(
      'script test ok -> generate-mod-summary.test.ts :: mod-level summary script returns the expected output',
    );
    expect(buildLines).toContain(
      'script test ok -> generate-armor-summary.test.ts :: patch-level armor summary script returns the expected output',
    );

    const syncLines = await runSync(builderPath, buildSelection);
    expect(syncLines).toContain(
      'script test ok -> generate-mod-summary.test.ts :: mod-level summary script returns the expected output',
    );
    expect(syncLines).toContain(
      'script test ok -> generate-armor-summary.test.ts :: patch-level armor summary script returns the expected output',
    );
  });

  test('build keeps runtime temp files out of mod script folders', async () => {
    const builderPath = await createTempBuilder();
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await runBuild(builderPath, selection);

    expect(
      await Bun.file(
        path.join(
          builderPath,
          '.ymb-build',
          '.ymb-runtime',
          '.ymb-runtime-1a8c55a5f62d6eef-generate-armor-summary.ts',
        ),
      ).exists(),
    ).toBe(false);
    expect(
      await Bun.file(
        path.join(
          builderPath,
          'mods',
          'sample-pack',
          'config',
          'patch',
          'armor',
          '.ymb-runtime-1a8c55a5f62d6eef-generate-armor-summary.ts',
        ),
      ).exists(),
    ).toBe(false);
  });

  test('safe cleanup removes YMB temp artifacts but preserves recovery state', async () => {
    const builderPath = await createTempBuilder();
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };
    const staleRuntimePath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'patch',
      'armor',
      '.ymb-runtime-stale-generate-armor-summary.ts',
    );
    const modTempPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      '.ymb-mod-temp.txt',
    );
    const patchTempPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'patch',
      'armor',
      '.ymb-patch-temp',
    );
    const importantModTempPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      '.ymb-mod-important.json',
    );
    const importantPatchTempPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'patch',
      'armor',
      '.ymb-patch-important.json',
    );
    const nestedBuilderTempPath = syntheticBuilderPath(
      builderPath,
      '.ymb-build',
      'nested-temp.txt',
    );
    const nestedBuilderModTempPath = syntheticBuilderPath(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      '.ymb-fixture-temp.txt',
    );
    const nestedBuilderStatePath = syntheticBuilderPath(builderPath, '.ymb-state', 'recovery.json');

    await runBuild(builderPath, selection);
    await runSync(builderPath, selection);
    await Bun.write(staleRuntimePath, 'stale');
    await Bun.write(modTempPath, 'mod temp');
    await Bun.write(importantModTempPath, '{"safeCleanup":false}\n');
    await mkdir(patchTempPath, { recursive: true });
    await Bun.write(path.join(patchTempPath, 'nested.txt'), 'patch temp');
    await Bun.write(importantPatchTempPath, '{"safeCleanup":false}\n');
    await mkdir(path.dirname(nestedBuilderTempPath), { recursive: true });
    await Bun.write(nestedBuilderTempPath, 'nested build temp');
    await mkdir(path.dirname(nestedBuilderModTempPath), { recursive: true });
    await Bun.write(nestedBuilderModTempPath, 'nested mod temp');
    await mkdir(path.dirname(nestedBuilderStatePath), { recursive: true });
    await Bun.write(nestedBuilderStatePath, 'nested recovery');

    const cleanupLines = await runCleanup(builderPath, selection, false);
    expect(cleanupLines.summary ?? []).toContain('mode: safe');
    expect((cleanupLines.summary ?? []).some((line) => line.includes('all-only'))).toBe(true);
    expect((cleanupLines.summary ?? []).some((line) => line.includes('preserved'))).toBe(true);
    expect(cleanupLines.summary ?? []).toContain(
      'cleanup: 10 target | 4 all-only | 4 preserved | 6 removed | 0 missing | 0 failed',
    );
    expect(await directoryExists(path.join(builderPath, '.ymb-build'))).toBe(false);
    expect(await Bun.file(staleRuntimePath).exists()).toBe(false);
    expect(await Bun.file(modTempPath).exists()).toBe(false);
    expect(await Bun.file(patchTempPath).exists()).toBe(false);
    expect(await Bun.file(importantModTempPath).exists()).toBe(true);
    expect(await Bun.file(importantPatchTempPath).exists()).toBe(true);
    expect(await Bun.file(nestedBuilderTempPath).exists()).toBe(false);
    expect(await Bun.file(nestedBuilderModTempPath).exists()).toBe(false);
    expect(await directoryExists(path.join(builderPath, '.ymb-state'))).toBe(true);
    expect(await Bun.file(nestedBuilderStatePath).exists()).toBe(true);
    expect(cleanupLines).toContain(`cleanup preserved all-only -> ${importantModTempPath}`);
    expect(cleanupLines).toContain(`cleanup preserved all-only -> ${importantPatchTempPath}`);
    expect(cleanupLines).toContain(
      `cleanup preserved all-only -> ${path.join(builderPath, '.ymb-state')}`,
    );
    expect(cleanupLines).not.toContain(`cleanup preserved all-only -> ${modTempPath}`);
    expect(cleanupLines).not.toContain(`cleanup preserved all-only -> ${patchTempPath}`);
    expect(cleanupLines).not.toContain(`cleanup preserved all-only -> ${nestedBuilderTempPath}`);
  });

  test('cleanup --all removes recovery state too', async () => {
    const builderPath = await createTempBuilder();
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: true,
    };
    const patchConfigPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'patch',
      'armor',
      'ymb.patch.yaml',
    );
    const configuredPatchTempPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'patch',
      'armor',
      'generated-decks.core.store.json',
    );
    const originalPatchConfig = await Bun.file(patchConfigPath).text();
    await Bun.write(
      patchConfigPath,
      originalPatchConfig.replace(
        '  - path: .ymb-patch-important.json\n    unsafeToRemove: true',
        [
          '  - path: .ymb-patch-important.json',
          '    unsafeToRemove: true',
          '  - path: generated-decks.core.store.json',
          '    unsafeToRemove: true',
        ].join('\n'),
      ),
    );

    await runSync(builderPath, {
      ...selection,
      yes: false,
    });
    const importantModTempPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      '.ymb-mod-important.json',
    );
    const importantPatchTempPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'patch',
      'armor',
      '.ymb-patch-important.json',
    );
    const nestedBuilderStatePath = syntheticBuilderPath(builderPath, '.ymb-state', 'recovery.json');
    await Bun.write(importantModTempPath, '{"fullCleanup":true}\n');
    await Bun.write(importantPatchTempPath, '{"fullCleanup":true}\n');
    await Bun.write(configuredPatchTempPath, '{"fullCleanup":true}\n');
    await mkdir(path.dirname(nestedBuilderStatePath), { recursive: true });
    await Bun.write(nestedBuilderStatePath, 'nested recovery');
    expect(await directoryExists(path.join(builderPath, '.ymb-state'))).toBe(true);
    expect(await Bun.file(nestedBuilderStatePath).exists()).toBe(true);

    const cleanupLines = await runCleanup(builderPath, selection, true);
    expect(cleanupLines.summary ?? []).toContain('mode: all');
    expect(
      (cleanupLines.summary ?? []).some(
        (line) =>
          line.includes('cleanup:') && line.includes('5 all-only') && line.includes('0 preserved'),
      ),
    ).toBe(true);
    expect(await directoryExists(path.join(builderPath, '.ymb-state'))).toBe(false);
    expect(await Bun.file(nestedBuilderStatePath).exists()).toBe(false);
    expect(await Bun.file(importantModTempPath).exists()).toBe(false);
    expect(await Bun.file(importantPatchTempPath).exists()).toBe(false);
    expect(await Bun.file(configuredPatchTempPath).exists()).toBe(false);
  });

  test('safe cleanup dry-run preserves all-only targets in the reported plan', async () => {
    const builderPath = await createTempBuilder();
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };
    const importantModTempPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      '.ymb-mod-important.json',
    );
    const importantPatchTempPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'patch',
      'armor',
      '.ymb-patch-important.json',
    );

    await runSync(builderPath, selection);
    await Bun.write(importantModTempPath, '{"plannedPreserve":true}\n');
    await Bun.write(importantPatchTempPath, '{"plannedPreserve":true}\n');

    const cleanupLines = await runCleanup(
      builderPath,
      {
        ...selection,
        dryRun: true,
      },
      false,
    );

    expect(cleanupLines.summary ?? []).toContain('mode: safe');
    expect((cleanupLines.summary ?? []).some((line) => line.includes('preserved'))).toBe(true);
    expect(cleanupLines).toContain(`cleanup preserved all-only -> ${importantModTempPath}`);
    expect(cleanupLines).toContain(`cleanup preserved all-only -> ${importantPatchTempPath}`);
    expect(cleanupLines).toContain(
      `cleanup preserved all-only -> ${path.join(builderPath, '.ymb-state')}`,
    );
    expect(cleanupLines).not.toContain(`cleanup candidate [all-only] -> ${importantModTempPath}`);
    expect(cleanupLines).not.toContain(`cleanup candidate [all-only] -> ${importantPatchTempPath}`);
  });

  test('failed configured script tests stop validate, build, and sync', async () => {
    const builderPath = await createTempBuilder();
    const modScriptTestPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'generate-mod-summary.test.ts',
    );
    const buildSelection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };
    const validateSelection = {
      ...buildSelection,
      dryRun: true,
    };

    await Bun.write(
      modScriptTestPath,
      `export default async function test() {
  return {
    results: [
      {
        name: 'forced failure',
        status: 'failed',
        reason: 'Fixture script test failure.',
        suggestion: 'Fix the fixture test.',
        details: ['This failure is injected by workflow.test.ts.'],
      },
    ],
  };
}
`,
    );

    await expect(runValidate(builderPath, validateSelection)).rejects.toThrow(
      'Fixture script test failure.',
    );
    await expect(runBuild(builderPath, buildSelection)).rejects.toThrow(
      'Fixture script test failure.',
    );
    await expect(runSync(builderPath, validateSelection)).rejects.toThrow(
      'Fixture script test failure.',
    );
  });

  test('sync skips unchanged files when rerun on already marked output', async () => {
    const builderPath = await createTempBuilder();
    const modRootName = path.basename(path.dirname(builderPath));
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    const firstRun = await runSync(builderPath, selection);
    expect(firstRun).toContain('patch -> GameData/Generated/Gameplay/Units.ndf');

    const secondRun = await runSync(builderPath, selection);
    expect(secondRun).toContain('unchanged -> GameData/Generated/Gameplay/Units.ndf');
    expect(secondRun).toContain(`unchanged -> CommonData/Text/${modRootName}-replaced.ndf`);
    expect(secondRun).toContain('unchanged -> GameData/Generated/Gameplay/ArmorSummary.ndf');
    expect(secondRun).toContain('unchanged -> CommonData/Text/sample_pack-generated-by-mod.ndf');
  });

  test('build refreshes cached patch outputs when target source files change', async () => {
    const builderPath = await createTempBuilder();
    const modRoot = path.dirname(builderPath);
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };
    const sourceUnitsPath = path.join(modRoot, 'GameData', 'Generated', 'Gameplay', 'Units.ndf');
    const builtUnitsPath = path.join(
      builderPath,
      '.ymb-build',
      'output',
      'GameData',
      'Generated',
      'Gameplay',
      'Units.ndf',
    );
    const patchCacheRoot = path.join(builderPath, '.ymb-build', 'cache', 'patches');

    await runBuild(builderPath, selection);
    const initialCacheFiles = await readdir(patchCacheRoot);
    expect(initialCacheFiles.length).toBeGreaterThan(0);

    const updatedSource = `${await Bun.file(sourceUnitsPath).text()}\n// cache-bust-marker\n`;
    await Bun.write(sourceUnitsPath, updatedSource);

    await runBuild(builderPath, selection);
    const rebuiltUnits = await Bun.file(builtUnitsPath).text();
    expect(rebuiltUnits).toContain('// cache-bust-marker');
  });

  test('build can bypass caches explicitly', async () => {
    const builderPath = await createTempBuilder();
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
      useCache: false,
    };
    const patchCacheRoot = path.join(builderPath, '.ymb-build', 'cache', 'patches');
    const initialCacheEntries = await readdir(patchCacheRoot).catch(() => []);

    const buildLines = (await runBuild(builderPath, selection)) as string[] & {
      summary?: string[] | undefined;
    };

    const cacheEntries = await readdir(patchCacheRoot).catch(() => []);
    expect(cacheEntries).toEqual(initialCacheEntries);
    expect(buildLines.summary?.some((line) => line.includes('patch cache: bypassed'))).toBe(true);
  });

  test('validate and dry-run build fail early on broken replace templates', async () => {
    const builderPath = await createTempBuilder();
    const replacePath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'replace',
      'CommonData',
      'Text',
      'broken-template.ndf',
    );
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: true,
      verbose: false,
      yes: false,
    };

    await mkdir(path.dirname(replacePath), { recursive: true });
    await Bun.write(replacePath, 'BrokenTemplate is ${missingValue + 1}\n()\n');

    await expect(runValidate(builderPath, selection)).rejects.toThrow(
      'Unknown template variable "missingValue"',
    );
    await expect(runBuild(builderPath, selection)).rejects.toThrow(
      'Unknown template variable "missingValue"',
    );
  });

  test('sync and recover preserve raw bytes for binary replace files', async () => {
    const builderPath = await createTempBuilder();
    const modRoot = path.dirname(builderPath);
    const originalBytes = new Uint8Array([1, 2, 3, 4]);
    const replacementBytes = new Uint8Array([9, 8, 7, 6]);
    const targetPath = path.join(modRoot, 'GameData', 'Assets', 'Binary', 'logo.bin');
    const replacePath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'replace',
      'GameData',
      'Assets',
      'Binary',
      'logo.bin',
    );
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await mkdir(path.dirname(targetPath), { recursive: true });
    await mkdir(path.dirname(replacePath), { recursive: true });
    await Bun.write(targetPath, originalBytes);
    await Bun.write(replacePath, replacementBytes);

    await runSync(builderPath, selection);
    expect(Array.from(new Uint8Array(await Bun.file(targetPath).arrayBuffer()))).toEqual(
      Array.from(replacementBytes),
    );

    await runRecover(builderPath, selection);
    expect(Array.from(new Uint8Array(await Bun.file(targetPath).arrayBuffer()))).toEqual(
      Array.from(originalBytes),
    );
  });

  test('sync warns for csv replace files and leaves them unmarked', async () => {
    const builderPath = await createTempBuilder();
    const modRoot = path.dirname(builderPath);
    const replacePath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'replace',
      'GameData',
      'Localisation',
      'test',
      'INTERFACE_OUTGAME.csv',
    );
    const targetPath = path.join(
      modRoot,
      'GameData',
      'Localisation',
      'test',
      'INTERFACE_OUTGAME.csv',
    );
    const csvContent = '"TOKEN";"REFTEXT"\n';
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await mkdir(path.dirname(replacePath), { recursive: true });
    await Bun.write(replacePath, csvContent);

    const firstRun = await runSync(builderPath, selection);
    expect(firstRun).toContain(
      'warning marker sync -> GameData/Localisation/test/INTERFACE_OUTGAME.csv (This file type does not support YMB comment markers. Recovery will rely on .ymb-state backups for this file.)',
    );
    expect(firstRun).toContain('replace -> GameData/Localisation/test/INTERFACE_OUTGAME.csv');
    expect(await Bun.file(targetPath).text()).toBe(csvContent);
    expect(await Bun.file(targetPath).text()).not.toContain('YMB-START');

    const secondRun = await runSync(builderPath, selection);
    expect(secondRun).toContain('unchanged -> GameData/Localisation/test/INTERFACE_OUTGAME.csv');
  });

  test('build warns for csv replace previews and leaves them unmarked', async () => {
    const builderPath = await createTempBuilder();
    const replacePath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'replace',
      'GameData',
      'Localisation',
      'test',
      'INTERFACE_OUTGAME.csv',
    );
    const previewPath = path.join(
      builderPath,
      '.ymb-build',
      'output',
      'GameData',
      'Localisation',
      'test',
      'INTERFACE_OUTGAME.csv',
    );
    const csvContent = '"TOKEN";"REFTEXT"\n';
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await mkdir(path.dirname(replacePath), { recursive: true });
    await Bun.write(replacePath, csvContent);

    const buildLines = await runBuild(builderPath, selection);
    expect(buildLines).toContain(
      'warning marker preview -> GameData/Localisation/test/INTERFACE_OUTGAME.csv (This file type does not support YMB comment markers. Preview output will not show in-file ownership markers for this file.)',
    );
    expect(buildLines).toContain('replace -> GameData/Localisation/test/INTERFACE_OUTGAME.csv');
    expect(await Bun.file(previewPath).text()).toBe(csvContent);
    expect(await Bun.file(previewPath).text()).not.toContain('YMB-START');
  });

  test('resync keeps the original backup instead of backing up the previous generated output', async () => {
    const builderPath = await createTempBuilder();
    const patchConfigPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'patch',
      'armor',
      'ymb.patch.yaml',
    );
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await runSync(builderPath, selection);

    const patchConfig = await Bun.file(patchConfigPath).text();
    await Bun.write(patchConfigPath, patchConfig.replace('armorBonus: 7', 'armorBonus: 11'));

    const secondRun = await runSync(builderPath, selection);
    expect(secondRun).toContain('patch -> GameData/Generated/Gameplay/Units.ndf');

    await runRecover(builderPath, selection);

    const recoveredFile = await Bun.file(
      path.join(path.dirname(builderPath), 'GameData', 'Generated', 'Gameplay', 'Units.ndf'),
    ).text();
    expect(recoveredFile).toContain('FrontArmor = 5');
    expect(recoveredFile).not.toContain('FrontArmor = 7');
    expect(recoveredFile).not.toContain('FrontArmor = 11');
  });

  test('resync removes obsolete generated tracked files when an output target changes', async () => {
    const builderPath = await createTempBuilder();
    const modConfigPath = path.join(builderPath, 'mods', 'sample-pack', 'config', 'ymb.mod.yaml');
    const manifestPath = path.join(builderPath, '.ymb-state', 'manifest.json');
    const modRoot = path.dirname(builderPath);
    const oldTargetRelativePath = 'CommonData/Text/sample_pack-generated-by-mod.ndf';
    const newTargetRelativePath = 'CommonData/Text/sample_pack-generated-by-mod-v2.ndf';
    const oldTargetPath = path.join(
      modRoot,
      'CommonData',
      'Text',
      'sample_pack-generated-by-mod.ndf',
    );
    const newTargetPath = path.join(
      modRoot,
      'CommonData',
      'Text',
      'sample_pack-generated-by-mod-v2.ndf',
    );
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await runSync(builderPath, selection);
    expect(await Bun.file(oldTargetPath).exists()).toBe(true);

    const modConfig = await Bun.file(modConfigPath).text();
    await Bun.write(
      modConfigPath,
      modConfig.replace(
        'summaryTarget: CommonData/Text/${modId}-generated-by-mod.ndf',
        'summaryTarget: CommonData/Text/${modId}-generated-by-mod-v2.ndf',
      ),
    );

    const secondRun = await runSync(builderPath, selection);
    expect(secondRun).toContain(`delete obsolete -> ${oldTargetRelativePath}`);
    expect(await Bun.file(oldTargetPath).exists()).toBe(false);
    expect(await Bun.file(newTargetPath).exists()).toBe(true);

    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as {
      entries: Array<{ targetRelativePath: string }>;
    };
    expect(
      manifest.entries.some((entry) => entry.targetRelativePath === oldTargetRelativePath),
    ).toBe(false);
    expect(
      manifest.entries.some((entry) => entry.targetRelativePath === newTargetRelativePath),
    ).toBe(true);
  });

  test('build reloads generation scripts after the script source changes in the same builder', async () => {
    const builderPath = await createTempBuilder();
    const scriptPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'generate-mod-summary.ts',
    );
    const outputPath = path.join(
      builderPath,
      '.ymb-build',
      'output',
      'CommonData',
      'Text',
      'sample_pack-generated-by-mod.ndf',
    );
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await runBuild(builderPath, selection);
    expect(await Bun.file(outputPath).text()).toContain('GeneratedModSummary');

    const scriptSource = await Bun.file(scriptPath).text();
    await Bun.write(
      scriptPath,
      scriptSource.replace(
        'GeneratedModSummary is TGeneratedSummary',
        'ReloadedSummary is TGeneratedSummary',
      ),
    );

    await runBuild(builderPath, selection);
    const rebuiltOutput = await Bun.file(outputPath).text();
    expect(rebuiltOutput).toContain('ReloadedSummary');
    expect(rebuiltOutput).not.toContain('GeneratedModSummary');
  });

  test('build runs mod-level scripts before patch scripts', async () => {
    const builderPath = await createTempBuilder();
    const patchScriptPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'patch',
      'armor',
      'generate-armor-summary.ts',
    );
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await Bun.write(
      patchScriptPath,
      `export default async function generateArmorSummary(context) {
  const modSummary = await context.readTarget('CommonData/Text/sample_pack-generated-by-mod.ndf');
  return {
    targetRelativePath: 'GameData/Generated/Gameplay/ArmorSummary.ndf',
    content: \`GeneratedArmorSummary is TGeneratedSummary
(
    HasModSummary = \${modSummary.includes('GeneratedModSummary') ? 'True' : 'False'}
)
\`,
  };
}
`,
    );

    await runBuild(builderPath, selection);
    const builtArmorSummary = await Bun.file(
      path.join(
        builderPath,
        '.ymb-build',
        'output',
        'GameData',
        'Generated',
        'Gameplay',
        'ArmorSummary.ndf',
      ),
    ).text();

    expect(builtArmorSummary).toContain('HasModSummary = True');
  });

  test('build materializes replace files after patch scripts update their source files', async () => {
    const builderPath = await createTempBuilder();
    const modRootName = path.basename(path.dirname(builderPath));
    const patchScriptPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'patch',
      'armor',
      'generate-armor-summary.ts',
    );
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await Bun.write(
      patchScriptPath,
      `export default async function generateArmorSummary(context) {
  await context.writeModTextIfChanged(
    'replace/CommonData/Text/\${modRootName}-replaced.ndf',
    'Updated replace content from patch script\\n',
  );
  return {
    targetRelativePath: 'GameData/Generated/Gameplay/ArmorSummary.ndf',
    content: 'GeneratedArmorSummary is TGeneratedSummary\\n()\\n',
  };
}
`,
    );

    await runBuild(builderPath, selection);
    const builtReplace = await Bun.file(
      path.join(
        builderPath,
        '.ymb-build',
        'output',
        'CommonData',
        'Text',
        `${modRootName}-replaced.ndf`,
      ),
    ).text();

    expect(builtReplace).toContain('Updated replace content from patch script');
  });

  test('build exposes owned text helpers to patch scripts', async () => {
    const builderPath = await createTempBuilder();
    const patchScriptPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'patch',
      'armor',
      'generate-armor-summary.ts',
    );
    const patchNotesPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'patch',
      'armor',
      'notes',
      'generated.txt',
    );
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await Bun.write(
      patchScriptPath,
      `export default async function generateArmorSummary(context) {
  const missing = await context.readOwnedTextIfExists('notes/generated.txt');
  const firstWrite = await context.writeOwnedTextIfChanged(
    'notes/generated.txt',
    'owned helper text\\n',
  );
  const secondWrite = await context.writeOwnedTextIfChanged(
    'notes/generated.txt',
    'owned helper text\\n',
  );
  const stored = await context.readOwnedTextIfExists('notes/generated.txt');
  return {
    targetRelativePath: 'GameData/Generated/Gameplay/ArmorSummary.ndf',
    content: \`GeneratedArmorSummary is TGeneratedSummary
(
    MissingWasEmpty = \${missing === '' ? 'True' : 'False'}
    FirstWrite = \${firstWrite ? 'True' : 'False'}
    SecondWrite = \${secondWrite ? 'True' : 'False'}
    Stored = '\${stored.trim()}'
)
\`,
  };
}
`,
    );

    await runBuild(builderPath, selection);
    const builtArmorSummary = await Bun.file(
      path.join(
        builderPath,
        '.ymb-build',
        'output',
        'GameData',
        'Generated',
        'Gameplay',
        'ArmorSummary.ndf',
      ),
    ).text();

    expect(builtArmorSummary).toContain('MissingWasEmpty = True');
    expect(builtArmorSummary).toContain('FirstWrite = True');
    expect(builtArmorSummary).toContain('SecondWrite = False');
    expect(builtArmorSummary).toContain("Stored = 'owned helper text'");
    expect(await Bun.file(patchNotesPath).text()).toBe('owned helper text\n');
  });

  test('build exposes bulk target reads to patch scripts', async () => {
    const builderPath = await createTempBuilder();
    const patchScriptPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'patch',
      'armor',
      'generate-armor-summary.ts',
    );
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await Bun.write(
      patchScriptPath,
      `export default async function generateArmorSummary(context) {
  const targets = await context.readTargets([
    'GameData/Generated/Gameplay/Units.ndf',
    'CommonData/Text/replaced.ndf',
  ]);
  return {
    targetRelativePath: 'GameData/Generated/Gameplay/ArmorSummary.ndf',
    content: \`GeneratedArmorSummary is TGeneratedSummary
(
    HasUnits = \${targets['GameData/Generated/Gameplay/Units.ndf'].includes('Descriptor_Unit_T80U') ? 'True' : 'False'}
    HasSecondTarget = \${targets['CommonData/Text/replaced.ndf'].length > 0 ? 'True' : 'False'}
)
\`,
  };
}
`,
    );

    await runBuild(builderPath, selection);
    const builtArmorSummary = await Bun.file(
      path.join(
        builderPath,
        '.ymb-build',
        'output',
        'GameData',
        'Generated',
        'Gameplay',
        'ArmorSummary.ndf',
      ),
    ).text();

    expect(builtArmorSummary).toContain('HasUnits = True');
    expect(builtArmorSummary).toContain('HasSecondTarget = True');
  });

  test('build applies multiple same-mod patches on one file in sequence', async () => {
    const builderPath = await createTempBuilder();
    const extraPatchRoot = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'patch',
      'availability',
    );
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await mkdir(extraPatchRoot, { recursive: true });
    await Bun.write(
      path.join(extraPatchRoot, 'ymb.patch.yaml'),
      `version: 1
id: balance.availability
name: Availability Tweaks
enabled: true
scope: prod
dependsOn:
  - balance.armor
targets:
  - file: GameData/Generated/Gameplay/Units.ndf
    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: Descriptor_Unit_T80U.Availability
        value: 6
`,
    );

    await runBuild(builderPath, selection);
    const builtUnits = await Bun.file(
      path.join(
        builderPath,
        '.ymb-build',
        'output',
        'GameData',
        'Generated',
        'Gameplay',
        'Units.ndf',
      ),
    ).text();

    expect(builtUnits).toContain('FrontArmor = 7');
    expect(builtUnits).toContain('Availability = 6');
    expect(builtUnits).toContain('Descriptor_Unit_sample_pack_T80UM');
  });

  test('build evaluates template expressions inside patch values', async () => {
    const builderPath = await createTempBuilder();
    const expressionPatchRoot = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'patch',
      'expression',
    );
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await mkdir(expressionPatchRoot, { recursive: true });
    await Bun.write(
      path.join(expressionPatchRoot, 'ymb.patch.yaml'),
      `version: 1
id: balance.expression
name: Expression Tweaks
enabled: true
scope: prod
dependsOn: []
variables:
  baseArmor: 5
  extraArmor: 6
targets:
  - file: GameData/Generated/Gameplay/Units.ndf
    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: Descriptor_Unit_T80U.FrontArmor
        value: \${baseArmor + extraArmor}
`,
    );

    await runBuild(builderPath, selection);
    const builtUnits = await Bun.file(
      path.join(
        builderPath,
        '.ymb-build',
        'output',
        'GameData',
        'Generated',
        'Gameplay',
        'Units.ndf',
      ),
    ).text();

    expect(builtUnits).toContain('FrontArmor = 11');
  });

  test('build supports nested variables, indexing, and conditional expressions', async () => {
    const builderPath = await createTempBuilder();
    const expressionPatchRoot = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'patch',
      'expression-advanced',
    );
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await mkdir(expressionPatchRoot, { recursive: true });
    await Bun.write(
      path.join(expressionPatchRoot, 'ymb.patch.yaml'),
      `version: 1
id: balance.expression.advanced
name: Advanced Expression Tweaks
enabled: true
scope: prod
dependsOn: []
variables:
  stats:
    frontArmor: 7
    bonuses:
      - 2
      - 4
targets:
  - file: GameData/Generated/Gameplay/Units.ndf
    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: Descriptor_Unit_T80U.FrontArmor
        value: "\${stats.frontArmor >= 7 ? stats.frontArmor + stats.bonuses[1] : stats.frontArmor}"
      - op: modify
        selector:
          kind: field
          by: path
          value: Descriptor_Unit_T80U.Availability
        value: \${sum(stats.bonuses)}
`,
    );

    await runBuild(builderPath, selection);
    const builtUnits = await Bun.file(
      path.join(
        builderPath,
        '.ymb-build',
        'output',
        'GameData',
        'Generated',
        'Gameplay',
        'Units.ndf',
      ),
    ).text();

    expect(builtUnits).toContain('FrontArmor = 11');
    expect(builtUnits).toContain('Availability = 6');
  });

  test('build lets the chosen mod win when different mods patch the same file', async () => {
    const builderPath = await createTempBuilder();
    const selection = {
      scope: 'prod' as const,
      modFilters: ['alpha_pack', 'bravo_pack'],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    for (const [modId, armorValue] of [
      ['alpha_pack', 8],
      ['bravo_pack', 12],
    ] as const) {
      const modConfigRoot = path.join(builderPath, 'mods', modId, 'config');
      const patchRoot = path.join(modConfigRoot, 'patch', 'armor');
      await mkdir(patchRoot, { recursive: true });
      await Bun.write(
        path.join(modConfigRoot, 'ymb.mod.yaml'),
        `version: 1
id: ${modId}
name: "${modId}"
enabled: true
scripts: []
`,
      );
      await Bun.write(
        path.join(patchRoot, 'ymb.patch.yaml'),
        `version: 1
id: ${modId}.armor
name: "${modId} Armor"
enabled: true
scope: prod
dependsOn: []
targets:
  - file: GameData/Generated/Gameplay/Units.ndf
    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: Descriptor_Unit_T80U.FrontArmor
        value: ${armorValue}
scripts: []
`,
      );
    }

    setPatchPriorityResolverForTesting(async () => 'bravo_pack');

    await runBuild(builderPath, selection);
    const builtUnits = await Bun.file(
      path.join(
        builderPath,
        '.ymb-build',
        'output',
        'GameData',
        'Generated',
        'Gameplay',
        'Units.ndf',
      ),
    ).text();

    expect(builtUnits).toContain('FrontArmor = 12');
  });

  test('build auto-merges non-overlapping patch previews across mods without prompting', async () => {
    const builderPath = await createTempBuilder();
    const selection = {
      scope: 'prod' as const,
      modFilters: ['alpha_pack', 'bravo_pack'],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    for (const [modId, fieldPath, value] of [
      ['alpha_pack', 'Descriptor_Unit_T80U.FrontArmor', '8'],
      ['bravo_pack', 'Descriptor_Unit_T80U.Availability', '9'],
    ] as const) {
      const modConfigRoot = path.join(builderPath, 'mods', modId, 'config');
      const patchRoot = path.join(modConfigRoot, 'patch', 'armor');
      await mkdir(patchRoot, { recursive: true });
      await Bun.write(
        path.join(modConfigRoot, 'ymb.mod.yaml'),
        `version: 1
id: ${modId}
name: "${modId}"
enabled: true
scripts: []
`,
      );
      await Bun.write(
        path.join(patchRoot, 'ymb.patch.yaml'),
        `version: 1
id: ${modId}.armor
name: "${modId} Armor"
enabled: true
scope: prod
dependsOn: []
targets:
  - file: GameData/Generated/Gameplay/Units.ndf
    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: ${fieldPath}
        value: ${value}
scripts: []
`,
      );
    }

    setPatchPriorityResolverForTesting(async () => {
      throw new Error('patch priority prompt should not be used for disjoint edits');
    });

    await runBuild(builderPath, selection);
    const builtUnits = await Bun.file(
      path.join(
        builderPath,
        '.ymb-build',
        'output',
        'GameData',
        'Generated',
        'Gameplay',
        'Units.ndf',
      ),
    ).text();

    expect(builtUnits).toContain('FrontArmor = 8');
    expect(builtUnits).toContain('Availability = 9');
  });

  test('build still rejects replace files that collide with patched outputs', async () => {
    const builderPath = await createTempBuilder();
    const replacePath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'replace',
      'GameData',
      'Generated',
      'Gameplay',
      'Units.ndf',
    );
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await mkdir(path.dirname(replacePath), { recursive: true });
    await Bun.write(replacePath, 'replaced');

    await expect(runBuild(builderPath, selection)).rejects.toThrow(
      'Replace output collides with a generated patch target',
    );
  });

  test('build merges same-target scripts when their text edits are disjoint', async () => {
    const builderPath = await createTempBuilder();
    const modConfigRoot = path.join(builderPath, 'mods', 'script-pack', 'config');
    const patchRoot = path.join(modConfigRoot, 'patch', 'scripts');
    const modRoot = path.dirname(builderPath);
    const selection = {
      scope: 'prod' as const,
      modFilters: ['script_pack'],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await mkdir(patchRoot, { recursive: true });
    await mkdir(path.join(modRoot, 'CommonData', 'Text'), { recursive: true });
    await Bun.write(
      path.join(modConfigRoot, 'ymb.mod.yaml'),
      `version: 1
id: script_pack
name: "script_pack"
enabled: true
scripts: []
`,
    );
    await Bun.write(
      path.join(patchRoot, 'ymb.patch.yaml'),
      `version: 1
id: script_pack.shared
name: "script_pack shared"
enabled: true
scope: prod
dependsOn: []
targets: []
scripts:
  - path: generate-left.ts
  - path: generate-right.ts
`,
    );
    await Bun.write(
      path.join(modRoot, 'CommonData', 'Text', 'shared-script.ndf'),
      'alpha\nbeta\ngamma\n',
    );
    await Bun.write(
      path.join(patchRoot, 'generate-left.ts'),
      `export default async function generate(context) {
  const source = await context.readTarget('CommonData/Text/shared-script.ndf');
  return {
    targetRelativePath: 'CommonData/Text/shared-script.ndf',
    content: source.replace('alpha', 'ALPHA'),
  };
}
`,
    );
    await Bun.write(
      path.join(patchRoot, 'generate-right.ts'),
      `export default async function generate(context) {
  const source = await context.readTarget('CommonData/Text/shared-script.ndf');
  return {
    targetRelativePath: 'CommonData/Text/shared-script.ndf',
    content: source.replace('gamma', 'GAMMA'),
  };
}
`,
    );

    await runBuild(builderPath, selection);
    const builtFile = await Bun.file(
      path.join(builderPath, '.ymb-build', 'output', 'CommonData', 'Text', 'shared-script.ndf'),
    ).text();

    expect(builtFile).toContain('// YMB-START');
    expect(builtFile).toContain('// YMB-MODIFY-START');
    expect(builtFile).toContain('// YMB-ORIGINAL');
    expect(builtFile).toContain('// alpha');
    expect(builtFile).toContain('// gamma');
    expect(builtFile).toContain('ALPHA\n');
    expect(builtFile).toContain('beta\n');
    expect(builtFile).toContain('GAMMA\n');
    expect(builtFile).toContain('// YMB-END');
  });

  test('build rejects same-target scripts when their text edits overlap', async () => {
    const builderPath = await createTempBuilder();
    const modConfigRoot = path.join(builderPath, 'mods', 'script-pack', 'config');
    const patchRoot = path.join(modConfigRoot, 'patch', 'scripts');
    const modRoot = path.dirname(builderPath);
    const selection = {
      scope: 'prod' as const,
      modFilters: ['script_pack'],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await mkdir(patchRoot, { recursive: true });
    await mkdir(path.join(modRoot, 'CommonData', 'Text'), { recursive: true });
    await Bun.write(
      path.join(modConfigRoot, 'ymb.mod.yaml'),
      `version: 1
id: script_pack
name: "script_pack"
enabled: true
scripts: []
`,
    );
    await Bun.write(
      path.join(patchRoot, 'ymb.patch.yaml'),
      `version: 1
id: script_pack.shared
name: "script_pack shared"
enabled: true
scope: prod
dependsOn: []
targets: []
scripts:
  - path: generate-left.ts
  - path: generate-right.ts
`,
    );
    await Bun.write(
      path.join(modRoot, 'CommonData', 'Text', 'shared-script.ndf'),
      'alpha\nbeta\ngamma\n',
    );
    await Bun.write(
      path.join(patchRoot, 'generate-left.ts'),
      `export default async function generate(context) {
  const source = await context.readTarget('CommonData/Text/shared-script.ndf');
  return {
    targetRelativePath: 'CommonData/Text/shared-script.ndf',
    content: source.replace('beta', 'LEFT'),
  };
}
`,
    );
    await Bun.write(
      path.join(patchRoot, 'generate-right.ts'),
      `export default async function generate(context) {
  return {
    targetRelativePath: 'CommonData/Text/shared-script.ndf',
    content: 'alpha\\nRIGHT\\ngamma\\n',
  };
}
`,
    );

    await expect(runBuild(builderPath, selection)).rejects.toThrow(
      'Script output overlaps with another generated script contribution',
    );
  });

  test('build rejects same-target binary script collisions', async () => {
    const builderPath = await createTempBuilder();
    const modConfigRoot = path.join(builderPath, 'mods', 'script-pack', 'config');
    const patchRoot = path.join(modConfigRoot, 'patch', 'scripts');
    const selection = {
      scope: 'prod' as const,
      modFilters: ['script_pack'],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await mkdir(patchRoot, { recursive: true });
    await Bun.write(
      path.join(modConfigRoot, 'ymb.mod.yaml'),
      `version: 1
id: script_pack
name: "script_pack"
enabled: true
scripts: []
`,
    );
    await Bun.write(
      path.join(patchRoot, 'ymb.patch.yaml'),
      `version: 1
id: script_pack.shared
name: "script_pack shared"
enabled: true
scope: prod
dependsOn: []
targets: []
scripts:
  - path: generate-left.ts
  - path: generate-right.ts
`,
    );
    await Bun.write(
      path.join(patchRoot, 'generate-left.ts'),
      `export default function generate() {
  return {
    targetRelativePath: 'GameData/Assets/Binary/shared.bin',
    content: new Uint8Array([1, 2, 3]),
  };
}
`,
    );
    await Bun.write(
      path.join(patchRoot, 'generate-right.ts'),
      `export default function generate() {
  return {
    targetRelativePath: 'GameData/Assets/Binary/shared.bin',
    content: new Uint8Array([4, 5, 6]),
  };
}
`,
    );

    await expect(runBuild(builderPath, selection)).rejects.toThrow(
      'Script output collides with an existing generated target',
    );
  });

  test('recover combines mod and patch filters instead of matching only one of them', async () => {
    const builderPath = await createTempBuilder();
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await runSync(builderPath, selection);

    const filteredRecoverLines = await runRecover(builderPath, {
      ...selection,
      modFilters: ['sample_pack'],
      patchFilters: ['missing.patch'],
    });
    expect(filteredRecoverLines).toHaveLength(0);

    const syncedFile = await Bun.file(
      path.join(path.dirname(builderPath), 'GameData', 'Generated', 'Gameplay', 'Units.ndf'),
    ).text();
    expect(syncedFile).toContain('// YMB-START');
  });

  test('recover accepts exact mod names as well as mod ids', async () => {
    const builderPath = await createTempBuilder();
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await runSync(builderPath, selection);

    const recoverLines = await runRecover(builderPath, {
      ...selection,
      modFilters: ['Sample Pack'],
    });
    expect(recoverLines).toContain('restore -> GameData/Generated/Gameplay/Units.ndf');

    const recoveredFile = await Bun.file(
      path.join(path.dirname(builderPath), 'GameData', 'Generated', 'Gameplay', 'Units.ndf'),
    ).text();
    expect(recoveredFile).not.toContain('YMB-START');
    expect(recoveredFile).toContain('FrontArmor = 5');
  });

  test('recover matches mod names case-insensitively like selection filters', async () => {
    const builderPath = await createTempBuilder();
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await runSync(builderPath, selection);

    const recoverLines = await runRecover(builderPath, {
      ...selection,
      modFilters: ['sample pack'],
    });
    expect(recoverLines).toContain('restore -> GameData/Generated/Gameplay/Units.ndf');
  });

  test('dry-run recover reports the planned restore and delete counts', async () => {
    const builderPath = await createTempBuilder();
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await runSync(builderPath, selection);

    const recoverLines = await runRecover(builderPath, {
      ...selection,
      dryRun: true,
    });

    expect(recoverLines.summary ?? []).toContain(
      'recover: 1 restored | 3 deleted generated | 4 remaining tracked',
    );
    expect(recoverLines).toContain('restore -> GameData/Generated/Gameplay/Units.ndf');
    expect(recoverLines).toContain(
      'delete generated -> GameData/Generated/Gameplay/ArmorSummary.ndf',
    );
  });

  test('recover deletes consumed backup files after restoring the originals', async () => {
    const builderPath = await createTempBuilder();
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };
    const originalsRoot = path.join(builderPath, '.ymb-state', 'originals');

    await runSync(builderPath, selection);
    expect((await readdir(originalsRoot)).length).toBeGreaterThan(0);

    await runRecover(builderPath, selection);
    expect(await readdir(originalsRoot)).toHaveLength(0);
  });

  test('resync fails fast when a tracked original backup is missing', async () => {
    const builderPath = await createTempBuilder();
    const scriptPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'generate-mod-summary.ts',
    );
    const manifestPath = path.join(builderPath, '.ymb-state', 'manifest.json');
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await runSync(builderPath, selection);

    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as {
      entries: Array<{ targetRelativePath: string; backupFileName: string }>;
    };
    const backupFileName = manifest.entries.find(
      (entry) => entry.targetRelativePath === 'CommonData/Text/sample_pack-generated-by-mod.ndf',
    )?.backupFileName;
    expect(backupFileName).toBeTruthy();
    await rm(path.join(builderPath, '.ymb-state', 'originals', String(backupFileName)), {
      force: true,
    });

    const scriptSource = await Bun.file(scriptPath).text();
    await Bun.write(
      scriptPath,
      scriptSource.replace(
        'GeneratedModSummary is TGeneratedSummary',
        'UpdatedModSummary is TGeneratedSummary',
      ),
    );

    await expect(runSync(builderPath, selection)).rejects.toThrow(
      'Missing tracked original backup',
    );
  });

  test('resync fails fast when a tracked live file has malformed YMB markers', async () => {
    const builderPath = await createTempBuilder();
    const targetPath = path.join(
      path.dirname(builderPath),
      'CommonData',
      'Text',
      'sample_pack-generated-by-mod.ndf',
    );
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await runSync(builderPath, selection);
    const trackedContent = await Bun.file(targetPath).text();
    await Bun.write(targetPath, trackedContent.replace('// YMB-END', '// YMB-FINISH'));

    await expect(runSync(builderPath, selection)).rejects.toThrow(
      'The live tracked file contains malformed YMB markers',
    );
  });

  test('resync fails fast when a tracked live NDF file becomes corrupted', async () => {
    const builderPath = await createTempBuilder();
    const targetPath = path.join(
      path.dirname(builderPath),
      'CommonData',
      'Text',
      'sample_pack-generated-by-mod.ndf',
    );
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await runSync(builderPath, selection);
    const trackedContent = await Bun.file(targetPath).text();
    await Bun.write(targetPath, trackedContent.replace('// YMB-END', ']\n// YMB-END'));

    await expect(runSync(builderPath, selection)).rejects.toThrow('Unbalanced delimiter `]`');
  });

  test('validate fails fast when an original patch target NDF file is corrupted', async () => {
    const builderPath = await createTempBuilder();
    const sourceTargetPath = path.join(
      path.dirname(builderPath),
      'GameData',
      'Generated',
      'Gameplay',
      'Units.ndf',
    );
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: true,
      verbose: false,
      yes: false,
    };

    const originalContent = await Bun.file(sourceTargetPath).text();
    await Bun.write(sourceTargetPath, `${originalContent}\n]\n`);

    await expect(runValidate(builderPath, selection)).rejects.toThrow('Unbalanced delimiter `]`');
  });

  test('validate and build reject invalid script outputs with uppercase .NDF targets', async () => {
    const builderPath = await createTempBuilder();
    const selection = {
      scope: 'prod' as const,
      modFilters: ['uppercase_script_pack'],
      patchFilters: [],
      dryRun: true,
      verbose: false,
      yes: false,
    };

    await writeModFixture(builderPath, 'uppercase-script-pack', {
      'config/ymb.mod.yaml': `version: 1
id: uppercase_script_pack
name: Uppercase Script Pack
enabled: true
scripts:
  - path: generate-uppercase.ts
`,
      'config/generate-uppercase.ts': `export default function generate() {
  return {
    targetRelativePath: 'CommonData/Text/BROKEN.NDF',
    content: 'BrokenUppercase is TBroken\\n(\\n]\\n',
  };
}
`,
    });

    await expect(runValidate(builderPath, selection)).rejects.toThrow('Unbalanced delimiter `]`');
    await expect(
      runBuild(builderPath, {
        ...selection,
        dryRun: false,
      }),
    ).rejects.toThrow('Unbalanced delimiter `]`');
  });

  test('validate and build reject invalid replace outputs with uppercase .NDF targets', async () => {
    const builderPath = await createTempBuilder();
    const selection = {
      scope: 'prod' as const,
      modFilters: ['uppercase_replace_pack'],
      patchFilters: [],
      dryRun: true,
      verbose: false,
      yes: false,
    };

    await writeModFixture(builderPath, 'uppercase-replace-pack', {
      'config/ymb.mod.yaml': `version: 1
id: uppercase_replace_pack
name: Uppercase Replace Pack
enabled: true
scripts: []
`,
      'config/replace/CommonData/Text/BROKEN.NDF': 'BrokenUppercase is TBroken\n(\n]\n',
    });

    await expect(runValidate(builderPath, selection)).rejects.toThrow('Unbalanced delimiter `]`');
    await expect(
      runBuild(builderPath, {
        ...selection,
        dryRun: false,
      }),
    ).rejects.toThrow('Unbalanced delimiter `]`');
  });

  test('build rejects generated targets that escape the game roots', async () => {
    const builderPath = await createTempBuilder();
    const scriptPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'generate-mod-summary.ts',
    );
    const scriptSource = await Bun.file(scriptPath).text();
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await Bun.write(
      scriptPath,
      scriptSource.replace(
        'targetRelativePath: summaryTarget',
        "targetRelativePath: 'GameData/../../escaped.ndf'",
      ),
    );

    await expect(runBuild(builderPath, selection)).rejects.toThrow(
      'Path must stay inside its mod root',
    );
  });

  test('build rejects scripts that resolve files outside their owner root', async () => {
    const builderPath = await createTempBuilder();
    const scriptPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'generate-mod-summary.ts',
    );
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await Bun.write(
      scriptPath,
      `export default function generate(context) {
  context.resolvePath('../README.md');
  return {
    targetRelativePath: 'CommonData/Text/sample_pack-generated-by-mod.ndf',
    content: 'GeneratedModSummary is TGeneratedSummary\\n()\\n',
  };
}
`,
    );

    await expect(runBuild(builderPath, selection)).rejects.toThrow(
      'Path must stay inside its source mod config root',
    );
  });

  test('build lets a higher-priority mod overwrite an earlier replace output', async () => {
    const builderPath = await createTempBuilder();
    const modRootName = path.basename(path.dirname(builderPath));
    const sampleModConfigPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'ymb.mod.yaml',
    );
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await Bun.write(
      sampleModConfigPath,
      `version: 1
id: sample_pack
name: Sample Pack
priority: 0
allowWriteToModifiedFiles: true
variables:
  generatedUnitsTarget: GameData/Generated/Gameplay/Units.ndf
  replaceTarget: CommonData/Text/\${modRootName}-replaced.ndf
  summaryTarget: CommonData/Text/\${modId}-generated-by-mod.ndf
enabled: true
scripts:
  - path: generate-mod-summary.ts
    tests:
      - generate-mod-summary.test.ts
tempPaths:
  - .ymb-mod-temp.txt
`,
    );
    await writeModFixture(builderPath, 'priority-pack', {
      'config/ymb.mod.yaml': `version: 1
id: priority_pack
name: Priority Pack
priority: 1
allowWriteToModifiedFiles: true
enabled: true
scripts: []
`,
      [`config/replace/CommonData/Text/${modRootName}-replaced.ndf`]: 'Priority replace content\n',
    });

    await runBuild(builderPath, selection);

    const replacedFile = await Bun.file(
      path.join(
        builderPath,
        '.ymb-build',
        'output',
        'CommonData',
        'Text',
        `${modRootName}-replaced.ndf`,
      ),
    ).text();
    expect(replacedFile).toContain('Priority replace content');
    expect(replacedFile).not.toContain('Replaced content for Sample Pack');
  });

  test('build falls back to normal patch conflict resolution when different priorities do not opt into layered writes', async () => {
    const builderPath = await createTempBuilder();
    let usedPriorityResolver = false;
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await writeModFixture(builderPath, 'priority-pack', {
      'config/ymb.mod.yaml': `version: 1
id: priority_pack
name: Priority Pack
priority: 1
allowWriteToModifiedFiles: false
enabled: true
scripts: []
`,
      'config/patch/priority/ymb.patch.yaml': `version: 1
id: priority.overwrite
name: Priority Overwrite
enabled: true
scope: prod
dependsOn: []
targets:
  - file: GameData/Generated/Gameplay/Units.ndf
    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: Descriptor_Unit_T80U.FrontArmor
        value: 11
`,
    });

    setPatchPriorityResolverForTesting(async () => {
      usedPriorityResolver = true;
      return 'priority_pack';
    });
    await runBuild(builderPath, selection);

    const builtUnits = await Bun.file(
      path.join(
        builderPath,
        '.ymb-build',
        'output',
        'GameData',
        'Generated',
        'Gameplay',
        'Units.ndf',
      ),
    ).text();
    expect(usedPriorityResolver).toBe(true);
    expect(builtUnits).toContain('FrontArmor = 11');
    expect(builtUnits).toContain('Descriptor_Unit_sample_pack_T80UM');
  });

  test('build falls back to normal patch conflict resolution when only the later priority mod opts into layered writes', async () => {
    const builderPath = await createTempBuilder();
    let usedPriorityResolver = false;
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await writeModFixture(builderPath, 'priority-pack', {
      'config/ymb.mod.yaml': `version: 1
id: priority_pack
name: Priority Pack
priority: 1
allowWriteToModifiedFiles: true
enabled: true
scripts: []
`,
      'config/patch/priority/ymb.patch.yaml': `version: 1
id: priority.partial-layer
name: Priority Partial Layer
enabled: true
scope: prod
dependsOn: []
targets:
  - file: GameData/Generated/Gameplay/Units.ndf
    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: Descriptor_Unit_T80U.FrontArmor
        value: 13
`,
    });

    setPatchPriorityResolverForTesting(async () => {
      usedPriorityResolver = true;
      return 'priority_pack';
    });
    await runBuild(builderPath, selection);

    const builtUnits = await Bun.file(
      path.join(
        builderPath,
        '.ymb-build',
        'output',
        'GameData',
        'Generated',
        'Gameplay',
        'Units.ndf',
      ),
    ).text();
    expect(usedPriorityResolver).toBe(true);
    expect(builtUnits).toContain('FrontArmor = 13');
    expect(builtUnits).toContain('Descriptor_Unit_sample_pack_T80UM');
  });

  test('build preserves earlier patch outputs when the later mod reads modified files', async () => {
    const builderPath = await createTempBuilder();
    const sampleModConfigPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'ymb.mod.yaml',
    );
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await Bun.write(
      sampleModConfigPath,
      `version: 1
id: sample_pack
name: Sample Pack
priority: 0
allowWriteToModifiedFiles: true
variables:
  generatedUnitsTarget: GameData/Generated/Gameplay/Units.ndf
  replaceTarget: CommonData/Text/\${modRootName}-replaced.ndf
  summaryTarget: CommonData/Text/\${modId}-generated-by-mod.ndf
enabled: true
scripts:
  - path: generate-mod-summary.ts
    tests:
      - generate-mod-summary.test.ts
tempPaths:
  - .ymb-mod-temp.txt
`,
    );
    await writeModFixture(builderPath, 'priority-pack', {
      'config/ymb.mod.yaml': `version: 1
id: priority_pack
name: Priority Pack
priority: 1
allowWriteToModifiedFiles: true
enabled: true
scripts: []
`,
      'config/patch/priority/ymb.patch.yaml': `version: 1
id: priority.layered
name: Priority Layered
enabled: true
scope: prod
dependsOn: []
targets:
  - file: GameData/Generated/Gameplay/Units.ndf
    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: Descriptor_Unit_T80U.FrontArmor
        value: 11
`,
    });

    await runBuild(builderPath, selection);

    const builtUnits = await Bun.file(
      path.join(
        builderPath,
        '.ymb-build',
        'output',
        'GameData',
        'Generated',
        'Gameplay',
        'Units.ndf',
      ),
    ).text();
    expect(builtUnits).toContain('FrontArmor = 11');
    expect(builtUnits).toContain('Descriptor_Unit_sample_pack_T80UM');
  });

  test('build lets a dependency-ordered mod layer over its dependency when both mods opt into modified writes', async () => {
    const builderPath = await createTempBuilder();
    const sampleModConfigPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'ymb.mod.yaml',
    );
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await Bun.write(
      sampleModConfigPath,
      `version: 1
id: sample_pack
name: Sample Pack
priority: 0
allowWriteToModifiedFiles: true
variables:
  generatedUnitsTarget: GameData/Generated/Gameplay/Units.ndf
  replaceTarget: CommonData/Text/\${modRootName}-replaced.ndf
  summaryTarget: CommonData/Text/\${modId}-generated-by-mod.ndf
enabled: true
scripts:
  - path: generate-mod-summary.ts
    tests:
      - generate-mod-summary.test.ts
tempPaths:
  - .ymb-mod-temp.txt
`,
    );
    await writeModFixture(builderPath, 'dependent-pack', {
      'config/ymb.mod.yaml': `version: 1
id: dependent_pack
name: Dependent Pack
dependsOn:
  - sample_pack
priority: 0
allowWriteToModifiedFiles: true
enabled: true
scripts: []
`,
      'config/patch/dependent/ymb.patch.yaml': `version: 1
id: dependent.layer
name: Dependent Layer
enabled: true
scope: prod
dependsOn: []
targets:
  - file: GameData/Generated/Gameplay/Units.ndf
    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: Descriptor_Unit_T80U.FrontArmor
        value: 14
`,
    });

    await runBuild(builderPath, selection);

    const builtUnits = await Bun.file(
      path.join(
        builderPath,
        '.ymb-build',
        'output',
        'GameData',
        'Generated',
        'Gameplay',
        'Units.ndf',
      ),
    ).text();
    expect(builtUnits).toContain('FrontArmor = 14');
    expect(builtUnits).toContain('Descriptor_Unit_sample_pack_T80UM');
  });

  test('build recommends allowWriteToModifiedFiles when an ordered replace collision is not opted into', async () => {
    const builderPath = await createTempBuilder();
    const modRootName = path.basename(path.dirname(builderPath));
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await writeModFixture(builderPath, 'priority-pack', {
      'config/ymb.mod.yaml': `version: 1
id: priority_pack
name: Priority Pack
priority: 1
allowWriteToModifiedFiles: true
enabled: true
scripts: []
`,
      [`config/replace/CommonData/Text/${modRootName}-replaced.ndf`]: 'Priority replace content\n',
    });

    await expect(runBuild(builderPath, selection)).rejects.toThrow('allowWriteToModifiedFiles');
  });

  test('build recommends allowWriteToModifiedFiles when a dependency collision is not opted into', async () => {
    const builderPath = await createTempBuilder();
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await writeModFixture(builderPath, 'dependent-pack', {
      'config/ymb.mod.yaml': `version: 1
id: dependent_pack
name: Dependent Pack
dependsOn:
  - sample_pack
priority: 0
enabled: true
scripts: []
`,
      'config/replace/GameData/Generated/Gameplay/Units.ndf': 'replacement that collides\n',
    });

    await expect(runBuild(builderPath, selection)).rejects.toThrow('allowWriteToModifiedFiles');
  });

  test('build exposes lower-priority generated inputs to later mod scripts only when allowed', async () => {
    const falseBuilderPath = await createTempBuilder();
    const trueBuilderPath = await createTempBuilder();
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: false,
    };

    await writeModFixture(falseBuilderPath, 'script-reader-pack', {
      'config/ymb.mod.yaml': `version: 1
id: script_reader_pack
name: Script Reader Pack
priority: 1
allowWriteToModifiedFiles: false
enabled: true
scripts:
  - path: generate-priority-summary.ts
`,
      'config/generate-priority-summary.ts': `export default async function generate(context) {
  const units = await context.readTarget('GameData/Generated/Gameplay/Units.ndf');
  return {
    targetRelativePath: 'CommonData/Text/priority-summary.ndf',
    content: \`PrioritySummary is TGeneratedSummary\\n(\\n    SawClone = \${units.includes('Descriptor_Unit_sample_pack_T80UM') ? 'True' : 'False'}\\n)\\n\`,
  };
}
`,
    });
    await writeModFixture(trueBuilderPath, 'script-reader-pack', {
      'config/ymb.mod.yaml': `version: 1
id: script_reader_pack
name: Script Reader Pack
priority: 1
allowWriteToModifiedFiles: true
enabled: true
scripts:
  - path: generate-priority-summary.ts
`,
      'config/generate-priority-summary.ts': `export default async function generate(context) {
  const units = await context.readTarget('GameData/Generated/Gameplay/Units.ndf');
  return {
    targetRelativePath: 'CommonData/Text/priority-summary.ndf',
    content: \`PrioritySummary is TGeneratedSummary\\n(\\n    SawClone = \${units.includes('Descriptor_Unit_sample_pack_T80UM') ? 'True' : 'False'}\\n)\\n\`,
  };
}
`,
    });

    await runBuild(falseBuilderPath, selection);
    await runBuild(trueBuilderPath, selection);

    const falseSummary = await Bun.file(
      path.join(
        falseBuilderPath,
        '.ymb-build',
        'output',
        'CommonData',
        'Text',
        'priority-summary.ndf',
      ),
    ).text();
    const trueSummary = await Bun.file(
      path.join(
        trueBuilderPath,
        '.ymb-build',
        'output',
        'CommonData',
        'Text',
        'priority-summary.ndf',
      ),
    ).text();
    expect(falseSummary).toContain('SawClone = False');
    expect(trueSummary).toContain('SawClone = True');
  });
});
