import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { runBuild, runValidate } from '../src/engine/commands.ts';
import { preparePlan, withOptionalPatchesResolved } from '../src/engine/plan.ts';
import { YmbError } from '../src/errors.ts';
import {
  cleanupTempRoots,
  createAbstractBuilderWorkspace,
  createSelection,
  summaryText,
  writeModFixture,
} from './helpers/abstract-builder.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  await cleanupTempRoots(tempRoots);
});

const PRESENT_TARGET = 'GameData/Generated/Gameplay/Units.ndf';
const ABSENT_TARGET = 'GameData/Generated/Gameplay/Optional.ndf';
/** A block the fixture's `Units.ndf` really has, and one it does not. */
const PRESENT_BLOCK = 'Descriptor_Unit_T72';
const ABSENT_BLOCK = 'Descriptor_Unit_Gone';

function copyPatch(options: {
  id: string;
  optional: boolean;
  file?: string;
  source?: string;
}): string {
  return `version: 1
id: ${options.id}
name: ${options.id}
scope: prod
optional: ${options.optional}
targets:
  - file: ${options.file ?? PRESENT_TARGET}
    operations:
      - op: copy
        selector:
          kind: object
          by: name
          value: ${options.source ?? PRESENT_BLOCK}
        destination:
          name: Descriptor_Unit_${options.id.replaceAll('.', '_')}
`;
}

/** A second patch that always works, so a skip can be told from a dead build. */
const ALWAYS_APPLIES = `version: 1
id: addon.core
name: Core
scope: prod
targets:
  - file: ${PRESENT_TARGET}
    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: Descriptor_Unit_T72.Availability
        value: 9
`;

async function createAddon(builderPath: string, patches: Record<string, string>): Promise<void> {
  await writeModFixture(builderPath, 'addon', {
    'config/ymb.mod.yaml': 'version: 1\nid: addon\nname: Addon\n',
    ...Object.fromEntries(
      Object.entries(patches).map(([name, body]) => [`config/patch/${name}/ymb.patch.yaml`, body]),
    ),
  });
}

async function readBuiltUnits(builderPath: string): Promise<string> {
  return Bun.file(
    path.join(builderPath, '.ymb-build', 'output', ...PRESENT_TARGET.split('/')),
  ).text();
}

describe('optional patches', () => {
  test.each([undefined, null, new Error('unexpected'), { errors: [] }])(
    'retries preserve unexpected failures: %s',
    async (failure) => {
      const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);
      await createAddon(builderPath, { core: ALWAYS_APPLIES });
      const plan = await preparePlan(builderPath, createSelection({ modFilters: ['addon'] }));
      let attempts = 0;
      const result = await withOptionalPatchesResolved(plan, async () => {
        attempts += 1;
        throw failure;
      }).then(
        () => ({ rejected: false, error: undefined }),
        (error: unknown) => ({ rejected: true, error }),
      );
      expect(result.rejected).toBe(true);
      expect(result.error).toBe(failure);
      expect(attempts).toBe(1);
    },
  );

  test('each newly discovered missing optional feature can be removed until the selection is valid', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);
    await createAddon(builderPath, {
      core: ALWAYS_APPLIES,
      ...Object.fromEntries(
        Array.from({ length: 7 }, (_, i) => [
          `optional${i}`,
          copyPatch({ id: `addon.optional${i}`, optional: true }),
        ]),
      ),
    });
    const initial = await preparePlan(builderPath, createSelection({ modFilters: ['addon'] }));
    const attempted: number[] = [];
    const { plan, result } = await withOptionalPatchesResolved(initial, async (current) => {
      attempted.push(current.selectedPatches.length);
      const missing = current.selectedPatches.find((selected) => selected.patch.config.optional);
      if (missing)
        throw new YmbError('SelectorError', {
          absolutePath: missing.patch.configFilePath,
          modId: missing.mod.config.id,
          patchId: missing.patch.config.id,
          reason: 'An input required by this feature is absent.',
          suggestion: 'Skip this optional feature.',
        });
      return 'complete';
    });
    expect(result).toBe('complete');
    expect(plan.skippedPatches).toHaveLength(7);
    expect(plan.selectedPatches.map((selected) => selected.patch.config.id)).toEqual([
      'addon.core',
    ]);
    expect(attempted).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  });
  test('a feature whose target file is not in this install is left out', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);
    await createAddon(builderPath, {
      core: ALWAYS_APPLIES,
      dlc: copyPatch({ id: 'addon.dlc', optional: true, file: ABSENT_TARGET }),
    });

    const lines = await runBuild(builderPath, createSelection({ modFilters: ['addon'] }));

    expect(summaryText(lines)).toContain('1 skipped optional patch');
    expect(lines.join('\n')).toContain('addon.dlc');
    // The rest of the build is untouched.
    expect(await readBuiltUnits(builderPath)).toContain('Availability = 9');
  });

  test('a feature whose selector finds nothing is left out, and the build still finishes', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);
    await createAddon(builderPath, {
      core: ALWAYS_APPLIES,
      vanilla: copyPatch({ id: 'addon.vanilla', optional: true, source: ABSENT_BLOCK }),
    });

    const lines = await runBuild(builderPath, createSelection({ modFilters: ['addon'] }));

    // Only trying can find this one, so the run plans again without it.
    expect(summaryText(lines)).toContain('1 skipped optional patch');
    expect(lines.join('\n')).toContain('addon.vanilla');
    const built = await readBuiltUnits(builderPath);
    expect(built).toContain('Availability = 9');
    expect(built).not.toContain('Descriptor_Unit_addon_vanilla');
  });

  test('an optional feature that can be built is built like any other', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);
    await createAddon(builderPath, {
      vanilla: copyPatch({ id: 'addon.vanilla', optional: true }),
    });

    const lines = await runBuild(builderPath, createSelection({ modFilters: ['addon'] }));

    expect(summaryText(lines)).not.toContain('skipped');
    expect(await readBuiltUnits(builderPath)).toContain('Descriptor_Unit_addon_vanilla');
  });

  test('several optional features are all resolved in one run', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);
    await createAddon(builderPath, {
      core: ALWAYS_APPLIES,
      first: copyPatch({ id: 'addon.first', optional: true, source: ABSENT_BLOCK }),
      second: copyPatch({
        id: 'addon.second',
        optional: true,
        source: 'Descriptor_Unit_Also_Gone',
      }),
      third: copyPatch({ id: 'addon.third', optional: true, file: ABSENT_TARGET }),
    });

    const lines = await runBuild(builderPath, createSelection({ modFilters: ['addon'] }));

    expect(summaryText(lines)).toContain('3 skipped optional patches');
    expect(await readBuiltUnits(builderPath)).toContain('Availability = 9');
  });

  test('a feature built on a skipped one goes with it, and says so', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);
    await createAddon(builderPath, {
      core: ALWAYS_APPLIES,
      base: copyPatch({ id: 'addon.base', optional: true, source: ABSENT_BLOCK }),
      // Depends on the one that cannot be built. Dependency resolution pulls
      // prerequisites back in, so this is also where an earlier design put the
      // skipped patch straight back into the plan.
      built_on_it: `version: 1
id: addon.extra
name: Extra
scope: prod
optional: true
dependsOn:
  - addon.base
targets:
  - file: ${PRESENT_TARGET}
    operations:
      - op: copy
        selector:
          kind: object
          by: name
          value: ${PRESENT_BLOCK}
        destination:
          name: Descriptor_Unit_addon_extra
`,
    });

    const lines = await runBuild(builderPath, createSelection({ modFilters: ['addon'] }));

    expect(summaryText(lines)).toContain('2 skipped optional patches');
    const report = lines.join('\n');
    expect(report).toContain('depends on skipped addon.base');
    expect(report).toContain('addon.extra');
    const built = await readBuiltUnits(builderPath);
    expect(built).toContain('Availability = 9');
    expect(built).not.toContain('Descriptor_Unit_addon_extra');
  });

  test('validate reports the same skips rather than failing', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);
    await createAddon(builderPath, {
      core: ALWAYS_APPLIES,
      vanilla: copyPatch({ id: 'addon.vanilla', optional: true, source: ABSENT_BLOCK }),
      dlc: copyPatch({ id: 'addon.dlc', optional: true, file: ABSENT_TARGET }),
    });

    const lines = await runValidate(builderPath, createSelection({ modFilters: ['addon'] }));

    expect(summaryText(lines)).toContain('2 skipped optional patches');
    expect(lines.join('\n')).toContain('addon.vanilla');
    expect(lines.join('\n')).toContain('addon.dlc');
  });

  test.each([
    ['a missing target file', { file: ABSENT_TARGET }],
    ['a selector that finds nothing', { source: ABSENT_BLOCK }],
  ])('a patch that is not optional still fails on %s', async (_description, overrides) => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);
    await createAddon(builderPath, {
      strict: copyPatch({ id: 'addon.strict', optional: false, ...overrides }),
    });

    const failure = await runBuild(builderPath, createSelection({ modFilters: ['addon'] })).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(YmbError);
    expect((failure as YmbError).context.patchId).toBe('addon.strict');
  });

  test.each([
    ['a missing target file', { file: ABSENT_TARGET }, 'IoError' as const],
    ['a selector that finds nothing', { source: ABSENT_BLOCK }, 'SelectorError' as const],
  ])(
    '--require-all turns the skip back into a failure for %s',
    async (_description, overrides, category) => {
      const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);
      await createAddon(builderPath, {
        dlc: copyPatch({ id: 'addon.dlc', optional: true, ...overrides }),
      });
      const selection = createSelection({ modFilters: ['addon'], requireAll: true });

      const failure = await runBuild(builderPath, selection).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(YmbError);
      expect((failure as YmbError).category).toBe(category);
      expect((failure as YmbError).context.patchId).toBe('addon.dlc');
    },
  );

  test('a folder where the target file belongs is a mistake, not a missing install', async () => {
    const { builderPath, rootPath } = await createAbstractBuilderWorkspace(tempRoots);
    await createAddon(builderPath, {
      dlc: copyPatch({ id: 'addon.dlc', optional: true, file: ABSENT_TARGET }),
    });
    // `optional` forgives "nothing is here", not "something else is here".
    await mkdir(path.join(rootPath, ...ABSENT_TARGET.split('/')), { recursive: true });

    const failure = await runBuild(builderPath, createSelection({ modFilters: ['addon'] })).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(YmbError);
    expect((failure as YmbError).category).toBe('LayoutError');
    expect((failure as YmbError).context.absolutePath).toBeDefined();
  });

  test('a failure that is not about missing game data still stops an optional patch', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);
    await createAddon(builderPath, {
      broken: `version: 1
id: addon.broken
name: Broken
scope: prod
optional: true
targets:
  - file: ${PRESENT_TARGET}
    operations:
      - op: add
        value:
          $raw: 'export Descriptor_Unit_Torn is TEntityDescriptor ( Field = '
`,
    });

    const failure = await runBuild(builderPath, createSelection({ modFilters: ['addon'] })).catch(
      (error: unknown) => error,
    );

    // Broken NDF is a bug in the patch, not a game file that moved.
    expect(failure).toBeInstanceOf(YmbError);
    expect((failure as YmbError).category).toBe('ParserError');
  });

  test('the flag is rejected on a patch with no targets to depend on', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);
    await createAddon(builderPath, {
      empty: `version: 1
id: addon.empty
name: Empty
scope: prod
optional: true
files:
  - op: remove
    target: ${PRESENT_TARGET}
`,
    });

    const failure = await runValidate(
      builderPath,
      createSelection({ modFilters: ['addon'] }),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(YmbError);
    expect((failure as YmbError).category).toBe('ConfigError');
    expect((failure as YmbError).context.details?.join('\n')).toContain(
      'optional: has no game data to depend on',
    );
  });
});
