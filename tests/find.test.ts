import { afterEach, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { runFind } from '../src/engine/find.ts';
import { YmbError } from '../src/errors.ts';
import {
  cleanupTempRoots,
  createAbstractBuilderWorkspace,
  createSelection,
  summaryText,
  writeWorkspaceFiles,
} from './helpers/abstract-builder.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  await cleanupTempRoots(tempRoots);
});

const baseQuery = { files: [] as string[], limit: 50 };

/**
 * `find` is the answer to "what is this block called". Its whole value is that
 * the names it prints can be pasted into a selector unchanged.
 */
describe('find', () => {
  test('matches a block by partial, case-insensitive name', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);

    const lines = await runFind(builderPath, createSelection(), { ...baseQuery, name: 't80u' });

    expect(lines.some((line) => line.startsWith('Descriptor_Unit_T80U |'))).toBe(true);
    expect(summaryText(lines)).toContain('match');
  });

  test('reports the type and the file beside every name', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);

    const lines = await runFind(builderPath, createSelection(), {
      ...baseQuery,
      name: 'Descriptor_Unit_T80U',
    });

    expect(lines[0]).toBe(
      'Descriptor_Unit_T80U | TEntityDescriptor | GameData/Generated/Gameplay/Units.ndf',
    );
  });

  test('matches by type as well as by name', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);

    const byType = await runFind(builderPath, createSelection(), {
      ...baseQuery,
      type: 'TEntityDescriptor',
    });

    expect(byType.length).toBeGreaterThan(1);
    expect(byType.every((line) => line.includes('| TEntityDescriptor |'))).toBe(true);
  });

  test('matches by a field value, including nested fields', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);

    const matched = await runFind(builderPath, createSelection(), {
      ...baseQuery,
      field: 'FrontArmor=5',
    });
    const unmatched = await runFind(builderPath, createSelection(), {
      ...baseQuery,
      field: 'FrontArmor=999',
    });

    expect(matched.length).toBeGreaterThan(0);
    expect(unmatched).toHaveLength(0);
  });

  test('combines filters instead of widening the result', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);

    const lines = await runFind(builderPath, createSelection(), {
      ...baseQuery,
      name: 'T80U',
      type: 'TNotARealType',
    });

    expect(lines).toHaveLength(0);
  });

  test('stops at the limit and says the list is short', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);

    const lines = await runFind(builderPath, createSelection(), {
      ...baseQuery,
      type: 'TEntityDescriptor',
      limit: 1,
    });

    expect(lines).toHaveLength(1);
    expect(lines.nextSteps?.[0]).toContain('Only the first 1 matches');
  });

  test('searches a named file even when no patch targets it', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);

    const lines = await runFind(builderPath, createSelection(), {
      ...baseQuery,
      files: ['GameData/Generated/Gameplay/Units.ndf'],
      name: 'T80U',
    });

    expect(lines.length).toBeGreaterThan(0);
  });

  test('rejects an explicitly named file that does not exist', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);

    await expect(
      runFind(builderPath, createSelection(), {
        ...baseQuery,
        files: ['GameData/Generated/Gameplay/Missing.ndf'],
        name: 'anything',
      }),
    ).rejects.toThrow('Search file `GameData/Generated/Gameplay/Missing.ndf` does not exist.');
  });

  /** A patch can select a template by name, so `find` has to hand that name over. */
  test('lists templates alongside ordinary blocks, in file order', async () => {
    const { rootPath, builderPath } = await createAbstractBuilderWorkspace(tempRoots);
    const targetRelativePath = 'GameData/Generated/Gameplay/Shapes.ndf';
    await writeWorkspaceFiles(rootPath, {
      [targetRelativePath]: `template Sample_Shape [ Size = 1 ] is TShape
(
    Width = 3
)

export Descriptor_Shape_A is TShapeDescriptor
(
    Width = 4
)
`,
    });

    const lines = await runFind(builderPath, createSelection(), {
      ...baseQuery,
      files: [targetRelativePath],
      name: 'Shape',
    });

    expect(lines).toEqual([
      `Sample_Shape | template | ${targetRelativePath}`,
      `Descriptor_Shape_A | TShapeDescriptor | ${targetRelativePath}`,
    ]);
  });

  test('refuses a search with nothing to look for', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);

    await expect(runFind(builderPath, createSelection(), baseQuery)).rejects.toBeInstanceOf(
      YmbError,
    );
  });

  test('names a malformed field filter instead of ignoring it', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);

    await expect(
      runFind(builderPath, createSelection(), { ...baseQuery, field: 'NoEqualsSign' }),
    ).rejects.toThrow('Name=Value');
  });

  test('never writes anything', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);
    const previewRoot = path.join(builderPath, '.ymb-build', 'output');

    await runFind(builderPath, createSelection(), { ...baseQuery, name: 'T80U' });

    // A read-only command has no business creating a preview folder.
    expect(await Bun.file(path.join(previewRoot, 'anything')).exists()).toBe(false);
  });
});
