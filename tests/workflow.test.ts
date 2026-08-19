import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, readdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { runBuild, runCleanup, runRecover, runSync, runValidate } from '../src/engine/commands.ts';
import { YmbError } from '../src/errors.ts';
import { setPatchPriorityResolverForTests } from '../src/patch-priority.ts';
import { formatDetailLine } from '../src/report/detail.ts';
import { formatFindingGroups, toObsoleteTargetFindings } from '../src/report/findings.ts';
import {
  cleanupTempRoots,
  createAbstractBuilderWorkspace,
  createSelection,
  sampleModConfigPath,
  summaryText,
  summaryValue,
  syntheticBuilderPath,
  writeModFixture,
  writeWorkspaceFiles,
} from './helpers/abstract-builder.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  setPatchPriorityResolverForTests(undefined);
  await cleanupTempRoots(tempRoots);
});

async function createTempBuilder(): Promise<string> {
  return (await createAbstractBuilderWorkspace(tempRoots)).builderPath;
}

function buildOutputPath(builderPath: string, ...segments: string[]): string {
  return path.join(builderPath, '.ymb-build', 'output', ...segments);
}

async function writeSamplePackConfig(
  builderPath: string,
  allowWriteToModifiedFiles: boolean,
): Promise<void> {
  await Bun.write(
    sampleModConfigPath(builderPath, 'ymb.mod.yaml'),
    `version: 1
id: sample_pack
name: Sample Pack
priority: 0
${allowWriteToModifiedFiles ? 'allowWriteToModifiedFiles: true\n' : ''}variables:
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
}

async function writeTwoScriptFixture(
  builderPath: string,
  leftScript: string,
  rightScript: string,
  targetContent?: string,
): Promise<void> {
  await writeModFixture(builderPath, 'script-pack', {
    'config/ymb.mod.yaml': `version: 1
id: script_pack
name: "script_pack"
enabled: true
scripts: []
`,
    'config/patch/scripts/ymb.patch.yaml': `version: 1
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
    'config/patch/scripts/generate-left.ts': leftScript,
    'config/patch/scripts/generate-right.ts': rightScript,
  });
  if (targetContent !== undefined) {
    await writeWorkspaceFiles(path.dirname(builderPath), {
      'CommonData/Text/shared-script.ndf': targetContent,
    });
  }
}

async function writeLargeLayerBase(builderPath: string, target: string): Promise<void> {
  const baseContent = Array.from(
    { length: 3000 },
    (_, index) => `base_line_${index}_padding_padding\n`,
  ).join('');
  await writeModFixture(builderPath, 'base-layer', {
    'config/ymb.mod.yaml': `version: 1
id: base_layer
name: Base Layer
priority: 1
allowWriteToModifiedFiles: true
enabled: true
`,
    [`config/replace/${target}`]: baseContent,
  });
}

async function writeFieldPatchMods(
  builderPath: string,
  entries: readonly (readonly [modId: string, fieldPath: string, value: string | number])[],
): Promise<void> {
  for (const [modId, fieldPath, value] of entries) {
    await writeModFixture(builderPath, modId, {
      'config/ymb.mod.yaml': `version: 1
id: ${modId}
name: "${modId}"
enabled: true
scripts: []
`,
      'config/patch/armor/ymb.patch.yaml': `version: 1
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
    });
  }
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
    const selection = createSelection();

    const buildLines = await runBuild(builderPath, selection);
    expect(buildLines.join('\n')).toContain(
      formatDetailLine('patched', 'GameData/Generated/Gameplay/Units.ndf'),
    );
    expect(buildLines.join('\n')).toContain(
      formatDetailLine('generated', 'GameData/Generated/Gameplay/ArmorSummary.ndf'),
    );
    expect(buildLines.join('\n')).toContain(
      formatDetailLine('generated', 'CommonData/Text/sample_pack-generated-by-mod.ndf'),
    );

    const builtFile = await Bun.file(
      buildOutputPath(builderPath, 'GameData', 'Generated', 'Gameplay', 'Units.ndf'),
    ).text();
    expect(builtFile).toContain('// YMB-START');
    expect(builtFile).toContain('FrontArmor = 7');
    expect(builtFile).toContain('Descriptor_Unit_sample_pack_T80UM');

    const builtArmorSummary = await Bun.file(
      buildOutputPath(builderPath, 'GameData', 'Generated', 'Gameplay', 'ArmorSummary.ndf'),
    ).text();
    expect(builtArmorSummary).toContain('// YMB-START');
    expect(builtArmorSummary).toContain('// YMB-ADD-START');
    expect(builtArmorSummary).toContain('ArmorBonus = 7');
    expect(builtArmorSummary).toContain('ContainsClone = True');

    const builtModSummary = await Bun.file(
      buildOutputPath(builderPath, 'CommonData', 'Text', 'sample_pack-generated-by-mod.ndf'),
    ).text();
    expect(builtModSummary).toContain('// YMB-START');
    expect(builtModSummary).toContain('// YMB-ADD-START');
    expect(builtModSummary).toContain('Label = "Sample Pack"');
    expect(builtModSummary).toContain('Text = "Replaced content for Sample Pack"');

    const builtReplaceFile = await Bun.file(
      buildOutputPath(builderPath, 'CommonData', 'Text', `${modRootName}-replaced.ndf`),
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

  test('a full-file script over a markerless lower-layer base replaces instead of blowing the merge budget', async () => {
    const builderPath = await createTempBuilder();
    const target = 'GameData/Generated/Gameplay/Decks/BigGenerated.ndf';
    await writeLargeLayerBase(builderPath, target);

    await writeModFixture(builderPath, 'regen-layer', {
      'config/ymb.mod.yaml': `version: 1
id: regen_layer
name: Regen Layer
priority: 2
allowWriteToModifiedFiles: true
dependsOn:
  - base_layer
enabled: true
scripts:
  - path: regenerate.ts
`,
      'config/regenerate.ts': `export default async function regenerate(): Promise<{
  targetRelativePath: string;
  content: string;
}> {
  let content = '';
  for (let index = 0; index < 3000; index += 1) {
    content += \`gen_line_\${index}_generated_generated\\n\`;
  }
  return { targetRelativePath: '${target}', content };
}
`,
    });

    const selection = createSelection({ modFilters: ['base_layer', 'regen_layer'] });
    await runBuild(builderPath, selection);

    const built = await Bun.file(buildOutputPath(builderPath, ...target.split('/'))).text();
    expect(built).toContain('gen_line_0_generated_generated');
    expect(built).toContain('gen_line_2999_generated_generated');
    expect(built).not.toContain('base_line_');
  });

  test('large markerless scripts can transform the current target sequentially without cumulative re-diffs', async () => {
    const builderPath = await createTempBuilder();
    const target = 'GameData/Generated/Gameplay/Decks/BigGenerated.ndf';
    await writeLargeLayerBase(builderPath, target);

    await writeModFixture(builderPath, 'regen-layer', {
      'config/ymb.mod.yaml': `version: 1
id: regen_layer
name: Regen Layer
priority: 2
allowWriteToModifiedFiles: true
dependsOn:
  - base_layer
enabled: true
scripts:
  - path: regenerate.ts
  - path: finalize.ts
`,
      'config/regenerate.ts': `export default async function regenerate(context) {
  await context.readTarget('${target}');
  const content = Array.from(
    { length: 3000 },
    (_, index) => 'gen_line_' + index + '_generated_generated' + String.fromCharCode(10),
  ).join('');
  return { targetRelativePath: '${target}', content };
}
`,
      'config/finalize.ts': `export default async function finalize(context) {
  const content = await context.readTarget('${target}');
  return {
    targetRelativePath: '${target}',
    content: content
      .replace('gen_line_0_generated_generated', 'final_line_0')
      .replace('gen_line_2999_generated_generated', 'final_line_2999'),
  };
}
`,
    });

    const selection = createSelection({ modFilters: ['base_layer', 'regen_layer'] });
    await runBuild(builderPath, selection);

    const built = await Bun.file(buildOutputPath(builderPath, ...target.split('/'))).text();
    expect(built).toContain('final_line_0');
    expect(built).toContain('gen_line_1500_generated_generated');
    expect(built).toContain('final_line_2999');
    expect(built).not.toContain('base_line_');
    expect(built).toContain('"modId":"base_layer"');
    expect(built).toContain('"modId":"regen_layer"');
  });

  test('an independent writer still conflicts after a markerless full-file transformation', async () => {
    const builderPath = await createTempBuilder();
    const target = 'CommonData/Text/layered.txt';

    await writeModFixture(builderPath, 'base-layer', {
      'config/ymb.mod.yaml': `version: 1
id: base_layer
name: Base Layer
priority: 1
allowWriteToModifiedFiles: true
enabled: true
`,
      [`config/replace/${target}`]: 'alpha\nbeta\ngamma\n',
    });
    await writeModFixture(builderPath, 'writers', {
      'config/ymb.mod.yaml': `version: 1
id: writers
name: Writers
priority: 2
allowWriteToModifiedFiles: true
dependsOn:
  - base_layer
enabled: true
scripts:
  - path: transform.ts
  - path: independent.ts
`,
      'config/transform.ts': `export default async function transform(context) {
  await context.readTarget('${target}');
  return { targetRelativePath: '${target}', content: 'one\\ntwo\\nthree\\n' };
}
`,
      'config/independent.ts': `export default async function independent() {
  return { targetRelativePath: '${target}', content: 'one\\nOTHER\\nthree\\n' };
}
`,
    });

    const selection = createSelection({ modFilters: ['base_layer', 'writers'] });
    await expect(runBuild(builderPath, selection)).rejects.toThrow(
      'Script output overlaps with another generated script contribution',
    );
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
      formatDetailLine(
        'test ok',
        'generate-mod-summary.test.ts :: mod-level summary script returns the expected output',
      ),
    );
    expect(validateLines).toContain(
      formatDetailLine(
        'test ok',
        'generate-armor-summary.test.ts :: patch-level armor summary script returns the expected output',
      ),
    );

    const buildLines = await runBuild(builderPath, buildSelection);
    expect(buildLines).toContain(
      formatDetailLine(
        'test ok',
        'generate-mod-summary.test.ts :: mod-level summary script returns the expected output',
      ),
    );
    expect(buildLines).toContain(
      formatDetailLine(
        'test ok',
        'generate-armor-summary.test.ts :: patch-level armor summary script returns the expected output',
      ),
    );

    // `sync` repeats the selection `build` just ran, so it answers both tests
    // from cache - the `*` is how a detail line says so.
    const syncLines = await runSync(builderPath, buildSelection);
    expect(syncLines).toContain(
      formatDetailLine(
        'test ok*',
        'generate-mod-summary.test.ts :: mod-level summary script returns the expected output',
      ),
    );
    expect(syncLines).toContain(
      formatDetailLine(
        'test ok*',
        'generate-armor-summary.test.ts :: patch-level armor summary script returns the expected output',
      ),
    );
  });

  test('a repeated run answers its script tests from cache', async () => {
    const builderPath = await createTempBuilder();
    const validateSelection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: true,
      verbose: false,
      yes: false,
    };

    // Nothing is cached the first time...
    const firstRun = await runValidate(builderPath, validateSelection);
    expect(firstRun.some((line) => line.startsWith('test ok*'))).toBe(false);

    // ...and the entry has to outlive the prune that closes every command, or
    // the second run recomputes exactly what the first one already knew.
    const secondRun = await runValidate(builderPath, validateSelection);
    expect(secondRun).toContain(
      formatDetailLine(
        'test ok*',
        'generate-mod-summary.test.ts :: mod-level summary script returns the expected output',
      ),
    );
    expect(secondRun).toContain(
      formatDetailLine(
        'test ok*',
        'generate-armor-summary.test.ts :: patch-level armor summary script returns the expected output',
      ),
    );

    // A run that bypasses the cache runs them for real again.
    const bypassed = await runValidate(builderPath, { ...validateSelection, useCache: false });
    expect(bypassed.some((line) => line.startsWith('test ok*'))).toBe(false);
  });

  test('cached script tests invalidate every context and owned-file input they read', async () => {
    const builderPath = await createTempBuilder();
    const modConfigPath = sampleModConfigPath(builderPath, 'ymb.mod.yaml');
    const testPath = sampleModConfigPath(builderPath, 'generate-mod-summary.test.ts');
    const expectationPath = sampleModConfigPath(builderPath, 'cache-expectation.txt');
    const unitsPath = path.join(
      path.dirname(builderPath),
      'GameData',
      'Generated',
      'Gameplay',
      'Units.ndf',
    );
    const builderConfigPath = path.join(builderPath, 'ymb.config.yaml');
    const selection = createSelection({ dryRun: true });

    const modConfig = await Bun.file(modConfigPath).text();
    await Bun.write(
      modConfigPath,
      modConfig.replace(
        'name: Sample Pack\n',
        `name: Sample Pack
readValues:
  currentArmor:
    file: GameData/Generated/Gameplay/Units.ndf
    path: Descriptor_Unit_T80U.FrontArmor
`,
      ),
    );
    await Bun.write(expectationPath, 'expected\n');
    await Bun.write(
      testPath,
      `export default async function test(context: {
  builder: { stateRoot: string };
  selection: { verbose: boolean };
  variables: Record<string, unknown>;
  writeOwnedTextIfChanged(path: string, content: string): Promise<boolean>;
}) {
  const expectationChanged = await context.writeOwnedTextIfChanged(
    'cache-expectation.txt',
    'expected\\n',
  );
  const valid =
    !context.selection.verbose &&
    context.variables.currentArmor === 5 &&
    context.builder.stateRoot.endsWith('.ymb-state') &&
    !expectationChanged;

  return {
    results: [
      valid
        ? { name: 'every cache input is current', status: 'passed' as const }
        : {
            name: 'every cache input is current',
            status: 'failed' as const,
            reason: 'A script-test input changed.',
            suggestion: 'Re-run the script test with its current inputs.',
          },
    ],
  };
}
`,
    );

    const firstRun = await runValidate(builderPath, selection);
    expect(firstRun).toContain(
      formatDetailLine('test ok', 'generate-mod-summary.test.ts :: every cache input is current'),
    );

    await expect(runValidate(builderPath, { ...selection, verbose: true })).rejects.toThrow(
      'A script-test input changed.',
    );

    await Bun.write(builderConfigPath, 'version: 1\npaths:\n  recoveryRoot: .ymb-other-state\n');
    await expect(runValidate(builderPath, selection)).rejects.toThrow(
      'A script-test input changed.',
    );

    await Bun.write(builderConfigPath, 'version: 1\n');
    const originalUnits = await Bun.file(unitsPath).text();
    await Bun.write(unitsPath, originalUnits.replace('FrontArmor = 5', 'FrontArmor = 6'));
    await expect(runValidate(builderPath, selection)).rejects.toThrow(
      'A script-test input changed.',
    );

    await Bun.write(unitsPath, originalUnits);
    await Bun.write(expectationPath, 'changed\n');
    await expect(runValidate(builderPath, selection)).rejects.toThrow(
      'A script-test input changed.',
    );
  });

  test('an `after` test sees the run its script just finished, and is not cached', async () => {
    const builderPath = await createTempBuilder();
    const modConfigPath = sampleModConfigPath(builderPath, 'ymb.mod.yaml');
    const validateSelection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: true,
      verbose: false,
      yes: false,
    };

    // The case this exists for: a check on a file the script keeps between runs,
    // which only exists once the script it belongs to has run.
    await Bun.write(
      sampleModConfigPath(builderPath, 'generate-mod-summary.test.ts'),
      `export default async function test(context: {
  readOwnedTextIfExists(relativePath: string): Promise<string>;
}) {
  const store = await context.readOwnedTextIfExists('identity-store.json');
  const registered = store.trim().length > 0;

  return {
    results: [
      registered
        ? { name: 'the identity store exists', status: 'passed' as const }
        : {
            name: 'the identity store exists',
            status: 'failed' as const,
            reason: 'The store is missing or empty.',
            suggestion: 'Restore it from version control.',
          },
    ],
  };
}
`,
    );
    await Bun.write(
      sampleModConfigPath(builderPath, 'generate-mod-summary.ts'),
      `export default async function generate(context: {
  variables: Record<string, unknown>;
  writeOwnedTextIfChanged(relativePath: string, content: string): Promise<boolean>;
}) {
  await context.writeOwnedTextIfChanged('identity-store.json', '{ "divisions": {} }\\n');

  return {
    targetRelativePath: String(context.variables.summaryTarget),
    content: 'GeneratedModSummary is TGeneratedSummary\\n(\\n    Label = "sample"\\n)\\n',
  };
}
`,
    );

    // Before the script runs there is no store, so the check would fail...
    await expect(runValidate(builderPath, validateSelection)).rejects.toThrow(
      'The store is missing or empty.',
    );

    const modConfig = await Bun.file(modConfigPath).text();
    await Bun.write(
      modConfigPath,
      modConfig.replace(
        '      - generate-mod-summary.test.ts',
        '      - path: generate-mod-summary.test.ts\n        when: after',
      ),
    );

    // ...and after it runs, the store the same run wrote is there to check.
    const firstRun = await runValidate(builderPath, validateSelection);
    expect(firstRun).toContain(
      formatDetailLine('test ok', 'generate-mod-summary.test.ts :: the identity store exists'),
    );

    // An `after` test checks what this run produced, so it is never answered
    // from a previous run's cache.
    const secondRun = await runValidate(builderPath, validateSelection);
    expect(secondRun).toContain(
      formatDetailLine('test ok', 'generate-mod-summary.test.ts :: the identity store exists'),
    );
    expect(secondRun.some((line) => /^test ok\* +generate-mod-summary/.test(line))).toBe(false);
    // The `before` test in the same run still comes back from cache.
    expect(secondRun.some((line) => /^test ok\* +generate-armor-summary/.test(line))).toBe(true);
  });

  test('build keeps runtime temp files out of mod script folders', async () => {
    const builderPath = await createTempBuilder();
    const selection = createSelection();

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
        sampleModConfigPath(
          builderPath,
          'patch',
          'armor',
          '.ymb-runtime-1a8c55a5f62d6eef-generate-armor-summary.ts',
        ),
      ).exists(),
    ).toBe(false);
  });

  test('safe cleanup removes YMB temp artifacts but preserves recovery state', async () => {
    const builderPath = await createTempBuilder();
    const selection = createSelection();
    const staleRuntimePath = sampleModConfigPath(
      builderPath,
      'patch',
      'armor',
      '.ymb-runtime-stale-generate-armor-summary.ts',
    );
    const modTempPath = sampleModConfigPath(builderPath, '.ymb-mod-temp.txt');
    const patchTempPath = sampleModConfigPath(builderPath, 'patch', 'armor', '.ymb-patch-temp');
    const importantModTempPath = sampleModConfigPath(builderPath, '.ymb-mod-important.json');
    const importantPatchTempPath = sampleModConfigPath(
      builderPath,
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
    const repositoryMetadataPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      '.git',
      '.ymb-user-owned',
    );
    const dependencyMetadataPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'node_modules',
      'dependency',
      '.ymb-package-owned',
    );

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
    await mkdir(path.dirname(repositoryMetadataPath), { recursive: true });
    await mkdir(path.dirname(dependencyMetadataPath), { recursive: true });
    await Bun.write(repositoryMetadataPath, 'repository metadata');
    await Bun.write(dependencyMetadataPath, 'dependency metadata');

    const cleanupLines = await runCleanup(builderPath, selection, false);
    expect(summaryValue(cleanupLines, 'mode')).toBe('safe');
    expect(summaryValue(cleanupLines, 'cleanup')).toBe('10 targets, 6 removed files, 4 kept files');
    expect(await directoryExists(path.join(builderPath, '.ymb-build'))).toBe(false);
    expect(await Bun.file(staleRuntimePath).exists()).toBe(false);
    expect(await Bun.file(modTempPath).exists()).toBe(false);
    expect(await Bun.file(patchTempPath).exists()).toBe(false);
    expect(await Bun.file(importantModTempPath).exists()).toBe(true);
    expect(await Bun.file(importantPatchTempPath).exists()).toBe(true);
    expect(await Bun.file(nestedBuilderTempPath).exists()).toBe(false);
    expect(await Bun.file(nestedBuilderModTempPath).exists()).toBe(false);
    expect(await Bun.file(repositoryMetadataPath).exists()).toBe(true);
    expect(await Bun.file(dependencyMetadataPath).exists()).toBe(true);
    expect(await directoryExists(path.join(builderPath, '.ymb-state'))).toBe(true);
    expect(await Bun.file(nestedBuilderStatePath).exists()).toBe(true);
    expect(cleanupLines).toContain(`kept       ${importantModTempPath}`);
    expect(cleanupLines).toContain(`kept       ${importantPatchTempPath}`);
    expect(cleanupLines).toContain(`kept       ${path.join(builderPath, '.ymb-state')}`);
    expect(cleanupLines).not.toContain(`kept       ${modTempPath}`);
    expect(cleanupLines).not.toContain(`kept       ${patchTempPath}`);
    expect(cleanupLines).not.toContain(`kept       ${nestedBuilderTempPath}`);
  });

  test('safe cleanup keeps a recovery root configured under another .ymb name', async () => {
    // The artifact scan finds every `.ymb*` path under the builder root. Deciding
    // what is disposable from the default directory name would find a configured
    // `recoveryRoot` here and delete the only copy of the originals.
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots, {
      builderConfig: 'version: 1\npaths:\n  recoveryRoot: .ymb-undo\n',
    });
    const recoveryRoot = path.join(builderPath, '.ymb-undo');

    await runSync(builderPath, createSelection({ yes: true }));
    expect(await directoryExists(recoveryRoot)).toBe(true);

    const cleanupLines = await runCleanup(builderPath, createSelection({ yes: true }), false);

    expect(cleanupLines).toContain(`kept       ${recoveryRoot}`);
    expect(await directoryExists(recoveryRoot)).toBe(true);
  });

  test('cleanup --all removes recovery state too', async () => {
    const builderPath = await createTempBuilder();
    const selection = createSelection({ yes: true });
    const patchConfigPath = sampleModConfigPath(builderPath, 'patch', 'armor', 'ymb.patch.yaml');
    const configuredPatchTempPath = sampleModConfigPath(
      builderPath,
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
    const importantModTempPath = sampleModConfigPath(builderPath, '.ymb-mod-important.json');
    const importantPatchTempPath = sampleModConfigPath(
      builderPath,
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
    expect(summaryValue(cleanupLines, 'mode')).toBe('all');
    expect(summaryValue(cleanupLines, 'cleanup')).not.toContain('kept file');
    expect(await directoryExists(path.join(builderPath, '.ymb-state'))).toBe(false);
    expect(await Bun.file(nestedBuilderStatePath).exists()).toBe(false);
    expect(await Bun.file(importantModTempPath).exists()).toBe(false);
    expect(await Bun.file(importantPatchTempPath).exists()).toBe(false);
    expect(await Bun.file(configuredPatchTempPath).exists()).toBe(false);
  });

  test('safe cleanup dry-run preserves all-only targets in the reported plan', async () => {
    const builderPath = await createTempBuilder();
    const selection = createSelection();
    const importantModTempPath = sampleModConfigPath(builderPath, '.ymb-mod-important.json');
    const importantPatchTempPath = sampleModConfigPath(
      builderPath,
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

    expect(summaryValue(cleanupLines, 'mode')).toBe('safe');
    expect(summaryValue(cleanupLines, 'cleanup')).toContain('kept file');
    expect(cleanupLines).toContain(formatDetailLine('kept', importantModTempPath));
    expect(cleanupLines).toContain(formatDetailLine('kept', importantPatchTempPath));
    expect(cleanupLines).toContain(formatDetailLine('kept', path.join(builderPath, '.ymb-state')));

    // `--all` really does delete the recovery data, so the dry run has to say so
    // instead of listing it as something it will keep.
    const cleanupAllLines = await runCleanup(builderPath, { ...selection, dryRun: true }, true);
    expect(summaryValue(cleanupAllLines, 'mode')).toBe('all');
    expect(cleanupAllLines).toContain(
      formatDetailLine('to remove', path.join(builderPath, '.ymb-state')),
    );
    expect(cleanupAllLines).toContain(formatDetailLine('to remove', importantModTempPath));
    expect(cleanupAllLines.some((line) => line.startsWith('kept '))).toBe(false);
  });

  test('failed configured script tests stop validate, build, and sync', async () => {
    const builderPath = await createTempBuilder();
    const modScriptTestPath = sampleModConfigPath(builderPath, 'generate-mod-summary.test.ts');
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
    const selection = createSelection();

    const firstRun = await runSync(builderPath, selection);
    expect(firstRun).toContain(
      formatDetailLine('patched', 'GameData/Generated/Gameplay/Units.ndf'),
    );

    const secondRun = await runSync(builderPath, selection);
    expect(secondRun).toContain(
      formatDetailLine('current', 'GameData/Generated/Gameplay/Units.ndf'),
    );
    expect(secondRun).toContain(
      formatDetailLine('current', `CommonData/Text/${modRootName}-replaced.ndf`),
    );
    expect(secondRun).toContain(
      formatDetailLine('current', 'GameData/Generated/Gameplay/ArmorSummary.ndf'),
    );
    expect(secondRun).toContain(
      formatDetailLine('current', 'CommonData/Text/sample_pack-generated-by-mod.ndf'),
    );
  });

  test('resync accepts an unchanged generated envelope whose content ends in CRLF', async () => {
    const builderPath = await createTempBuilder();
    const modRootName = path.basename(path.dirname(builderPath));
    const replaceSourcePath = sampleModConfigPath(
      builderPath,
      'replace',
      'CommonData',
      'Text',
      '${modRootName}-replaced.ndf',
    );
    const targetPath = path.join(
      path.dirname(builderPath),
      'CommonData',
      'Text',
      `${modRootName}-replaced.ndf`,
    );
    const selection = createSelection();

    await Bun.write(replaceSourcePath, 'First replacement line\r\nSecond replacement line\r\n');
    await runSync(builderPath, selection);

    const trackedContent = await Bun.file(targetPath).text();
    expect(trackedContent).toContain('Second replacement line\r\n// YMB-');

    const secondRun = await runSync(builderPath, selection);
    expect(secondRun).toContain(
      formatDetailLine('current', `CommonData/Text/${modRootName}-replaced.ndf`),
    );
  });

  test('build refreshes cached patch outputs when target source files change', async () => {
    const builderPath = await createTempBuilder();
    const modRoot = path.dirname(builderPath);
    const selection = createSelection();
    const sourceUnitsPath = path.join(modRoot, 'GameData', 'Generated', 'Gameplay', 'Units.ndf');
    const builtUnitsPath = buildOutputPath(
      builderPath,
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
    const selection = createSelection({ useCache: false });
    const patchCacheRoot = path.join(builderPath, '.ymb-build', 'cache', 'patches');
    const initialCacheEntries = await readdir(patchCacheRoot).catch(() => []);

    const buildLines = await runBuild(builderPath, selection);

    const cacheEntries = await readdir(patchCacheRoot).catch(() => []);
    expect(cacheEntries).toEqual(initialCacheEntries);
    expect(summaryValue(buildLines, 'reused')).toContain('cache bypassed');
  });

  test('validate and dry-run build fail early on broken replace templates', async () => {
    const builderPath = await createTempBuilder();
    const replacePath = sampleModConfigPath(
      builderPath,
      'replace',
      'CommonData',
      'Text',
      'broken-template.ndf',
    );
    const selection = createSelection({ dryRun: true });

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
    const replacePath = sampleModConfigPath(
      builderPath,
      'replace',
      'GameData',
      'Assets',
      'Binary',
      'logo.bin',
    );
    const selection = createSelection();

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

  test('sync notes csv replace files and leaves them unmarked', async () => {
    const builderPath = await createTempBuilder();
    const modRoot = path.dirname(builderPath);
    const replacePath = sampleModConfigPath(
      builderPath,
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
    const selection = createSelection();

    await mkdir(path.dirname(replacePath), { recursive: true });
    await Bun.write(replacePath, csvContent);

    const firstRun = await runSync(builderPath, selection);
    // A file type with no comment syntax can never carry markers, so this is a
    // note about the file rather than a warning about the build. It stays out of
    // the detail list until `--verbose` asks for it.
    expect(firstRun.some((line) => line.startsWith('warning marker'))).toBe(false);
    expect(summaryText(firstRun)).toContain('1 output without in-file markers');
    expect(firstRun).toContain(
      formatDetailLine('replaced', 'GameData/Localisation/test/INTERFACE_OUTGAME.csv'),
    );

    const verboseRun = await runSync(builderPath, { ...selection, verbose: true });
    expect(verboseRun).toContain(
      `note     1 marker sync target: This file type does not support YMB comment markers. Recovery will rely on backups in \`${path.join(builderPath, '.ymb-state')}\` for this file.`,
    );
    expect(verboseRun).toContain('           GameData/Localisation/test/INTERFACE_OUTGAME.csv');
    expect(await Bun.file(targetPath).text()).toBe(csvContent);
    expect(await Bun.file(targetPath).text()).not.toContain('YMB-START');

    const secondRun = await runSync(builderPath, selection);
    expect(secondRun).toContain(
      formatDetailLine('current', 'GameData/Localisation/test/INTERFACE_OUTGAME.csv'),
    );
  });

  test('build notes csv replace previews and leaves them unmarked', async () => {
    const builderPath = await createTempBuilder();
    const replacePath = sampleModConfigPath(
      builderPath,
      'replace',
      'GameData',
      'Localisation',
      'test',
      'INTERFACE_OUTGAME.csv',
    );
    const previewPath = buildOutputPath(
      builderPath,
      'GameData',
      'Localisation',
      'test',
      'INTERFACE_OUTGAME.csv',
    );
    const csvContent = '"TOKEN";"REFTEXT"\n';
    const selection = createSelection();

    await mkdir(path.dirname(replacePath), { recursive: true });
    await Bun.write(replacePath, csvContent);

    const buildLines = await runBuild(builderPath, selection);
    expect(buildLines.some((line) => line.startsWith('warning marker'))).toBe(false);
    expect(summaryText(buildLines)).toContain('1 output without in-file markers');
    expect(buildLines).toContain(
      formatDetailLine('replaced', 'GameData/Localisation/test/INTERFACE_OUTGAME.csv'),
    );

    const verboseLines = await runBuild(builderPath, { ...selection, verbose: true });
    expect(verboseLines).toContain(
      'note     1 marker preview target: This file type does not support YMB comment markers. Preview output will not show in-file ownership markers for this file.',
    );
    expect(verboseLines).toContain('           GameData/Localisation/test/INTERFACE_OUTGAME.csv');
    expect(await Bun.file(previewPath).text()).toBe(csvContent);
    expect(await Bun.file(previewPath).text()).not.toContain('YMB-START');
  });

  test('a patch that writes a value the game already has is a warning, not a failure', async () => {
    const builderPath = await createTempBuilder();
    await writeModFixture(builderPath, 'settled-pack', {
      'config/ymb.mod.yaml': `version: 1
id: settled_pack
name: Settled Pack
enabled: true
`,
      'config/patch/armor/ymb.patch.yaml': `version: 1
id: settled.armor
name: Settled Armor
enabled: true
scope: prod
targets:
  - file: GameData/Generated/Gameplay/Units.ndf
    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: Descriptor_Unit_T72.FrontArmor
        value: 3
`,
    });
    const selection = createSelection({ modFilters: ['settled_pack'] });

    const validateLines = await runValidate(builderPath, selection);
    expect(summaryText(validateLines)).toContain('1 warning');

    const buildLines = await runBuild(builderPath, selection);
    expect(buildLines).toContain(
      'warning  1 patch operation: `Descriptor_Unit_T72.FrontArmor` is already `3`, so this operation changed nothing. Delete the operation if it is finished, or set the value you actually want.',
    );
    // Line 9 is the `- op: modify` written in the fixture above. Pointing at the
    // line to open is the whole reason the operation ordinal was replaced.
    expect(buildLines).toContain(
      '           settled.armor  settled-pack/config/patch/armor/ymb.patch.yaml:9',
    );
    expect(summaryText(buildLines)).toContain('1 warning');

    // The second run reads the patch cache, and a cached result has to say the
    // same things about its output as the run that produced it.
    const cachedLines = await runBuild(builderPath, selection);
    expect(summaryText(cachedLines)).toContain('1 warning');
  });

  test('a synced patch never reports its own work back as already done', async () => {
    // Every warning about an operation having nothing left to do has to mean the
    // *game* already says it. YMB rebuilds from the untouched original bytes it
    // keeps for every tracked file, so a patch that added, removed, and set
    // values must look exactly as new on the run after it was installed.
    const builderPath = await createTempBuilder();
    await writeModFixture(builderPath, 'settling-pack', {
      'config/ymb.mod.yaml': `version: 1
id: settling_pack
name: Settling Pack
enabled: true
`,
      'config/patch/armor/ymb.patch.yaml': `version: 1
id: settling.armor
name: Settling Armor
enabled: true
scope: prod
targets:
  - file: GameData/Generated/Gameplay/Units.ndf
    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: Descriptor_Unit_T72.FrontArmor
        value: 8
      - op: remove
        selector:
          kind: field
          by: path
          value: Descriptor_Unit_T72.Availability
      - op: add
        value:
          $raw: |
            export Descriptor_Unit_Settled is TEntityDescriptor
            (
                FrontArmor = 4
            )
`,
    });
    const selection = createSelection({ modFilters: ['settling_pack'], yes: true });

    const firstSync = await runSync(builderPath, selection);
    expect(firstSync.some((line) => line.startsWith('warning patch'))).toBe(false);

    const secondSync = await runSync(builderPath, selection);
    expect(secondSync.some((line) => line.startsWith('warning patch'))).toBe(false);
    expect(secondSync).toContain(
      formatDetailLine('current', 'GameData/Generated/Gameplay/Units.ndf'),
    );

    const rebuild = await runBuild(builderPath, { ...selection, useCache: false });
    expect(rebuild.some((line) => line.startsWith('warning patch'))).toBe(false);
  });

  test('resync keeps the original backup instead of backing up the previous generated output', async () => {
    const builderPath = await createTempBuilder();
    const patchConfigPath = sampleModConfigPath(builderPath, 'patch', 'armor', 'ymb.patch.yaml');
    const selection = createSelection();

    await runSync(builderPath, selection);

    const patchConfig = await Bun.file(patchConfigPath).text();
    await Bun.write(patchConfigPath, patchConfig.replace('armorBonus: 7', 'armorBonus: 11'));

    const secondRun = await runSync(builderPath, selection);
    expect(secondRun).toContain(
      formatDetailLine('patched', 'GameData/Generated/Gameplay/Units.ndf'),
    );

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
    const configFilePath = sampleModConfigPath(builderPath, 'ymb.mod.yaml');
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
    const selection = createSelection();

    await runSync(builderPath, selection);
    expect(await Bun.file(oldTargetPath).exists()).toBe(true);

    const modConfig = await Bun.file(configFilePath).text();
    await Bun.write(
      configFilePath,
      modConfig.replace(
        'summaryTarget: CommonData/Text/${modId}-generated-by-mod.ndf',
        'summaryTarget: CommonData/Text/${modId}-generated-by-mod-v2.ndf',
      ),
    );

    const secondRun = await runSync(builderPath, selection);
    expect(secondRun).toEqual(
      expect.arrayContaining(
        formatFindingGroups(toObsoleteTargetFindings([], [oldTargetRelativePath])),
      ),
    );
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
    const scriptPath = sampleModConfigPath(builderPath, 'generate-mod-summary.ts');
    const outputPath = buildOutputPath(
      builderPath,
      'CommonData',
      'Text',
      'sample_pack-generated-by-mod.ndf',
    );
    const selection = createSelection();

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
    const patchScriptPath = sampleModConfigPath(
      builderPath,
      'patch',
      'armor',
      'generate-armor-summary.ts',
    );
    const selection = createSelection();

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
      buildOutputPath(builderPath, 'GameData', 'Generated', 'Gameplay', 'ArmorSummary.ndf'),
    ).text();

    expect(builtArmorSummary).toContain('HasModSummary = True');
  });

  test('build materializes replace files after patch scripts update their source files', async () => {
    const builderPath = await createTempBuilder();
    const modRootName = path.basename(path.dirname(builderPath));
    const patchScriptPath = sampleModConfigPath(
      builderPath,
      'patch',
      'armor',
      'generate-armor-summary.ts',
    );
    const selection = createSelection();

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
      buildOutputPath(builderPath, 'CommonData', 'Text', `${modRootName}-replaced.ndf`),
    ).text();

    expect(builtReplace).toContain('Updated replace content from patch script');
  });

  test('build exposes owned text helpers to patch scripts', async () => {
    const builderPath = await createTempBuilder();
    const patchScriptPath = sampleModConfigPath(
      builderPath,
      'patch',
      'armor',
      'generate-armor-summary.ts',
    );
    const patchNotesPath = sampleModConfigPath(
      builderPath,
      'patch',
      'armor',
      'notes',
      'generated.txt',
    );
    const selection = createSelection();

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
      buildOutputPath(builderPath, 'GameData', 'Generated', 'Gameplay', 'ArmorSummary.ndf'),
    ).text();

    expect(builtArmorSummary).toContain('MissingWasEmpty = True');
    expect(builtArmorSummary).toContain('FirstWrite = True');
    expect(builtArmorSummary).toContain('SecondWrite = False');
    expect(builtArmorSummary).toContain("Stored = 'owned helper text'");
    expect(await Bun.file(patchNotesPath).text()).toBe('owned helper text\n');
  });

  test('build exposes bulk target reads to patch scripts', async () => {
    const builderPath = await createTempBuilder();
    const patchScriptPath = sampleModConfigPath(
      builderPath,
      'patch',
      'armor',
      'generate-armor-summary.ts',
    );
    const selection = createSelection();

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
      buildOutputPath(builderPath, 'GameData', 'Generated', 'Gameplay', 'ArmorSummary.ndf'),
    ).text();

    expect(builtArmorSummary).toContain('HasUnits = True');
    expect(builtArmorSummary).toContain('HasSecondTarget = True');
  });

  test('build applies multiple same-mod patches on one file in sequence', async () => {
    const builderPath = await createTempBuilder();
    const extraPatchRoot = sampleModConfigPath(builderPath, 'patch', 'availability');
    const selection = createSelection();

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
      buildOutputPath(builderPath, 'GameData', 'Generated', 'Gameplay', 'Units.ndf'),
    ).text();

    expect(builtUnits).toContain('FrontArmor = 7');
    expect(builtUnits).toContain('Availability = 6');
    expect(builtUnits).toContain('Descriptor_Unit_sample_pack_T80UM');
  });

  test('build evaluates template expressions inside patch values', async () => {
    const builderPath = await createTempBuilder();
    const expressionPatchRoot = sampleModConfigPath(builderPath, 'patch', 'expression');
    const selection = createSelection();

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
      buildOutputPath(builderPath, 'GameData', 'Generated', 'Gameplay', 'Units.ndf'),
    ).text();

    expect(builtUnits).toContain('FrontArmor = 11');
  });

  test('build supports nested variables, indexing, and conditional expressions', async () => {
    const builderPath = await createTempBuilder();
    const expressionPatchRoot = sampleModConfigPath(builderPath, 'patch', 'expression-advanced');
    const selection = createSelection();

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
      buildOutputPath(builderPath, 'GameData', 'Generated', 'Gameplay', 'Units.ndf'),
    ).text();

    expect(builtUnits).toContain('FrontArmor = 11');
    expect(builtUnits).toContain('Availability = 6');
  });

  test('build resolves a numeric template used by a bulk multiplier', async () => {
    const builderPath = await createTempBuilder();
    const expressionPatchRoot = sampleModConfigPath(builderPath, 'patch', 'bulk-expression');
    const selection = createSelection();

    await mkdir(expressionPatchRoot, { recursive: true });
    await Bun.write(
      path.join(expressionPatchRoot, 'ymb.patch.yaml'),
      `version: 1
id: balance.bulk_expression
name: Bulk Expression Tweaks
scope: prod
variables:
  availabilityMultiplier: 3
targets:
  - file: GameData/Generated/Gameplay/Units.ndf
    operations:
      - op: bulk
        match:
          conditions:
            - on: name
              is: startsWith
              value: Descriptor_Unit_
        edits:
          - field: Availability
            multiply: \${availabilityMultiplier}
            minChanges: 2
`,
    );

    await runBuild(builderPath, selection);
    const builtUnits = await Bun.file(
      buildOutputPath(builderPath, 'GameData', 'Generated', 'Gameplay', 'Units.ndf'),
    ).text();

    expect(builtUnits).toContain('Availability = 6');
    expect(builtUnits).toContain('Availability = 3');
  });

  test('build lets the chosen mod win when different mods patch the same file', async () => {
    const builderPath = await createTempBuilder();
    const selection = createSelection({ modFilters: ['alpha_pack', 'bravo_pack'] });

    await writeFieldPatchMods(builderPath, [
      ['alpha_pack', 'Descriptor_Unit_T80U.FrontArmor', 8],
      ['bravo_pack', 'Descriptor_Unit_T80U.FrontArmor', 12],
    ]);

    setPatchPriorityResolverForTests(async () => 'bravo_pack');

    await runBuild(builderPath, selection);
    const builtUnits = await Bun.file(
      buildOutputPath(builderPath, 'GameData', 'Generated', 'Gameplay', 'Units.ndf'),
    ).text();

    expect(builtUnits).toContain('FrontArmor = 12');
  });

  test('build auto-merges non-overlapping patch previews across mods without prompting', async () => {
    const builderPath = await createTempBuilder();
    const selection = createSelection({ modFilters: ['alpha_pack', 'bravo_pack'] });

    await writeFieldPatchMods(builderPath, [
      ['alpha_pack', 'Descriptor_Unit_T80U.FrontArmor', '8'],
      ['bravo_pack', 'Descriptor_Unit_T80U.Availability', '9'],
    ]);

    setPatchPriorityResolverForTests(async () => {
      throw new Error('patch priority prompt should not be used for disjoint edits');
    });

    await runBuild(builderPath, selection);
    const builtUnits = await Bun.file(
      buildOutputPath(builderPath, 'GameData', 'Generated', 'Gameplay', 'Units.ndf'),
    ).text();

    expect(builtUnits).toContain('FrontArmor = 8');
    expect(builtUnits).toContain('Availability = 9');

    const outputPath = buildOutputPath(
      builderPath,
      'GameData',
      'Generated',
      'Gameplay',
      'Units.ndf',
    );
    const secondBuild = await runBuild(builderPath, selection);
    const rebuiltUnits = await Bun.file(outputPath).text();

    expect(rebuiltUnits).toBe(builtUnits);
    expect(summaryText(secondBuild)).toContain('1 of 1 merged result from cache');
  });

  test('build still rejects replace files that collide with patched outputs', async () => {
    const builderPath = await createTempBuilder();
    const replacePath = sampleModConfigPath(
      builderPath,
      'replace',
      'GameData',
      'Generated',
      'Gameplay',
      'Units.ndf',
    );
    const selection = createSelection();

    await mkdir(path.dirname(replacePath), { recursive: true });
    await Bun.write(replacePath, 'replaced');

    await expect(runBuild(builderPath, selection)).rejects.toThrow(
      'Replace output collides with a generated patch target',
    );
  });

  test('build merges same-target scripts when their text edits are disjoint', async () => {
    const builderPath = await createTempBuilder();
    const selection = createSelection({ modFilters: ['script_pack'] });

    await writeTwoScriptFixture(
      builderPath,
      `export default async function generate(context) {
  const source = await context.readTarget('CommonData/Text/shared-script.ndf');
  return {
    targetRelativePath: 'CommonData/Text/shared-script.ndf',
    content: source.replace('alpha', 'ALPHA'),
  };
}
`,
      `export default async function generate(context) {
  const source = await context.readTarget('CommonData/Text/shared-script.ndf');
  return {
    targetRelativePath: 'CommonData/Text/shared-script.ndf',
    content: source.replace('gamma', 'GAMMA'),
  };
}
`,
      'alpha\nbeta\ngamma\n',
    );

    await runBuild(builderPath, selection);
    const builtFile = await Bun.file(
      buildOutputPath(builderPath, 'CommonData', 'Text', 'shared-script.ndf'),
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
    const selection = createSelection({ modFilters: ['script_pack'] });

    await writeTwoScriptFixture(
      builderPath,
      `export default async function generate(context) {
  const source = await context.readTarget('CommonData/Text/shared-script.ndf');
  return {
    targetRelativePath: 'CommonData/Text/shared-script.ndf',
    content: source.replace('beta', 'LEFT'),
  };
}
`,
      `export default async function generate(context) {
  return {
    targetRelativePath: 'CommonData/Text/shared-script.ndf',
    content: 'alpha\\nRIGHT\\ngamma\\n',
  };
}
`,
      'alpha\nbeta\ngamma\n',
    );

    await expect(runBuild(builderPath, selection)).rejects.toThrow(
      'Script output overlaps with another generated script contribution',
    );
  });

  test('build rejects same-target binary script collisions', async () => {
    const builderPath = await createTempBuilder();
    const selection = createSelection({ modFilters: ['script_pack'] });

    await writeTwoScriptFixture(
      builderPath,
      `export default function generate() {
  return {
    targetRelativePath: 'GameData/Assets/Binary/shared.bin',
    content: new Uint8Array([1, 2, 3]),
  };
}
`,
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
    const selection = createSelection();

    await runSync(builderPath, selection);

    const filteredRecoverLines = await runRecover(builderPath, {
      ...selection,
      modFilters: ['sample_pack'],
      patchFilters: ['missing.patch'],
    });
    // The mod matches and the patch does not, so nothing is recovered - and the
    // run says which half of the filter nothing answered to, rather than looking
    // like a recover that had nothing to do.
    expect(filteredRecoverLines.filter((line) => /^(restored|deleted)/.test(line))).toEqual([]);
    expect(filteredRecoverLines.join('\n')).toContain('No patch answers to `missing.patch`');

    const syncedFile = await Bun.file(
      path.join(path.dirname(builderPath), 'GameData', 'Generated', 'Gameplay', 'Units.ndf'),
    ).text();
    expect(syncedFile).toContain('// YMB-START');
  });

  test('recover accepts exact mod names as well as mod ids', async () => {
    const builderPath = await createTempBuilder();
    const selection = createSelection();

    await runSync(builderPath, selection);

    const recoverLines = await runRecover(builderPath, {
      ...selection,
      modFilters: ['Sample Pack'],
    });
    expect(recoverLines).toContain(
      formatDetailLine('restored', 'GameData/Generated/Gameplay/Units.ndf'),
    );

    const recoveredFile = await Bun.file(
      path.join(path.dirname(builderPath), 'GameData', 'Generated', 'Gameplay', 'Units.ndf'),
    ).text();
    expect(recoveredFile).not.toContain('YMB-START');
    expect(recoveredFile).toContain('FrontArmor = 5');
  });

  test('recover matches mod names case-insensitively like selection filters', async () => {
    const builderPath = await createTempBuilder();
    const selection = createSelection();

    await runSync(builderPath, selection);

    const recoverLines = await runRecover(builderPath, {
      ...selection,
      modFilters: ['sample pack'],
    });
    expect(recoverLines).toContain(
      formatDetailLine('restored', 'GameData/Generated/Gameplay/Units.ndf'),
    );
  });

  test('dry-run recover reports the planned restore and delete counts', async () => {
    const builderPath = await createTempBuilder();
    const selection = createSelection();

    await runSync(builderPath, selection);

    const recoverLines = await runRecover(builderPath, {
      ...selection,
      dryRun: true,
    });

    expect(summaryValue(recoverLines, 'recover')).toBe(
      '1 restored file, 3 deleted generated files, 4 still-tracked files',
    );
    expect(recoverLines).toContain(
      formatDetailLine('restored', 'GameData/Generated/Gameplay/Units.ndf'),
    );
    expect(recoverLines).toContain(
      formatDetailLine('deleted', 'GameData/Generated/Gameplay/ArmorSummary.ndf'),
    );
  });

  test('recover deletes consumed backup files after restoring the originals', async () => {
    const builderPath = await createTempBuilder();
    const selection = createSelection();
    const originalsRoot = path.join(builderPath, '.ymb-state', 'originals');

    await runSync(builderPath, selection);
    expect((await readdir(originalsRoot)).length).toBeGreaterThan(0);

    await runRecover(builderPath, selection);
    expect(await readdir(originalsRoot)).toHaveLength(0);
  });

  test('recover sweeps orphaned backups that no manifest entry references', async () => {
    const builderPath = await createTempBuilder();
    const selection = createSelection();
    const originalsRoot = path.join(builderPath, '.ymb-state', 'originals');

    await runSync(builderPath, selection);
    const orphanedBackupName = `${'d'.repeat(64)}.ndf`;
    await Bun.write(path.join(originalsRoot, orphanedBackupName), 'orphan from interrupted sync');

    const recoverLines = await runRecover(builderPath, selection);

    expect(await readdir(originalsRoot)).toHaveLength(0);
    expect(recoverLines).toContain(formatDetailLine('swept', orphanedBackupName));
  });

  test('recover preserves unrecognized files in the recovery directory', async () => {
    const builderPath = await createTempBuilder();
    const selection = createSelection();
    const originalsRoot = path.join(builderPath, '.ymb-state', 'originals');

    await runSync(builderPath, selection);
    await Bun.write(path.join(originalsRoot, 'recovery-notes.txt'), 'keep this file');

    const recoverLines = await runRecover(builderPath, selection);

    expect(await readdir(originalsRoot)).toEqual(['recovery-notes.txt']);
    // One heading for everything the sweep refused to touch, with the names
    // listed under it, rather than one labelled line per name.
    const sweepReport = recoverLines.join('\n');
    expect(sweepReport).toContain('1 recovery file:');
    expect(sweepReport).toContain('Not something YMB wrote');
    expect(sweepReport).toContain('recovery-notes.txt');
  });

  test('sync leaves no temp files next to live targets', async () => {
    const builderPath = await createTempBuilder();
    const selection = createSelection();

    await runSync(builderPath, selection);

    const gameplayRoot = path.join(builderPath, '..', 'GameData', 'Generated', 'Gameplay');
    const leftovers = (await readdir(gameplayRoot)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    expect(
      (await readdir(path.join(builderPath, '.ymb-state'))).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  test('resync fails fast when a tracked original backup is missing', async () => {
    const builderPath = await createTempBuilder();
    const scriptPath = sampleModConfigPath(builderPath, 'generate-mod-summary.ts');
    const manifestPath = path.join(builderPath, '.ymb-state', 'manifest.json');
    const selection = createSelection();

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
    const selection = createSelection();

    await runSync(builderPath, selection);
    const trackedContent = await Bun.file(targetPath).text();
    await Bun.write(targetPath, trackedContent.replace('// YMB-END', '// YMB-FINISH'));

    // Sync now catches this in its pre-flight, before it builds anything.
    await expect(runSync(builderPath, selection)).rejects.toThrow('changed outside YMB');
    // `build` has no pre-flight, so it is where the marker reader still speaks up.
    await expect(runBuild(builderPath, selection)).rejects.toThrow(
      'The live tracked file contains malformed YMB markers',
    );
  });

  test('resync fails closed when marked content was edited without updating its envelope', async () => {
    const builderPath = await createTempBuilder();
    const targetPath = path.join(
      path.dirname(builderPath),
      'CommonData',
      'Text',
      'sample_pack-generated-by-mod.ndf',
    );
    const selection = createSelection();

    await runSync(builderPath, selection);
    const trackedContent = await Bun.file(targetPath).text();
    const editedContent = trackedContent.replace(
      'GeneratedModSummary is TGeneratedSummary',
      'EditedModSummary is TGeneratedSummary',
    );
    expect(editedContent).not.toBe(trackedContent);
    await Bun.write(targetPath, editedContent);

    await expect(runSync(builderPath, selection)).rejects.toThrow('changed outside YMB');
    // The envelope check is what catches an edit that kept the markers intact.
    await expect(runBuild(builderPath, selection)).rejects.toThrow(
      'The live tracked file was changed after YMB wrote it',
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
    const selection = createSelection();

    await runSync(builderPath, selection);
    const trackedContent = await Bun.file(targetPath).text();
    await Bun.write(targetPath, trackedContent.replace('// YMB-END', ']\n// YMB-END'));

    await expect(runSync(builderPath, selection)).rejects.toThrow('changed outside YMB');
    // Corrupt or merely different, an edit inside the envelope is reported as the
    // one thing the reader can act on: the live file is no longer what YMB wrote.
    await expect(runBuild(builderPath, selection)).rejects.toThrow(
      'The live tracked file was changed after YMB wrote it',
    );
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
    const selection = createSelection({ dryRun: true });

    const originalContent = await Bun.file(sourceTargetPath).text();
    await Bun.write(sourceTargetPath, `${originalContent}\n]\n`);

    await expect(runValidate(builderPath, selection)).rejects.toThrow('Unbalanced delimiter `]`');
  });

  test('validate and build reject invalid script outputs with uppercase .NDF targets', async () => {
    const builderPath = await createTempBuilder();
    const selection = createSelection({ modFilters: ['uppercase_script_pack'], dryRun: true });

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
    const selection = createSelection({ modFilters: ['uppercase_replace_pack'], dryRun: true });

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
    const scriptPath = sampleModConfigPath(builderPath, 'generate-mod-summary.ts');
    const scriptSource = await Bun.file(scriptPath).text();
    const selection = createSelection();

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
    const scriptPath = sampleModConfigPath(builderPath, 'generate-mod-summary.ts');
    const selection = createSelection();

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
    const selection = createSelection();

    await writeSamplePackConfig(builderPath, true);
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
      buildOutputPath(builderPath, 'CommonData', 'Text', `${modRootName}-replaced.ndf`),
    ).text();
    expect(replacedFile).toContain('Priority replace content');
    expect(replacedFile).not.toContain('Replaced content for Sample Pack');
  });

  test('build falls back to normal patch conflict resolution when different priorities do not opt into layered writes', async () => {
    const builderPath = await createTempBuilder();
    let usedPriorityResolver = false;
    const selection = createSelection();

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

    setPatchPriorityResolverForTests(async () => {
      usedPriorityResolver = true;
      return 'priority_pack';
    });
    await runBuild(builderPath, selection);

    const builtUnits = await Bun.file(
      buildOutputPath(builderPath, 'GameData', 'Generated', 'Gameplay', 'Units.ndf'),
    ).text();
    expect(usedPriorityResolver).toBe(true);
    expect(builtUnits).toContain('FrontArmor = 11');
    expect(builtUnits).toContain('Descriptor_Unit_sample_pack_T80UM');
  });

  test('build layers a higher-priority mod over an earlier mod that never opted in itself', async () => {
    const builderPath = await createTempBuilder();
    let usedPriorityResolver = false;
    const selection = createSelection();

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

    setPatchPriorityResolverForTests(async () => {
      usedPriorityResolver = true;
      return 'priority_pack';
    });
    await runBuild(builderPath, selection);

    const builtUnits = await Bun.file(
      buildOutputPath(builderPath, 'GameData', 'Generated', 'Gameplay', 'Units.ndf'),
    ).text();
    // The earlier mod only ever rewrites untouched game files, so it does not
    // have to declare anything for the later mod to layer over its output.
    expect(usedPriorityResolver).toBe(false);
    expect(builtUnits).toContain('FrontArmor = 13');
    expect(builtUnits).toContain('Descriptor_Unit_sample_pack_T80UM');
  });

  test('build preserves earlier patch outputs when the later mod reads modified files', async () => {
    const builderPath = await createTempBuilder();
    const selection = createSelection();

    await writeSamplePackConfig(builderPath, true);
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
      buildOutputPath(builderPath, 'GameData', 'Generated', 'Gameplay', 'Units.ndf'),
    ).text();
    expect(builtUnits).toContain('FrontArmor = 11');
    expect(builtUnits).toContain('Descriptor_Unit_sample_pack_T80UM');
  });

  test('build lets a dependency-ordered mod layer over a dependency that never opted in itself', async () => {
    const builderPath = await createTempBuilder();
    const selection = createSelection();

    await writeSamplePackConfig(builderPath, false);
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
      buildOutputPath(builderPath, 'GameData', 'Generated', 'Gameplay', 'Units.ndf'),
    ).text();
    expect(builtUnits).toContain('FrontArmor = 14');
    expect(builtUnits).toContain('Descriptor_Unit_sample_pack_T80UM');
  });

  test('build recommends allowWriteToModifiedFiles when an ordered replace collision is not opted into', async () => {
    const builderPath = await createTempBuilder();
    const modRootName = path.basename(path.dirname(builderPath));
    const selection = createSelection();

    await writeModFixture(builderPath, 'priority-pack', {
      'config/ymb.mod.yaml': `version: 1
id: priority_pack
name: Priority Pack
priority: 1
enabled: true
scripts: []
`,
      [`config/replace/CommonData/Text/${modRootName}-replaced.ndf`]: 'Priority replace content\n',
    });

    await expect(runBuild(builderPath, selection)).rejects.toThrow('allowWriteToModifiedFiles');
  });

  test('build recommends allowWriteToModifiedFiles when a dependency collision is not opted into', async () => {
    const builderPath = await createTempBuilder();
    const selection = createSelection();

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
    const selection = createSelection();

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

  test('build lets a later opted-in script transform a lower-priority replacement', async () => {
    const builderPath = await createTempBuilder();
    await writeModFixture(builderPath, 'base-replace-pack', {
      'config/ymb.mod.yaml': `version: 1
id: base_replace_pack
name: Base Replace Pack
priority: 0
enabled: true
`,
      'config/replace/CommonData/Text/layered.txt': 'Base title\nPreserved line\n',
    });
    await writeModFixture(builderPath, 'branding-pack', {
      'config/ymb.mod.yaml': `version: 1
id: branding_pack
name: Branding Pack
priority: 1
allowWriteToModifiedFiles: true
enabled: true
scripts:
  - path: brand.ts
`,
      'config/brand.ts': `export default async function brand(context) {
  const targetRelativePath = 'CommonData/Text/layered.txt';
  const content = await context.readTarget(targetRelativePath);
  return { targetRelativePath, content: content.replace('Base title', 'Layered title') };
}
`,
    });

    const selection = createSelection({ modFilters: ['base_replace_pack', 'branding_pack'] });
    await runValidate(builderPath, selection);
    await runBuild(builderPath, selection);

    expect(
      await Bun.file(buildOutputPath(builderPath, 'CommonData', 'Text', 'layered.txt')).text(),
    ).toBe('Layered title\nPreserved line\n');

    // Revoking the opt-in on the mod that writes on top is what removes the
    // permission; the lower replace owner never needed one. Without it the
    // branding mod shares the lower layer and cannot see that output at all.
    const brandingConfigPath = path.join(
      builderPath,
      'mods',
      'branding-pack',
      'config',
      'ymb.mod.yaml',
    );
    const brandingConfig = await Bun.file(brandingConfigPath).text();
    await Bun.write(brandingConfigPath, brandingConfig.replace('true', 'false'));
    await expect(runBuild(builderPath, selection)).rejects.toThrow(
      'Script input `CommonData/Text/layered.txt` does not exist',
    );
  });

  test('custom builder config moves work and recovery roots and is discovered from nested paths', async () => {
    const builderPath = (
      await createAbstractBuilderWorkspace(tempRoots, {
        builderDirectoryName: 'BuilderWorkspace',
        builderConfig: `version: 1
paths:
  sourceMods: mods
  workRoot: work-area
  recoveryRoot: recovery-area
  operationLockRoot: locks
  stateTransactionRoot: transactions
`,
      })
    ).builderPath;
    const nestedBuilderPath = path.join(builderPath, 'mods');
    const selection = createSelection();

    await runBuild(nestedBuilderPath, selection);
    expect(
      await Bun.file(
        path.join(
          builderPath,
          'work-area',
          'output',
          'GameData',
          'Generated',
          'Gameplay',
          'Units.ndf',
        ),
      ).exists(),
    ).toBe(true);
    expect(await directoryExists(path.join(builderPath, '.ymb-build'))).toBe(false);

    await runSync(nestedBuilderPath, selection);
    expect(await Bun.file(path.join(builderPath, 'recovery-area', 'manifest.json')).exists()).toBe(
      true,
    );

    const cleanupLines = await runCleanup(nestedBuilderPath, selection, false);
    expect(await directoryExists(path.join(builderPath, 'work-area'))).toBe(false);
    expect(await directoryExists(path.join(builderPath, 'recovery-area'))).toBe(true);
    expect(cleanupLines).toContain(`kept       ${path.join(builderPath, 'recovery-area')}`);
  });

  test('overlapping builder config roots fail with the exact settings in the error', async () => {
    const builderPath = (
      await createAbstractBuilderWorkspace(tempRoots, {
        builderConfig: `version: 1
paths:
  workRoot: temp
  recoveryRoot: temp/recovery
`,
      })
    ).builderPath;

    try {
      await runBuild(builderPath, createSelection());
      throw new Error('Expected config validation to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(YmbError);
      const ymbError = error as YmbError;
      expect(ymbError.category).toBe('ConfigError');
      expect(ymbError.context.absolutePath).toBe(path.join(builderPath, 'ymb.config.yaml'));
      expect(ymbError.context.reason).toContain('paths.workRoot');
      expect(ymbError.context.reason).toContain('paths.recoveryRoot');
      expect(ymbError.context.reason).toContain('cannot overlap');
      expect((ymbError.context.details ?? []).join('\n')).toContain(path.join(builderPath, 'temp'));
      expect((ymbError.context.details ?? []).join('\n')).toContain(
        path.join(builderPath, 'temp', 'recovery'),
      );
    }
  });

  test('builder config supports external source, work, recovery, and game roots', async () => {
    const workspace = await createAbstractBuilderWorkspace(tempRoots, {
      builderConfig: `version: 1
paths:
  gameRoot: ../external-game
  sourceMods: ../external-source-mods
  workRoot: ../external-work
  recoveryRoot: ../external-recovery
  operationLockRoot: ../external-lock
  stateTransactionRoot: ../external-transactions
`,
    });
    const { builderPath, rootPath } = workspace;
    const externalGameRoot = path.join(rootPath, 'external-game');
    const externalSourceModsRoot = path.join(rootPath, 'external-source-mods');
    const externalWorkRoot = path.join(rootPath, 'external-work');
    const externalRecoveryRoot = path.join(rootPath, 'external-recovery');
    const selection = createSelection({ modFilters: ['external_pack'] });

    await writeWorkspaceFiles(rootPath, {
      'external-game/GameData/Generated/Gameplay/Units.ndf': `export Descriptor_Unit_T80U is TEntityDescriptor
(
    FrontArmor = 5
)
`,
      'external-game/CommonData/Text/replaced.ndf': 'Original content\n',
      'external-source-mods/external-pack/config/ymb.mod.yaml': `version: 1
id: external_pack
name: External Pack
enabled: true
scripts: []
`,
      'external-source-mods/external-pack/config/patch/armor/ymb.patch.yaml': `version: 1
id: external.armor
name: External Armor
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
        value: 10
`,
    });

    const buildLines = await runBuild(builderPath, selection);
    expect(buildLines).toContain(
      formatDetailLine('patched', 'GameData/Generated/Gameplay/Units.ndf'),
    );
    expect(
      await Bun.file(
        path.join(externalWorkRoot, 'output', 'GameData', 'Generated', 'Gameplay', 'Units.ndf'),
      ).exists(),
    ).toBe(true);

    await runSync(builderPath, selection);
    expect(await Bun.file(path.join(externalRecoveryRoot, 'manifest.json')).exists()).toBe(true);
    expect(
      await Bun.file(
        path.join(externalGameRoot, 'GameData', 'Generated', 'Gameplay', 'Units.ndf'),
      ).text(),
    ).toContain('FrontArmor = 10');
    expect(
      await Bun.file(
        path.join(externalGameRoot, 'GameData', 'Generated', 'Gameplay', 'Units.ndf'),
      ).text(),
    ).toContain('// YMB-START');

    const cleanupLines = await runCleanup(builderPath, selection, false);
    expect(await directoryExists(externalWorkRoot)).toBe(false);
    expect(await directoryExists(externalRecoveryRoot)).toBe(true);
    expect(await directoryExists(externalSourceModsRoot)).toBe(true);
    expect(cleanupLines).toContain(`kept       ${externalRecoveryRoot}`);
  });

  test('nested external lock roots are created automatically', async () => {
    const workspace = await createAbstractBuilderWorkspace(tempRoots, {
      builderConfig: `version: 1
paths:
  operationLockRoot: ../external/locks/project-a/active-lock
`,
    });

    await runBuild(workspace.builderPath, createSelection());

    expect(
      await directoryExists(path.join(workspace.rootPath, 'external', 'locks', 'project-a')),
    ).toBe(true);
    expect(
      await directoryExists(
        path.join(workspace.rootPath, 'external', 'locks', 'project-a', 'active-lock'),
      ),
    ).toBe(false);
  });

  test('missing configured game root reports the exact game path setting', async () => {
    const workspace = await createAbstractBuilderWorkspace(tempRoots, {
      builderConfig: `version: 1
paths:
  gameRoot: ../missing-game
`,
    });

    try {
      await runBuild(workspace.builderPath, createSelection());
      throw new Error('Expected game root validation to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(YmbError);
      const ymbError = error as YmbError;
      expect(ymbError.category).toBe('LayoutError');
      expect(ymbError.context.absolutePath).toBe(
        path.join(workspace.rootPath, 'missing-game', 'GameData'),
      );
      expect(ymbError.context.reason).toContain(
        'Expected `GameData` under the configured `paths.gameRoot`.',
      );
      expect(ymbError.context.suggestion).toContain('paths.gameRoot');
    }
  });

  test('a non-file builder config is rejected instead of silently using defaults', async () => {
    const workspace = await createAbstractBuilderWorkspace(tempRoots);
    const configPath = path.join(workspace.builderPath, 'ymb.config.yaml');
    await mkdir(configPath);

    try {
      await runBuild(workspace.builderPath, createSelection());
      throw new Error('Expected the non-file builder config to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(YmbError);
      const ymbError = error as YmbError;
      expect(ymbError.category).toBe('ConfigError');
      expect(ymbError.context.absolutePath).toBe(configPath);
      expect(ymbError.context.reason).toContain('is not a regular file');
    }
  });

  test('configured work roots cannot overlap live game data', async () => {
    const workspace = await createAbstractBuilderWorkspace(tempRoots, {
      builderConfig: `version: 1
paths:
  workRoot: ../GameData/preview
`,
    });

    try {
      await runBuild(workspace.builderPath, createSelection());
      throw new Error('Expected live-data overlap validation to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(YmbError);
      const ymbError = error as YmbError;
      expect(ymbError.category).toBe('ConfigError');
      expect(ymbError.context.absolutePath).toBe(
        path.join(workspace.builderPath, 'ymb.config.yaml'),
      );
      expect(ymbError.context.reason).toContain('paths.workRoot');
      expect(ymbError.context.reason).toContain('GameData');
      expect(ymbError.context.suggestion).toContain('paths.gameRoot');
      expect((ymbError.context.details ?? []).join('\n')).toContain(
        path.join(workspace.rootPath, 'GameData', 'preview'),
      );
    }
  });

  test('live-data children beginning with two dots are still recognized as overlapping', async () => {
    const workspace = await createAbstractBuilderWorkspace(tempRoots, {
      builderConfig: `version: 1
paths:
  workRoot: ../GameData/..preview
`,
    });

    await expect(runBuild(workspace.builderPath, createSelection())).rejects.toThrow(
      'paths.workRoot` cannot overlap live WARNO data in `GameData',
    );
  });

  test('configured root aliases cannot bypass live-data overlap checks', async () => {
    const workspace = await createAbstractBuilderWorkspace(tempRoots, {
      builderConfig: `version: 1
paths:
  workRoot: live-data-link
`,
    });
    const liveDataLink = path.join(workspace.builderPath, 'live-data-link');
    await symlink(
      path.join(workspace.rootPath, 'GameData'),
      liveDataLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    try {
      await runBuild(workspace.builderPath, createSelection());
      throw new Error('Expected physical live-data overlap validation to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(YmbError);
      const ymbError = error as YmbError;
      expect(ymbError.category).toBe('ConfigError');
      expect(ymbError.context.reason).toContain('paths.workRoot');
      expect(ymbError.context.reason).toContain('GameData');
    }
  });
});
