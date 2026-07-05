import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listFilesRecursive, loadPatchConfig } from '../src/config.ts';
import { preparePlan, runExplain, runList, runValidate } from '../src/engine.ts';
import { cleanupTempRoots, createAbstractBuilderWorkspace } from './helpers/abstract-builder.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  await cleanupTempRoots(tempRoots);
});

async function createTempBuilder(): Promise<string> {
  return (await createAbstractBuilderWorkspace(tempRoots)).builderPath;
}

describe('discovery and planning', () => {
  test('discovers mods and selected patches from config identity', async () => {
    const builderPath = await createTempBuilder();
    const modRootName = path.basename(path.dirname(builderPath));
    const plan = await preparePlan(builderPath, {
      scope: 'prod',
      modFilters: [],
      patchFilters: [],
      dryRun: true,
      verbose: false,
      yes: false,
    });

    expect(plan.discoveredMods).toHaveLength(1);
    expect(plan.discoveredMods[0]?.config.id).toBe('sample_pack');
    expect(plan.selectedPatches).toHaveLength(1);
    expect(plan.selectedReplaceFiles).toHaveLength(1);
    expect(plan.selectedScripts).toHaveLength(2);
    expect(plan.selectedScripts[0]?.patch).toBeUndefined();
    expect(plan.selectedScripts[1]?.patch?.config.id).toBe('balance.armor');
    expect(plan.selectedReplaceFiles[0]?.targetRelativePath).toBe(
      `CommonData/Text/${modRootName}-replaced.ndf`,
    );
    expect(plan.discoveredMods[0]?.configAbsolutePath).toMatch(/sample-pack[\\/]config$/);
  });

  test('discovers both direct and nested mod config layouts', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ymb-discovery-layout-'));
    const tempBuilderPath = path.join(tempRoot, 'YMB');

    try {
      await mkdir(path.join(tempRoot, 'GameData'), { recursive: true });
      await mkdir(path.join(tempRoot, 'CommonData'), { recursive: true });
      await mkdir(path.join(tempBuilderPath, 'mods', 'direct-pack', 'patch'), { recursive: true });
      await mkdir(path.join(tempBuilderPath, 'mods', 'nested-pack', 'config', 'patch'), {
        recursive: true,
      });

      await Bun.write(
        path.join(tempBuilderPath, 'mods', 'direct-pack', 'ymb.mod.yaml'),
        `version: 1
id: direct_pack
name: Direct Pack
enabled: true
scripts: []
`,
      );
      await Bun.write(
        path.join(tempBuilderPath, 'mods', 'nested-pack', 'config', 'ymb.mod.yaml'),
        `version: 1
id: nested_pack
name: Nested Pack
enabled: true
scripts: []
`,
      );
      await Bun.write(
        path.join(tempBuilderPath, 'mods', 'direct-pack', 'patch', 'ymb.patch.yaml'),
        `version: 1
id: direct.patch
name: Direct Patch
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
          value: Descriptor_Unit_T80U.Availability
        value: 1
`,
      );
      await Bun.write(
        path.join(tempBuilderPath, 'mods', 'nested-pack', 'config', 'patch', 'ymb.patch.yaml'),
        `version: 1
id: nested.patch
name: Nested Patch
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
          value: Descriptor_Unit_T80U.Availability
        value: 2
`,
      );

      const plan = await preparePlan(tempBuilderPath, {
        scope: 'prod',
        modFilters: [],
        patchFilters: [],
        dryRun: true,
        verbose: false,
        yes: false,
      });

      expect(plan.discoveredMods.map((mod) => mod.config.id)).toEqual([
        'direct_pack',
        'nested_pack',
      ]);
      expect(plan.discoveredMods.map((mod) => mod.patches[0]?.config.id)).toEqual([
        'direct.patch',
        'nested.patch',
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('selects mod-level scripts and replace files even when a source mod has no patches', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ymb-discovery-mod-only-'));
    const tempBuilderPath = path.join(tempRoot, 'YMB');

    try {
      await mkdir(path.join(tempRoot, 'GameData'), { recursive: true });
      await mkdir(path.join(tempRoot, 'CommonData'), { recursive: true });
      const modConfigRoot = path.join(tempBuilderPath, 'mods', 'replace-only-pack', 'config');
      await mkdir(path.join(modConfigRoot, 'replace', 'CommonData', 'Text'), { recursive: true });
      await Bun.write(
        path.join(modConfigRoot, 'ymb.mod.yaml'),
        `version: 1
id: replace_only_pack
name: Replace Only Pack
enabled: true
scripts:
  - path: generate-mod-output.ts
`,
      );
      await Bun.write(
        path.join(modConfigRoot, 'generate-mod-output.ts'),
        `export default function generate() {
  return {
    targetRelativePath: 'CommonData/Text/mod-only-generated.ndf',
    content: 'GeneratedModOnly is TGenerated\\n()\\n',
  };
}
`,
      );
      await Bun.write(
        path.join(modConfigRoot, 'replace', 'CommonData', 'Text', 'mod-only-replaced.ndf'),
        'ReplaceOnly is TReplaceOnly\n()\n',
      );

      const plan = await preparePlan(tempBuilderPath, {
        scope: 'prod',
        modFilters: ['replace_only_pack'],
        patchFilters: [],
        dryRun: true,
        verbose: false,
        yes: false,
      });

      expect(plan.selectedPatches).toHaveLength(0);
      expect(plan.selectedReplaceFiles.map((file) => file.targetRelativePath)).toEqual([
        'CommonData/Text/mod-only-replaced.ndf',
      ]);
      expect(plan.selectedScripts.map((script) => script.config.path)).toEqual([
        'generate-mod-output.ts',
      ]);
      expect(plan.targetFiles).toEqual(['CommonData/Text/mod-only-replaced.ndf']);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('lists, explains, and validates the fixture builder', async () => {
    const builderPath = await createTempBuilder();
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: true,
      verbose: false,
      yes: false,
    };

    const listLines = await runList(builderPath, selection);
    const explainLines = await runExplain(builderPath, selection);
    const validateLines = await runValidate(builderPath, selection);

    expect(listLines.join('\n')).toContain('sample_pack');
    expect(explainLines.join('\n')).toContain('balance.armor -> included');
    expect(validateLines.join('\n')).toContain('patch ok -> GameData/Generated/Gameplay/Units.ndf');
    expect(validateLines.join('\n')).toContain(
      'script output ok -> GameData/Generated/Gameplay/ArmorSummary.ndf',
    );
    expect(validateLines.join('\n')).toContain(
      'script output ok -> CommonData/Text/sample_pack-generated-by-mod.ndf',
    );
  });

  test('loads collection insertion positions from YAML patch configs', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ymb-config-'));
    const patchConfigPath = path.join(tempRoot, 'ymb.patch.yaml');

    try {
      await Bun.write(
        patchConfigPath,
        `version: 1
id: ordered.insert
name: Ordered Insert
enabled: true
scope: prod
dependsOn: []
targets:
  - file: GameData/Generated/Gameplay/Test.ndf
    operations:
      - op: add
        selector:
          kind: collection
          by: path
          value: "@0.Items"
        position:
          mode: before
          anchor: "BaseEntry"
        value:
          $raw: "InsertedEntry,"
`,
      );

      const patchConfig = await loadPatchConfig(patchConfigPath);
      expect(patchConfig.targets[0]?.operations[0]?.position).toEqual({
        mode: 'before',
        anchor: 'BaseEntry',
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('recursive listing can filter by basename while keeping sorted results', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ymb-list-files-'));

    try {
      await mkdir(path.join(tempRoot, 'a', 'nested'), { recursive: true });
      await mkdir(path.join(tempRoot, 'b'), { recursive: true });
      await Bun.write(path.join(tempRoot, 'a', 'nested', 'ymb.patch.yaml'), 'version: 1\n');
      await Bun.write(path.join(tempRoot, 'b', 'ymb.patch.yaml'), 'version: 1\n');
      await Bun.write(path.join(tempRoot, 'b', 'notes.txt'), 'ignore me\n');

      expect(
        await listFilesRecursive(tempRoot, {
          includeBaseNames: new Set(['ymb.patch.yaml']),
        }),
      ).toEqual([
        path.join(tempRoot, 'a', 'nested', 'ymb.patch.yaml'),
        path.join(tempRoot, 'b', 'ymb.patch.yaml'),
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('accepts modify operations with falsy literal values', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ymb-config-'));
    const patchConfigPath = path.join(tempRoot, 'ymb.patch.yaml');

    try {
      await Bun.write(
        patchConfigPath,
        `version: 1
id: falsy.modify
name: Falsy Modify
enabled: true
scope: prod
dependsOn: []
targets:
  - file: GameData/Generated/Gameplay/Test.ndf
    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: Descriptor.Enabled
        value: false
      - op: modify
        selector:
          kind: field
          by: path
          value: Descriptor.Count
        value: 0
      - op: modify
        selector:
          kind: field
          by: path
          value: Descriptor.Label
        value: ""
`,
      );

      const patchConfig = await loadPatchConfig(patchConfigPath);
      expect(patchConfig.targets[0]?.operations.map((operation) => operation.value)).toEqual([
        false,
        0,
        '',
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('wraps invalid patch schema issues in a structured config error', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ymb-config-'));
    const patchConfigPath = path.join(tempRoot, 'ymb.patch.yaml');

    try {
      await Bun.write(
        patchConfigPath,
        `version: 1
id: broken.patch
name: Broken Patch
enabled: true
scope: prod
dependsOn: []
targets: []
scripts: []
`,
      );

      const loadAttempt = loadPatchConfig(patchConfigPath);
      await expect(loadAttempt).rejects.toThrow('patch config fields are invalid.');
      await expect(loadAttempt).rejects.toThrow(
        '<root>: Patch configs must declare at least one entry in `targets` or `scripts`.',
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('ignores unrelated folders outside config patch and replace', async () => {
    const tempBuilderPath = await createTempBuilder();
    const ignoredPatchPath = path.join(
      tempBuilderPath,
      'mods',
      'sample-pack',
      'notes',
      'not-a-real-patch',
      'ymb.patch.yaml',
    );
    await mkdir(path.dirname(ignoredPatchPath), { recursive: true });
    await Bun.write(
      ignoredPatchPath,
      `version: 1
id: ignored.patch
name: Ignored Patch
enabled: true
scope: prod
dependsOn: []
targets:
  - file: GameData/Generated/Gameplay/Units.ndf
    operations:
      - op: remove
        selector:
          kind: object
          by: name
          value: Descriptor_Unit_T80U
`,
    );

    const plan = await preparePlan(tempBuilderPath, {
      scope: 'prod',
      modFilters: [],
      patchFilters: [],
      dryRun: true,
      verbose: false,
      yes: false,
    });

    expect(plan.selectedPatches).toHaveLength(1);
    expect(plan.selectedPatches[0]?.patch.config.id).toBe('balance.armor');
  });

  test('rejects script paths that escape the owning config root', async () => {
    const tempBuilderPath = await createTempBuilder();
    const modConfigPath = path.join(
      tempBuilderPath,
      'mods',
      'sample-pack',
      'config',
      'ymb.mod.yaml',
    );
    const modConfig = await Bun.file(modConfigPath).text();
    await Bun.write(modConfigPath, modConfig.replace('generate-mod-summary.ts', '../escape.ts'));

    await expect(
      preparePlan(tempBuilderPath, {
        scope: 'prod',
        modFilters: [],
        patchFilters: [],
        dryRun: true,
        verbose: false,
        yes: false,
      }),
    ).rejects.toThrow('Path must stay inside its source mod config root');
  });

  test('auto-selects dependencies and orders them before dependent patches', async () => {
    const tempBuilderPath = await createTempBuilder();
    const dependentPatchRoot = path.join(
      tempBuilderPath,
      'mods',
      'sample-pack',
      'config',
      'patch',
      'followup',
    );
    await mkdir(dependentPatchRoot, { recursive: true });
    await Bun.write(
      path.join(dependentPatchRoot, 'ymb.patch.yaml'),
      `version: 1
id: balance.followup
name: Follow Up
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

    const plan = await preparePlan(tempBuilderPath, {
      scope: 'prod',
      modFilters: [],
      patchFilters: ['balance.followup'],
      dryRun: true,
      verbose: false,
      yes: false,
    });

    expect(
      plan.selectedPatches.map(
        (item: (typeof plan.selectedPatches)[number]) => item.patch.config.id,
      ),
    ).toEqual(['balance.armor', 'balance.followup']);
  });

  test('rejects ambiguous dependency ids across source mods', async () => {
    const tempBuilderPath = await createTempBuilder();
    const secondModConfigRoot = path.join(tempBuilderPath, 'mods', 'second-pack', 'config');
    const secondPatchRoot = path.join(secondModConfigRoot, 'patch');
    await mkdir(secondPatchRoot, { recursive: true });
    await Bun.write(
      path.join(secondModConfigRoot, 'ymb.mod.yaml'),
      `version: 1
id: second_pack
name: "Second Pack"
enabled: true
scripts: []
`,
    );
    await Bun.write(
      path.join(secondPatchRoot, 'ymb.patch.yaml'),
      `version: 1
id: balance.armor
name: Duplicate Armor Patch
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
        value: 99
`,
    );

    const dependentPatchRoot = path.join(
      tempBuilderPath,
      'mods',
      'sample-pack',
      'config',
      'patch',
      'followup',
    );
    await mkdir(dependentPatchRoot, { recursive: true });
    await Bun.write(
      path.join(dependentPatchRoot, 'ymb.patch.yaml'),
      `version: 1
id: balance.followup
name: Follow Up
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

    await expect(
      preparePlan(tempBuilderPath, {
        scope: 'prod',
        modFilters: [],
        patchFilters: ['balance.followup'],
        dryRun: true,
        verbose: false,
        yes: false,
      }),
    ).rejects.toThrow('Dependency `balance.armor` matches multiple patches across source mods');
  });

  test('rejects replace file collisions across selected source mods', async () => {
    const tempBuilderPath = await createTempBuilder();
    const collisionFileName = `${path.basename(path.dirname(tempBuilderPath))}-replaced.ndf`;
    const modConfigRoot = path.join(tempBuilderPath, 'mods', 'second-pack', 'config');
    const patchRoot = path.join(modConfigRoot, 'patch', 'shared');
    const replaceRoot = path.join(modConfigRoot, 'replace', 'CommonData', 'Text');
    await mkdir(patchRoot, { recursive: true });
    await mkdir(replaceRoot, { recursive: true });
    await Bun.write(
      path.join(modConfigRoot, 'ymb.mod.yaml'),
      `version: 1
id: second_pack
name: "Second Pack"
enabled: true
scripts: []
`,
    );
    await Bun.write(
      path.join(patchRoot, 'ymb.patch.yaml'),
      `version: 1
id: second.shared
name: Shared Output
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
          value: Descriptor_Unit_T80U.Availability
        value: 9
`,
    );
    await Bun.write(path.join(replaceRoot, collisionFileName), 'conflicting replace file\n');

    await expect(
      preparePlan(tempBuilderPath, {
        scope: 'prod',
        modFilters: [],
        patchFilters: [],
        dryRun: true,
        verbose: false,
        yes: false,
      }),
    ).rejects.toThrow('Two source mods replace the same output path');
  });

  test('auto-selects mod dependencies and keeps them ordered before the dependent mod', async () => {
    const tempBuilderPath = await createTempBuilder();
    const supportConfigRoot = path.join(tempBuilderPath, 'mods', 'support-pack', 'config');
    const supportPatchRoot = path.join(supportConfigRoot, 'patch', 'support');
    await mkdir(supportPatchRoot, { recursive: true });
    await Bun.write(
      path.join(tempBuilderPath, 'mods', 'sample-pack', 'config', 'ymb.mod.yaml'),
      `version: 1
id: sample_pack
name: Sample Pack
dependsOn:
  - support_pack
priority: 1
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
    await Bun.write(
      path.join(supportConfigRoot, 'ymb.mod.yaml'),
      `version: 1
id: support_pack
name: Support Pack
priority: 0
allowWriteToModifiedFiles: false
enabled: true
scripts: []
`,
    );
    await Bun.write(
      path.join(supportPatchRoot, 'ymb.patch.yaml'),
      `version: 1
id: support.base
name: Support Base
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
          value: Descriptor_Unit_T80U.Availability
        value: 6
`,
    );

    const plan = await preparePlan(tempBuilderPath, {
      scope: 'prod',
      modFilters: ['sample_pack'],
      patchFilters: [],
      dryRun: true,
      verbose: false,
      yes: false,
    });

    expect(plan.selectedMods.map((mod) => mod.config.id)).toEqual(['support_pack', 'sample_pack']);
    expect(
      plan.selectedPatches.map((patch) => `${patch.mod.config.id}:${patch.patch.config.id}`),
    ).toEqual(['support_pack:support.base', 'sample_pack:balance.armor']);
  });

  test('rejects mod dependencies that point to a higher-priority dependency', async () => {
    const tempBuilderPath = await createTempBuilder();
    const supportConfigRoot = path.join(tempBuilderPath, 'mods', 'support-pack', 'config');
    await mkdir(supportConfigRoot, { recursive: true });
    await Bun.write(
      path.join(tempBuilderPath, 'mods', 'sample-pack', 'config', 'ymb.mod.yaml'),
      `version: 1
id: sample_pack
name: Sample Pack
dependsOn:
  - support_pack
priority: 0
enabled: true
scripts: []
`,
    );
    await Bun.write(
      path.join(supportConfigRoot, 'ymb.mod.yaml'),
      `version: 1
id: support_pack
name: Support Pack
priority: 1
enabled: true
scripts: []
`,
    );

    await expect(
      preparePlan(tempBuilderPath, {
        scope: 'prod',
        modFilters: ['sample_pack'],
        patchFilters: [],
        dryRun: true,
        verbose: false,
        yes: false,
      }),
    ).rejects.toThrow('cannot have lower priority than mod dependency');
  });

  test('rejects missing mod dependencies', async () => {
    const tempBuilderPath = await createTempBuilder();
    await Bun.write(
      path.join(tempBuilderPath, 'mods', 'sample-pack', 'config', 'ymb.mod.yaml'),
      `version: 1
id: sample_pack
name: Sample Pack
dependsOn:
  - missing_pack
priority: 0
enabled: true
scripts: []
`,
    );

    await expect(
      preparePlan(tempBuilderPath, {
        scope: 'prod',
        modFilters: ['sample_pack'],
        patchFilters: [],
        dryRun: true,
        verbose: false,
        yes: false,
      }),
    ).rejects.toThrow('Missing mod dependency `missing_pack`');
  });

  test('resolves qualified cross-mod patch dependencies without ambiguity', async () => {
    const tempBuilderPath = await createTempBuilder();
    const supportConfigRoot = path.join(tempBuilderPath, 'mods', 'support-pack', 'config');
    const supportPatchRoot = path.join(supportConfigRoot, 'patch', 'shared');
    const otherConfigRoot = path.join(tempBuilderPath, 'mods', 'other-pack', 'config');
    const otherPatchRoot = path.join(otherConfigRoot, 'patch', 'shared');
    const dependentPatchRoot = path.join(
      tempBuilderPath,
      'mods',
      'sample-pack',
      'config',
      'patch',
      'followup',
    );
    await mkdir(supportPatchRoot, { recursive: true });
    await mkdir(otherPatchRoot, { recursive: true });
    await mkdir(dependentPatchRoot, { recursive: true });
    await Bun.write(
      path.join(supportConfigRoot, 'ymb.mod.yaml'),
      `version: 1
id: support_pack
name: Support Pack
priority: 0
enabled: true
scripts: []
`,
    );
    await Bun.write(
      path.join(otherConfigRoot, 'ymb.mod.yaml'),
      `version: 1
id: other_pack
name: Other Pack
priority: 0
enabled: true
scripts: []
`,
    );
    await Bun.write(
      path.join(supportPatchRoot, 'ymb.patch.yaml'),
      `version: 1
id: shared.base
name: Shared Base
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
          value: Descriptor_Unit_T80U.Availability
        value: 6
`,
    );
    await Bun.write(
      path.join(otherPatchRoot, 'ymb.patch.yaml'),
      `version: 1
id: shared.base
name: Other Shared Base
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
          value: Descriptor_Unit_T80U.Availability
        value: 8
`,
    );
    await Bun.write(
      path.join(dependentPatchRoot, 'ymb.patch.yaml'),
      `version: 1
id: balance.followup
name: Balance Followup
enabled: true
scope: prod
dependsOn:
  - support_pack:shared.base
targets:
  - file: GameData/Generated/Gameplay/Units.ndf
    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: Descriptor_Unit_T80U.FrontArmor
        value: 9
`,
    );

    const plan = await preparePlan(tempBuilderPath, {
      scope: 'prod',
      modFilters: [],
      patchFilters: ['balance.followup'],
      dryRun: true,
      verbose: false,
      yes: false,
    });

    expect(
      plan.selectedPatches.map((patch) => `${patch.mod.config.id}:${patch.patch.config.id}`),
    ).toEqual(['support_pack:shared.base', 'sample_pack:balance.followup']);
  });
});
