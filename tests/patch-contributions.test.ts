import { describe, expect, test } from 'bun:test';
import { materializePatchGroupOutput } from '../src/engine/materialize.ts';
import {
  comparePatchContributions,
  dedupeContributors,
  groupPatchContributions,
} from '../src/engine/patch-contributions.ts';
import { resolvePatchWorkerCount } from '../src/engine/patch-runtime.ts';
import { toPathKey } from '../src/path-utils.ts';
import type { BuildPlan, PatchApplication, PatchNotice, WrittenBuildFile } from '../src/types.ts';
import { asOperation } from './helpers/ndf.ts';
import { createTestBuilderContext, createTestPatchApplication } from './helpers/planner.ts';

describe('patch contribution helpers', () => {
  test('groups selected patch targets by normalized target path in sorted order', () => {
    const plan = createPlan([
      createApplication('mod_b', 'patch.second', ['GameData\\Generated\\B.ndf']),
      createApplication('mod_a', 'patch.first', [
        'CommonData/Text/A.ndf',
        'GameData/Generated/B.ndf',
      ]),
    ]);

    const grouped = groupPatchContributions(plan);

    expect([...grouped.keys()]).toEqual(['commondata/text/a.ndf', 'gamedata/generated/b.ndf']);
    expect(grouped.get('gamedata/generated/b.ndf')?.map((item) => item.patchOrder)).toEqual([0, 1]);
  });

  test('keeps dependency order authoritative while prioritized mods still run last', () => {
    const prioritized = createResolvedContribution('mod_b', 'patch.prioritized', true, 1);
    const regular = createResolvedContribution('mod_a', 'patch.regular', false, 0);
    const regularScript = createResolvedContribution('mod_a', 'patch.regular-script', true, 0);
    const sameModEarlier = createResolvedContribution('mod_a', 'patch.earlier', true, 0);
    const sameModLater = createResolvedContribution('mod_a', 'patch.later', true, 2);

    expect(comparePatchContributions(prioritized, regular, undefined)).toBeGreaterThan(0);
    expect(comparePatchContributions(regularScript, prioritized, 'mod_b')).toBeLessThan(0);
    expect(comparePatchContributions(sameModEarlier, sameModLater, undefined)).toBeLessThan(0);
  });

  test('dedupes contributors by mod and patch id', () => {
    const repeated = createResolvedContribution('mod_a', 'patch.same', false, 0);
    const repeatedAgain = createResolvedContribution('mod_a', 'patch.same', true, 1);
    const distinct = createResolvedContribution('mod_a', 'patch.other', false, 2);

    expect(dedupeContributors([repeated, repeatedAgain, distinct])).toEqual([
      { modId: 'mod_a', modName: 'MOD_A', patchId: 'patch.same' },
      { modId: 'mod_a', modName: 'MOD_A', patchId: 'patch.other' },
    ]);
  });

  test('bounds patch workers by jobs, available CPUs, and the memory-safe ceiling', () => {
    expect(resolvePatchWorkerCount(0, 32)).toBe(1);
    expect(resolvePatchWorkerCount(2, 32)).toBe(2);
    expect(resolvePatchWorkerCount(28, 32)).toBe(16);
    expect(resolvePatchWorkerCount(28, 8)).toBe(7);
    expect(resolvePatchWorkerCount(28, 1)).toBe(1);
  });
});

/**
 * A layered mod's file stands for both layers. Contributors were inherited; notices
 * were not, so every observation the lower layer made was dropped -- and a quietly
 * dead operation only shows up when the mod is built on its own.
 */
describe('layered patch output', () => {
  test('keeps the notices of the layer it was written over', async () => {
    const application = createApplication('mod_top', 'patch.top', [targetRelativePath]);
    application.mod.config.allowWriteToModifiedFiles = true;
    application.mod.config.priority = 10;

    const inheritedNotice: PatchNotice = {
      absolutePath: targetRelativePath,
      modId: 'mod_base',
      modName: 'MOD_BASE',
      patchId: 'patch.base',
      operationIndex: 3,
      reason: '`Descriptor_Unit_A.Availability` is already `2`, so this operation changed nothing.',
      suggestion: 'Delete the operation if it is finished.',
    };
    const previousOutputs = new Map<string, WrittenBuildFile>([
      [
        toPathKey(targetRelativePath),
        {
          targetRelativePath,
          sourceType: 'patch',
          content: layeredBaseText,
          contributors: [{ modId: 'mod_base', modName: 'MOD_BASE', patchId: 'patch.base' }],
          notices: [inheritedNotice],
        },
      ],
    ]);

    const plan = createPlan([application]);
    plan.selection.useCache = false;
    const written = await materializePatchGroupOutput(
      plan,
      [
        {
          application,
          // Writing the value the inherited output already holds, so this layer
          // contributes a notice of its own too.
          target: {
            file: targetRelativePath,
            operations: [
              asOperation({
                op: 'modify',
                selector: { kind: 'field', by: 'path', value: 'Descriptor_Unit_A.FrontArmor' },
                value: 5,
              }),
            ],
          },
          targetRelativePath,
          hasScripts: false,
          patchOrder: 0,
        },
      ],
      previousOutputs,
    );

    expect(written.contributors.map((contributor) => contributor.modId)).toEqual([
      'mod_base',
      'mod_top',
    ]);
    expect(written.notices?.map((notice) => notice.patchId)).toEqual(['patch.base', 'patch.top']);
  });
});

const targetRelativePath = 'GameData/Generated/Test.ndf';

const layeredBaseText = `export Descriptor_Unit_A is TEntityDescriptor
(
    FrontArmor = 5
    Availability = 2
)
`;

function createPlan(selectedPatches: PatchApplication[]): BuildPlan {
  return {
    context: createTestBuilderContext(),
    selection: {
      scope: 'prod',
      modFilters: [],
      patchFilters: [],
      dryRun: true,
      verbose: false,
      yes: false,
    },
    discoveredMods: [],
    selectedMods: selectedPatches.map((item) => item.mod),
    selectedPatches,
    selectedReplaceFiles: [],
    selectedFileDeletions: [],
    selectedScripts: [],
    explanations: [],
    skippedPatches: [],
    targetFiles: [],
    notices: [],
    unmatchedFilters: [],
  };
}

function createResolvedContribution(
  modId: string,
  patchId: string,
  hasScripts: boolean,
  patchOrder: number,
) {
  const application = createApplication(
    modId,
    patchId,
    ['GameData/Generated/Test.ndf'],
    hasScripts,
  );
  const target = application.patch.config.targets[0];
  if (!target) {
    throw new Error('Expected at least one target');
  }
  return {
    application,
    // The fixture writes plain operations, so it is already the expanded shape a
    // contribution carries.
    target: { file: target.file, operations: target.operations.map(asOperation) },
    targetRelativePath: 'GameData/Generated/Test.ndf',
    hasScripts,
    patchOrder,
  };
}

function createApplication(
  modId: string,
  patchId: string,
  targetFiles: string[],
  hasScripts = false,
): PatchApplication {
  return createTestPatchApplication({ modId, patchId, targetFiles, hasScripts });
}
