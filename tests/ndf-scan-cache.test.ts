import { beforeEach, describe, expect, test } from 'bun:test';
import { getNdfScanCacheStatsForTests, resetNdfScanCachesForTests } from '../src/patch/ndf/scan.ts';
import type { NdfOperation, PatchTarget } from '../src/types.ts';
import { application, applyPatchTarget } from './helpers/ndf.ts';

const BLOCK_COUNT = 40;
const source = `${Array.from(
  { length: BLOCK_COUNT },
  (_, index) => `export Descriptor_Unit_${index} is TEntityDescriptor
(
    FrontArmor = 1
    Padding = '${'x'.repeat(200)}'
)
`,
).join('\n')}`;

describe('ndf scan cache retention', () => {
  beforeEach(() => {
    resetNdfScanCachesForTests();
  });

  test('keeps one generation of an edited file instead of one per operation', async () => {
    const operations: NdfOperation[] = Array.from({ length: BLOCK_COUNT }, (_, index) => ({
      op: 'modify',
      selector: { kind: 'field', by: 'path', value: `Descriptor_Unit_${index}.FrontArmor` },
      value: index + 2,
    }));
    const target: PatchTarget = { file: 'GameData/Generated/Gameplay/Units.ndf', operations };

    const output = await applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');

    expect(output).toContain('FrontArmor = 2');
    expect(output).toContain(`FrontArmor = ${BLOCK_COUNT + 1}`);
    // Every operation rebuilds the whole file, so an unpruned index would pin one
    // full copy per edit up to its entry cap.
    const stats = getNdfScanCacheStatsForTests();
    expect(stats.entries).toBe(1);
    expect(stats.retainedChars).toBeLessThan(source.length * 2);
  });

  test('skips a commented-out header whether or not the file is indexed yet', async () => {
    // A commented-out `Foo is TFoo (` is common in shipped NDF. Resolving the
    // block to that header would take the unbalanced bracket in the comment as
    // real and hide the actual block from every following operation, so the
    // first lookup and the indexed one have to agree that it is not a block.
    const commented = `// Descriptor_Unit_0 is TEntityDescriptor (retired
export Descriptor_Unit_0 is TEntityDescriptor
(
    FrontArmor = 1
)
`;
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Units.ndf',
      operations: [
        {
          op: 'modify',
          selector: { kind: 'field', by: 'path', value: 'Descriptor_Unit_0.FrontArmor' },
          value: 4,
        },
      ],
    };

    const firstLookup = await applyPatchTarget(
      commented,
      target,
      application,
      'C:/fixture/Units.ndf',
    );
    const indexedLookup = await applyPatchTarget(
      commented,
      target,
      application,
      'C:/fixture/Units.ndf',
    );

    expect(firstLookup).toBe(indexedLookup);
    expect(firstLookup).toContain('FrontArmor = 4');
    expect(firstLookup).toContain('// Descriptor_Unit_0 is TEntityDescriptor (retired\n');
  });

  test('keeps one generation of a file a bulk operation rewrote', async () => {
    // A bulk operation rebuilds the whole file in one pass, and the caller
    // advances to that text immediately, so the text it was built from is
    // superseded exactly as it is after a single-block edit.
    const target: PatchTarget = {
      file: 'GameData/Generated/Gameplay/Units.ndf',
      operations: [
        {
          op: 'bulk',
          match: {
            mode: 'all',
            conditions: [{ on: 'name', is: 'startsWith', value: ['Descriptor_Unit_'] }],
          },
          edits: [{ field: 'FrontArmor', multiply: 2 }],
          expect: { minBlocks: BLOCK_COUNT },
        },
      ],
    };

    const output = await applyPatchTarget(source, target, application, 'C:/fixture/Units.ndf');

    expect(output).toContain('FrontArmor = 2');
    const stats = getNdfScanCacheStatsForTests();
    expect(stats.entries).toBe(1);
    expect(stats.retainedChars).toBeLessThan(source.length * 2);
  });

  test('still caches distinct files independently', async () => {
    const other = source.replaceAll('Descriptor_Unit_', 'Descriptor_Other_');
    const buildTarget = (blockPrefix: string): PatchTarget => ({
      file: 'GameData/Generated/Gameplay/Units.ndf',
      operations: [
        {
          op: 'modify',
          selector: { kind: 'field', by: 'path', value: `${blockPrefix}0.FrontArmor` },
          value: 9,
        },
        {
          op: 'modify',
          selector: { kind: 'field', by: 'path', value: `${blockPrefix}1.FrontArmor` },
          value: 9,
        },
      ],
    });

    await applyPatchTarget(
      source,
      buildTarget('Descriptor_Unit_'),
      application,
      'C:/fixture/A.ndf',
    );
    await applyPatchTarget(
      other,
      buildTarget('Descriptor_Other_'),
      application,
      'C:/fixture/B.ndf',
    );

    expect(getNdfScanCacheStatsForTests().entries).toBe(2);
  });
});
