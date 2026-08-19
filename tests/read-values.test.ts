import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { preparePlan, runSync } from '../src/engine/commands.ts';
import { createTemplateVariables } from '../src/templates.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const CONSTANTS_FILE = 'CommonData/Gameplay/Constantes/SampleUnits.ndf';
const CONSTANTS_CONTENT = `unnamed TSampleDistanceUnits
(
    ConversionFactor = 2.5
    Label = 'metric'
)

export SampleLimits is TSampleLimits
(
    Nested = TNestedLimits
    (
        Ceiling = 40
    )
)
`;

/**
 * The smallest workspace that can show a value being read: one game file to
 * read from, and one patch that turns the value into a variable and into an
 * edit.
 */
async function createWorkspace(patchBody: string): Promise<string> {
  const rootPath = await mkdtemp(path.join(tmpdir(), 'ymb-read-values-'));
  tempRoots.push(rootPath);
  const builderPath = path.join(rootPath, 'YMB');
  const files: Record<string, string> = {
    [CONSTANTS_FILE]: CONSTANTS_CONTENT,
    'GameData/Generated/Sample.ndf': `export Descriptor_Unit_A is TEntityDescriptor
(
    RadiusGRU = 1
)
`,
    'YMB/mods/sample-pack/config/ymb.mod.yaml': `version: 1
id: sample_pack
name: Sample Pack
enabled: true
`,
    'YMB/mods/sample-pack/config/patch/sample/ymb.patch.yaml': patchBody,
  };

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(rootPath, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
  }
  return builderPath;
}

function patchConfig(readValues: string, extraVariables = ''): string {
  return `version: 1
id: sample.read
name: Sample Read
enabled: true
scope: prod
dependsOn: []
${readValues}variables:
  derivedRadius: \${conversionFactor * 4}${extraVariables}
targets:
  - file: GameData/Generated/Sample.ndf
    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: Descriptor_Unit_A.RadiusGRU
        value: \${derivedRadius}
`;
}

const READS_FACTOR = `readValues:
  conversionFactor:
    file: ${CONSTANTS_FILE}
    path: '@type:TSampleDistanceUnits.ConversionFactor'
`;

async function planVariables(builderPath: string): Promise<Record<string, unknown>> {
  const plan = await preparePlan(builderPath, {
    scope: 'prod',
    modFilters: [],
    patchFilters: [],
    dryRun: true,
    verbose: false,
    yes: false,
  });
  const mod = plan.discoveredMods[0];
  if (!mod) throw new Error('no mod discovered');
  return createTemplateVariables(plan.context, mod, mod.patches[0]);
}

describe('reading values out of the game', () => {
  test('a numeric field becomes a variable that arithmetic can use', async () => {
    const builderPath = await createWorkspace(patchConfig(READS_FACTOR));
    const variables = await planVariables(builderPath);

    expect(variables.conversionFactor).toBe(2.5);
    // The point of the feature: the read value is a number, not the text `2.5`,
    // so a variable can be built from it.
    expect(variables.derivedRadius).toBe(10);
  });

  test('a synced value is read from the saved original instead of feeding back into itself', async () => {
    const builderPath = await createWorkspace(
      patchConfig(`readValues:
  conversionFactor:
    file: GameData/Generated/Sample.ndf
    path: Descriptor_Unit_A.RadiusGRU
`),
    );
    const selection = {
      scope: 'prod' as const,
      modFilters: [],
      patchFilters: [],
      dryRun: false,
      verbose: false,
      yes: true,
    };

    await runSync(builderPath, selection);
    const variables = await planVariables(builderPath);

    expect(variables.conversionFactor).toBe(1);
    expect(variables.derivedRadius).toBe(4);
  });

  test('a nested field under a named block resolves', async () => {
    const builderPath = await createWorkspace(
      patchConfig(
        `readValues:
  conversionFactor:
    file: ${CONSTANTS_FILE}
    path: '@type:TSampleDistanceUnits.ConversionFactor'
  ceiling:
    file: ${CONSTANTS_FILE}
    path: 'SampleLimits.Nested.Ceiling'
`,
      ),
    );
    const variables = await planVariables(builderPath);

    expect(variables.ceiling).toBe(40);
  });

  test('a non-numeric field is handed over as written', async () => {
    const builderPath = await createWorkspace(
      patchConfig(
        `readValues:
  conversionFactor:
    file: ${CONSTANTS_FILE}
    path: '@type:TSampleDistanceUnits.ConversionFactor'
  label:
    file: ${CONSTANTS_FILE}
    path: '@type:TSampleDistanceUnits.Label'
`,
      ),
    );
    const variables = await planVariables(builderPath);

    expect(variables.label).toBe("'metric'");
  });

  test('an author variable of the same name still wins', async () => {
    const builderPath = await createWorkspace(
      patchConfig(READS_FACTOR, '\n  conversionFactor: 100'),
    );
    const variables = await planVariables(builderPath);

    expect(variables.conversionFactor).toBe(100);
  });

  test('prototype-shaped names remain ordinary read variables', async () => {
    const builderPath = await createWorkspace(
      patchConfig(
        `readValues:
  conversionFactor:
    file: ${CONSTANTS_FILE}
    path: '@type:TSampleDistanceUnits.ConversionFactor'
  constructor:
    file: ${CONSTANTS_FILE}
    path: '@type:TSampleDistanceUnits.ConversionFactor'
`,
        '\n  captured: ${constructor}',
      ),
    );
    const variables = await planVariables(builderPath);

    expect(Object.hasOwn(variables, 'constructor')).toBe(true);
    expect(Reflect.get(variables, 'constructor')).toBe(2.5);
    expect(variables.captured).toBe(2.5);
  });

  test('a variable key the schema would discard is rejected instead', async () => {
    const builderPath = await createWorkspace(
      patchConfig(`readValues:
  __proto__:
    file: ${CONSTANTS_FILE}
    path: '@type:TSampleDistanceUnits.ConversionFactor'
`),
    );

    await expect(planVariables(builderPath)).rejects.toThrow('reserved `__proto__` key');
  });

  test('a field that is not there names the entry, the block, and the file', async () => {
    const builderPath = await createWorkspace(
      patchConfig(`readValues:
  conversionFactor:
    file: ${CONSTANTS_FILE}
    path: '@type:TSampleDistanceUnits.NotAField'
`),
    );

    await expect(planVariables(builderPath)).rejects.toThrow(/readValues\.conversionFactor/);
  });

  test('a file that is not there is reported instead of read as empty', async () => {
    const builderPath = await createWorkspace(
      patchConfig(`readValues:
  conversionFactor:
    file: CommonData/Gameplay/Constantes/Missing.ndf
    path: '@type:TSampleDistanceUnits.ConversionFactor'
`),
    );

    await expect(planVariables(builderPath)).rejects.toThrow(/does not have/);
  });

  test('a path naming no field is refused', async () => {
    const builderPath = await createWorkspace(
      patchConfig(`readValues:
  conversionFactor:
    file: ${CONSTANTS_FILE}
    path: '@type:TSampleDistanceUnits'
`),
    );

    await expect(planVariables(builderPath)).rejects.toThrow(/names no field/);
  });
});
