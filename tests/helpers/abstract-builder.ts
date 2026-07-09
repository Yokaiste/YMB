import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SelectionInput } from '../../src/types.ts';

export interface AbstractBuilderWorkspace {
  rootPath: string;
  builderPath: string;
  modRootPath: string;
  modRootName: string;
}

export async function createAbstractBuilderWorkspace(
  tempRoots: string[],
): Promise<AbstractBuilderWorkspace> {
  const rootPath = await mkdtemp(path.join(tmpdir(), 'ymb-test-'));
  tempRoots.push(rootPath);
  const builderPath = path.join(rootPath, 'YMB');

  await writeWorkspaceFiles(rootPath, {
    'GameData/Generated/Gameplay/Units.ndf': `export Descriptor_Unit_T80U is TEntityDescriptor
(
    FrontArmor = 5
    Availability = 2
    Stats = TArmorStats
    (
        Front = 5
        Side = 3
    )
)

export Descriptor_Unit_T72 is TEntityDescriptor
(
    FrontArmor = 3
    Availability = 1
)
`,
    'CommonData/Text/replaced.ndf': 'Original content',
    'YMB/mods/sample-pack/config/ymb.mod.yaml': `version: 1
id: sample_pack
name: Sample Pack
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
  - path: .ymb-mod-important.json
    unsafeToRemove: true
`,
    'YMB/mods/sample-pack/config/generate-mod-summary.ts': `export default async function generateModSummary(context: {
  variables: Record<string, unknown>;
  readTarget(relativePath: string): Promise<string>;
}): Promise<{ targetRelativePath: string; content: string }> {
  const replaceTarget = String(context.variables.replaceTarget ?? 'CommonData/Text/replaced.ndf');
  const summaryTarget = String(
    context.variables.summaryTarget ?? 'CommonData/Text/generated-by-mod.ndf',
  );
  const replaced = await context.readTarget(replaceTarget);

  return {
    targetRelativePath: summaryTarget,
    content: \`GeneratedModSummary is TGeneratedSummary
(
    Label = "\${String(context.variables.modName ?? '')}"
    Text = "\${replaced.trim()}"
)
\`,
  };
}
`,
    'YMB/mods/sample-pack/config/generate-mod-summary.test.ts': `import generateModSummary from './generate-mod-summary.ts';

export default async function test(context: Parameters<typeof generateModSummary>[0]) {
  const output = await generateModSummary(context);
  const failures: string[] = [];

  if (typeof output.content !== 'string' || !output.content.includes('TGeneratedSummary')) {
    failures.push('Missing generated summary descriptor.');
  }

  return {
    results:
      failures.length === 0
        ? [
            {
              name: 'mod-level summary script returns the expected output',
              status: 'passed' as const,
              details: [output.targetRelativePath],
            },
          ]
        : [
            {
              name: 'mod-level summary script returns the expected output',
              status: 'failed' as const,
              reason: 'The mod-level generation script did not produce the expected output.',
              suggestion:
                'Fix the mod-level script or its test expectations so the synthetic fixture stays valid.',
              details: failures,
            },
          ],
  };
}
`,
    'YMB/mods/sample-pack/config/patch/armor/ymb.patch.yaml': `version: 1
id: balance.armor
name: Armor Tweaks
enabled: true
scope: prod
dependsOn: []
variables:
  armorBonus: 7
  cloneName: Descriptor_Unit_\${modId}_T80UM
scripts:
  - path: generate-armor-summary.ts
    tests:
      - generate-armor-summary.test.ts
tempPaths:
  - .ymb-patch-temp
  - path: .ymb-patch-important.json
    unsafeToRemove: true
targets:
  - file: \${generatedUnitsTarget}
    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: Descriptor_Unit_T80U.FrontArmor
        value: \${armorBonus}
      - op: copy
        selector:
          kind: object
          by: name
          value: Descriptor_Unit_T80U
        destination:
          kind: sibling
          name: \${cloneName}
      - op: modify
        selector:
          kind: object
          by: name
          value: \${cloneName}
        changes:
          Availability: 4
          FrontArmor: 9
`,
    'YMB/mods/sample-pack/config/patch/armor/generate-armor-summary.ts': `export default async function generateArmorSummary(context: {
  variables: Record<string, unknown>;
  readTarget(relativePath: string): Promise<string>;
}): Promise<{ targetRelativePath: string; content: string }> {
  const units = await context.readTarget(
    String(context.variables.generatedUnitsTarget ?? 'GameData/Generated/Gameplay/Units.ndf'),
  );
  const armorBonus = String(context.variables.armorBonus ?? '');
  const containsClone = units.includes(
    String(context.variables.cloneName ?? 'Descriptor_Unit_T80UM'),
  );

  return {
    targetRelativePath: 'GameData/Generated/Gameplay/ArmorSummary.ndf',
    content: \`GeneratedArmorSummary is TGeneratedSummary
(
    ArmorBonus = \${armorBonus}
    ContainsClone = \${containsClone ? 'True' : 'False'}
)
\`,
  };
}
`,
    'YMB/mods/sample-pack/config/patch/armor/generate-armor-summary.test.ts': `import generateArmorSummary from './generate-armor-summary.ts';

export default async function test(context: Parameters<typeof generateArmorSummary>[0]) {
  const output = await generateArmorSummary(context);
  const failures: string[] = [];

  if (output.targetRelativePath !== 'GameData/Generated/Gameplay/ArmorSummary.ndf') {
    failures.push(\`Unexpected output target: \${output.targetRelativePath}\`);
  }
  if (
    typeof output.content !== 'string' ||
    !output.content.includes('GeneratedArmorSummary is TGeneratedSummary')
  ) {
    failures.push('Missing generated armor summary descriptor.');
  }

  return {
    results:
      failures.length === 0
        ? [
            {
              name: 'patch-level armor summary script returns the expected output',
              status: 'passed' as const,
              details: [output.targetRelativePath],
            },
          ]
        : [
            {
              name: 'patch-level armor summary script returns the expected output',
              status: 'failed' as const,
              reason:
                'The patch-level generation script did not produce the expected armor summary.',
              suggestion:
                'Fix the patch-level script or its test expectations so the synthetic fixture stays valid.',
              details: failures,
            },
          ],
  };
}
`,
    'YMB/mods/sample-pack/config/replace/CommonData/Text/${modRootName}-replaced.ndf':
      'Replaced content for ${modName}\n',
  });

  return {
    rootPath,
    builderPath,
    modRootPath: rootPath,
    modRootName: path.basename(rootPath),
  };
}

export async function cleanupTempRoots(tempRoots: string[]): Promise<void> {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

export function createSelection(overrides: Partial<SelectionInput> = {}): SelectionInput {
  return {
    scope: 'prod',
    modFilters: [],
    patchFilters: [],
    dryRun: false,
    verbose: false,
    yes: false,
    ...overrides,
  };
}

export function syntheticBuilderPath(builderPath: string, ...segments: string[]): string {
  return path.join(builderPath, 'tests', 'synthetic', 'YMB', ...segments);
}

export async function writeModFixture(
  builderPath: string,
  modDirectoryName: string,
  files: Record<string, string | Uint8Array>,
): Promise<void> {
  const modRoot = path.join(builderPath, 'mods', modDirectoryName);
  const prefixedFiles = Object.fromEntries(
    Object.entries(files).map(([relativePath, content]) => [
      path.join('YMB', 'mods', modDirectoryName, relativePath).replaceAll('\\', '/'),
      content,
    ]),
  );
  await writeWorkspaceFiles(path.dirname(builderPath), prefixedFiles);
  await mkdir(modRoot, { recursive: true });
}

export async function writeWorkspaceFiles(
  rootPath: string,
  files: Record<string, string | Uint8Array>,
): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(rootPath, ...relativePath.split('/'));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await Bun.write(absolutePath, content);
  }
}
