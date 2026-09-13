import { describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { preparePlan } from '../src/engine/commands.ts';
import { materializeReplaceOutputs } from '../src/engine/replace-materialize.ts';
import { createScriptExecutionContext } from '../src/scripts/runtime-context.ts';
import { cleanupTempRoots, createAbstractBuilderWorkspace } from './helpers/abstract-builder.ts';
import { createTestScriptApplication } from './helpers/planner.ts';

describe('replace materialization', () => {
  test('renders text templates and preserves binary replace files', async () => {
    const tempRoots: string[] = [];
    const { builderPath: tempBuilderPath } = await createAbstractBuilderWorkspace(tempRoots);
    const textReplacePath = path.join(
      tempBuilderPath,
      'mods',
      'sample-pack',
      'config',
      'replace',
      'CommonData',
      'Text',
      'template-output.ndf',
    );
    const binaryReplacePath = path.join(
      tempBuilderPath,
      'mods',
      'sample-pack',
      'config',
      'replace',
      'CommonData',
      'Text',
      'binary.bin',
    );

    try {
      await mkdir(path.dirname(textReplacePath), { recursive: true });
      await Bun.write(
        textReplacePath,
        'Generated_${modId} is TGenerated (\n    RootName = "${modRootName}"\n)\n',
      );
      await Bun.write(binaryReplacePath, new Uint8Array([1, 2, 3, 4]));

      const plan = await preparePlan(tempBuilderPath, {
        scope: 'prod',
        modFilters: [],
        patchFilters: [],
        dryRun: true,
        verbose: false,
        yes: false,
      });
      const outputs = await materializeReplaceOutputs(plan);
      const { context } = createScriptExecutionContext(
        plan,
        createTestScriptApplication({ patchId: 'sample' }),
        new Map(),
      );
      const readText = await context.readTarget('CommonData/Text/./template-output.ndf');
      const readBytes = await context.readBinaryTarget('CommonData/Text/template-output.ndf');
      expect(new TextDecoder().decode(readBytes)).toBe(readText);
      expect(readText).toContain('Generated_sample_pack is TGenerated');
      expect(readText).toContain(`RootName = "${path.basename(plan.context.modRoot)}"`);
      expect(await context.readBinaryTarget('CommonData/Text/binary.bin')).toEqual(
        new Uint8Array([1, 2, 3, 4]),
      );
      const textOutput = outputs.find((output) =>
        output.targetRelativePath.endsWith('template-output.ndf'),
      );
      const binaryOutput = outputs.find((output) =>
        output.targetRelativePath.endsWith('binary.bin'),
      );

      expect(typeof textOutput?.content).toBe('string');
      expect(textOutput?.content).toContain('Generated_sample_pack is TGenerated');
      expect(textOutput?.contributors).toEqual([{ modId: 'sample_pack', modName: 'Sample Pack' }]);

      expect(binaryOutput?.content).toBeInstanceOf(Uint8Array);
      expect(Array.from(binaryOutput?.content as Uint8Array)).toEqual([1, 2, 3, 4]);
    } finally {
      await cleanupTempRoots(tempRoots);
    }
  });
});
