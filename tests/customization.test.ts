import { afterEach, expect, test } from 'bun:test';
import path from 'node:path';
import { stringify } from 'yaml';
import { runBuild } from '../src/engine/commands.ts';
import { preparePlan } from '../src/engine/plan.ts';
import { YmbError } from '../src/errors.ts';
import { createTemplateVariables } from '../src/templates.ts';
import {
  cleanupTempRoots,
  createAbstractBuilderWorkspace,
  createSelection,
  sampleModConfigPath,
  writeModFixture,
} from './helpers/abstract-builder.ts';

const roots: string[] = [];
afterEach(() => cleanupTempRoots(roots));

test('nested customization reaches patches, scripts and replacement files without changing source', async () => {
  const { builderPath } = await createAbstractBuilderWorkspace(roots);
  await writeModFixture(builderPath, 'addon', {
    'config/ymb.mod.yaml': stringify({
      version: 1,
      id: 'addon',
      name: 'Addon',
      variables: { tuning: { speed: 2, size: 3 }, label: 'default', notice: { text: 'hello' } },
    }),
    'config/patch/feature/ymb.patch.yaml': stringify({
      version: 1,
      id: 'feature',
      name: 'Feature',
      scope: 'prod',
      variables: { tuning: { speed: 4, list: [1, 2] }, computed: '${tuning.speed * tuning.size}' },
      targets: [
        {
          file: 'GameData/Feature.ndf',
          operations: [
            {
              op: 'modify',
              selector: { kind: 'field', by: 'path', value: 'Sample.Value' },
              value: '${computed}',
            },
          ],
        },
      ],
      scripts: ['generate.ts'].map((entry) => ({ path: entry })),
    }),
    'config/patch/feature/generate.ts': `export default ({ variables }) => ({
      targetRelativePath: 'CommonData/generated.txt', content: String(variables.computed),
    });`,
    'config/replace/CommonData/label.txt': '${label}',
  });
  const original = 'Sample is TSample(\n    Value = 0\n)';
  await Bun.write(path.join(builderPath, '..', 'GameData/Feature.ndf'), original);
  const configPath = path.join(builderPath, 'ymb.config.yaml');
  const customization = {
    version: 1,
    variables: { tuning: { speed: 5 }, label: 'shared', modId: 'override', notice: null },
    mods: {
      addon: {
        variables: { tuning: { size: 7 }, label: 'local' },
        patches: { feature: { variables: { tuning: { speed: 6, list: [] } } } },
      },
    },
  };
  await Bun.write(configPath, stringify(customization));
  const selection = createSelection({ modFilters: ['addon'] });
  const plan = await preparePlan(builderPath, selection);
  const selected = plan.selectedPatches[0];
  if (!selected) throw new Error('Fixture patch was not selected');
  expect(createTemplateVariables(plan.context, selected.mod, selected.patch)).toMatchObject({
    tuning: { speed: 6, size: 7, list: [] },
    computed: 42,
    label: 'local',
    modId: 'addon',
    notice: null,
  });
  expect(selected.mod.config.variables?.tuning).toEqual({ speed: 2, size: 3 });
  expect(selected.patch.config.variables?.tuning).toEqual({ speed: 4, list: [1, 2] });
  await runBuild(builderPath, selection);
  const output = path.join(builderPath, '.ymb-build/output');
  expect(await Bun.file(path.join(output, 'GameData/Feature.ndf')).text()).toContain('Value = 42');
  expect(await Bun.file(path.join(output, 'CommonData/generated.txt')).text()).toContain('42');
  expect(await Bun.file(path.join(output, 'CommonData/label.txt')).text()).toContain('local');

  customization.mods.addon.patches.feature.variables.tuning.speed = 8;
  await Bun.write(configPath, stringify(customization));
  await runBuild(builderPath, selection);
  expect(await Bun.file(path.join(output, 'GameData/Feature.ndf')).text()).toContain('Value = 56');
  expect(await Bun.file(path.join(output, 'CommonData/generated.txt')).text()).toContain('56');
  expect(await Bun.file(path.join(builderPath, '..', 'GameData/Feature.ndf')).text()).toBe(
    original,
  );
});

test('local switches control selection and disabled patches do not read missing game data', async () => {
  const { builderPath } = await createAbstractBuilderWorkspace(roots);
  const patchPath = sampleModConfigPath(builderPath, 'patch/armor/ymb.patch.yaml');
  const source = await Bun.file(patchPath).text();
  await Bun.write(
    patchPath,
    `${source}\nreadValues:\n  absent:\n    file: GameData/Absent.ndf\n    path: Missing.Value\n`,
  );
  const configPath = path.join(builderPath, 'ymb.config.yaml');
  await Bun.write(
    configPath,
    stringify({
      version: 1,
      mods: {
        sample_pack: { patches: { 'balance.armor': { enabled: false } } },
      },
    }),
  );
  const plan = await preparePlan(builderPath, createSelection());
  expect(plan.selectedPatches).toHaveLength(0);
  expect(plan.selectedMods).toHaveLength(1);
  await Bun.write(configPath, stringify({ version: 1, mods: { sample_pack: { enabled: false } } }));
  const disabled = await preparePlan(builderPath, createSelection());
  expect(disabled.selectedMods).toHaveLength(0);
  expect(disabled.selectedScripts).toHaveLength(0);
});

test.each([
  { mods: { missing: {} } },
  { mods: { sample_pack: { patches: { missing: { enabled: false } } } } },
  { mods: { sample_pack: { enabled: 'false' } } },
  { mods: { sample_pack: { variabels: {} } } },
  { variables: { ['__proto__']: { polluted: true } } },
])('invalid customization is rejected with a config location: %j', async (settings) => {
  const { builderPath } = await createAbstractBuilderWorkspace(roots, {
    builderConfig: stringify({ version: 1, ...settings }),
  });
  try {
    await preparePlan(builderPath, createSelection());
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(YmbError);
    expect((error as YmbError).category).toBe('ConfigError');
    expect((error as YmbError).context.absolutePath).toBe(
      path.join(builderPath, 'ymb.config.yaml'),
    );
  }
});
