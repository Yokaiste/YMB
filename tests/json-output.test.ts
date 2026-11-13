import { afterAll, describe, expect, test } from 'bun:test';
import { symlink } from 'node:fs/promises';
import path from 'node:path';
import packageDefinition from '../package.json' with { type: 'json' };
import { buildJsonError, buildJsonInitResult, buildJsonResult } from '../src/cli/json-output.ts';
import { createCliProgram } from '../src/cli.ts';
import { CLI_COMMAND_NAMES } from '../src/cli-guide.ts';
import { resolveBuilderContext } from '../src/config/layout.ts';
import {
  runBuild,
  runCleanup,
  runDoctor,
  runList,
  runRecover,
  runSync,
} from '../src/engine/commands.ts';
import { runFind } from '../src/engine/find.ts';
import { YmbError, YmbErrorGroup } from '../src/errors.ts';
import { selectionCommand, toCommandOutput } from '../src/report/output.ts';
import type { SelectionInput } from '../src/types.ts';
import {
  cleanupTempRoots,
  createAbstractBuilderWorkspace,
  createSelection,
} from './helpers/abstract-builder.ts';

const tempRoots: string[] = [];
afterAll(() => cleanupTempRoots(tempRoots));

const selection: SelectionInput = {
  scope: 'prod',
  modFilters: ['my_pack'],
  patchFilters: [],
  dryRun: false,
  verbose: false,
  useCache: false,
  yes: true,
};

function sampleLines() {
  return toCommandOutput(['first detail', 'second detail', 'third detail'], {
    summary: [
      { label: 'wrote', value: '2 files, 1 warning' },
      { label: 'took', value: '1.20s' },
    ],
    detailHeading: 'preview files',
    locations: [{ label: 'preview', path: 'C:/mod/YMB/.ymb-build/output' }],
    nextSteps: ['Run `sync --yes` only after the preview looks correct.'],
  });
}

describe('json output', () => {
  test('every command result carries the same envelope', () => {
    const result = buildJsonResult('build', selection, sampleLines());

    expect(result.ymb).toBe(packageDefinition.version);
    expect(result.command).toBe('build');
    expect(result.ok).toBe(true);
    expect(result.schemaVersion).toBe(2);
  });

  test('human presentation fields are not repeated in JSON', () => {
    const result = buildJsonResult('build', selection, sampleLines());

    expect(Object.keys(result).sort()).toEqual([
      'command',
      'data',
      'ok',
      'schemaVersion',
      'selection',
      'ymb',
    ]);
  });

  test('selection reports what was asked for, including cache state', () => {
    expect(buildJsonResult('build', selection, sampleLines()).selection).toEqual({
      scope: 'prod',
      mods: ['my_pack'],
      patches: [],
      dryRun: false,
      useCache: false,
      requireAll: false,
    });
  });

  test('a failure is the same envelope with ok false', () => {
    const error = new YmbError('SelectorError', {
      absolutePath: 'C:/mod/GameData/Units.ndf',
      modId: 'my_pack',
      modName: 'My Pack',
      patchId: 'balance.armor',
      operationIndex: 2,
      reason: 'Anchor block `Missing` was not found.',
      suggestion: 'Use an existing top-level block name.',
      details: ['first note'],
    });

    const result = buildJsonError('build', error);

    expect(result.ok).toBe(false);
    expect(result.command).toBe('build');
    // A list even for one problem, so a caller never has to branch on the shape.
    expect(result.errorCount).toBe(1);
    expect(result.errors).toEqual([
      {
        category: 'SelectorError',
        reason: 'Anchor block `Missing` was not found.',
        suggestion: 'Use an existing top-level block name.',
        path: 'C:/mod/GameData/Units.ndf',
        modId: 'my_pack',
        modName: 'My Pack',
        patchId: 'balance.armor',
        // Both, because the config author counts operations from one and the
        // machine reading this indexes from zero.
        operationIndex: 2,
        operationNumber: 3,
        details: ['first note'],
      },
    ]);
  });

  test('several failures all reach the caller with a complete count', () => {
    const group = new YmbErrorGroup([
      new YmbError('IoError', {
        absolutePath: 'C:/mod/GameData/A.ndf',
        reason: 'Target file `GameData/A.ndf` does not exist.',
        suggestion: 'Fix the target path.',
      }),
      new YmbError('IoError', {
        absolutePath: 'C:/mod/GameData/B.ndf',
        reason: 'Target file `GameData/B.ndf` does not exist.',
        suggestion: 'Fix the target path.',
      }),
    ]);

    const result = buildJsonError('validate', group);

    expect((result.errors as unknown[]).length).toBe(2);
    expect(result.errorCount).toBe(2);
    expect(result.omittedErrorCount).toBe(0);
    expect((result.errors as Array<Record<string, unknown>>)[1]?.path).toBe(
      'C:/mod/GameData/B.ndf',
    );
  });

  test('native data does not depend on human labels or details', () => {
    const data = { counts: { files: 3 }, healthy: false, files: [{ path: 'sample.ndf' }] };
    for (const label of ['Earlier wording', 'Revised wording']) {
      const lines = toCommandOutput([label], {
        summary: [{ label, value: 'anything' }],
        detailHeading: label,
        data,
      });
      expect(buildJsonResult('build', selection, lines).data).toEqual(data);
    }
  });

  test('source coordinates survive error serialization', () => {
    const context = {
      absolutePath: 'sample.ndf',
      patchConfigPath: 'example.yaml',
      operationLine: 42,
      operationIndex: 3,
      reason: 'sample reason',
      suggestion: 'sample fix',
    };
    const result = buildJsonError('build', new YmbError('SelectorError', context));
    expect(result.errors).toEqual([
      expect.objectContaining({
        patchConfigPath: context.patchConfigPath,
        operationLine: context.operationLine,
        operationIndex: context.operationIndex,
      }),
    ]);
  });

  test('inspection, search and build expose records and native counts', async () => {
    const workspace = await createAbstractBuilderWorkspace(tempRoots);
    const selected = createSelection({ modFilters: ['sample_pack'] });
    const listed = await runList(workspace.builderPath, selected);
    expect(listed.data?.mods).toEqual([
      expect.objectContaining({ id: 'sample_pack', enabled: true, patches: expect.any(Array) }),
    ]);
    const file = 'GameData/Generated/Gameplay/SearchFixture.ndf';
    const names = ['Sample_Orchid', 'Sample_Iris'];
    await Bun.write(
      path.join(workspace.modRootPath, file),
      names.map((name) => `${name} is TSample\n( Value = 9 )`).join('\n'),
    );
    const found = await runFind(workspace.builderPath, selected, {
      files: [file],
      name: 'Sample_',
      limit: 1,
    });
    expect(found.data).toMatchObject({
      matchCount: names.length,
      searchedFiles: 1,
      truncated: true,
      limit: 1,
      matches: [{ name: names[0], type: 'TSample', path: file, selector: names[0] }],
    });
    const built = await runBuild(workspace.builderPath, selected);
    const files = built.data?.files as Array<Record<string, unknown>>;
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((entry) => typeof entry.path === 'string' && !('content' in entry))).toBe(
      true,
    );
    expect(built.data?.counts).toMatchObject({ files: files.length, warnings: expect.any(Number) });
    expect(built.data?.paths).toEqual({
      preview: path.join(workspace.builderPath, '.ymb-build', 'output'),
    });
    const doctor = await runDoctor(workspace.builderPath, selected);
    expect(doctor.data?.runtime).toMatchObject({ compatible: expect.any(Boolean) });
    const cleanup = await runCleanup(
      workspace.builderPath,
      createSelection({
        modFilters: ['missing_project'],
        dryRun: true,
      }),
      false,
    );
    expect(cleanup.data?.unmatchedFilters).toEqual([
      { option: '--mod', value: 'missing_project', availableIds: ['sample_pack'] },
    ]);
  });

  test('recovery reports whole-file actions and all affected contributors', async () => {
    const workspace = await createAbstractBuilderWorkspace(tempRoots);
    const selected = createSelection({ modFilters: ['sample_pack'] });
    await runSync(workspace.builderPath, selected);
    const context = await resolveBuilderContext(workspace.builderPath);
    const orphan = `${'e'.repeat(64)}.ndf`;
    await Bun.write(path.join(context.stateRoot, 'originals', orphan), 'unused backup');
    const recovered = await runRecover(workspace.builderPath, selected);
    expect(recovered.data?.paths).toMatchObject({
      game: workspace.modRootPath,
      recovery: expect.any(String),
    });
    expect(recovered.data?.files).toContainEqual({
      path: 'GameData/Generated/Gameplay/Units.ndf',
      action: 'restore',
      contributors: expect.arrayContaining([
        expect.objectContaining({ modId: 'sample_pack', patchId: 'balance.armor' }),
      ]),
    });
    expect(recovered.data?.files).toContainEqual(
      expect.objectContaining({
        path: 'GameData/Generated/Gameplay/ArmorSummary.ndf',
        action: 'delete',
      }),
    );
    expect(recovered.data?.sweptBackups).toEqual([orphan]);
  });

  test('sync reports updated, current, obsolete and retained recovery files', async () => {
    const workspace = await createAbstractBuilderWorkspace(tempRoots);
    const selected = createSelection({ modFilters: ['sample_pack'] });
    const units = 'GameData/Generated/Gameplay/Units.ndf';
    const generated = 'GameData/Generated/Gameplay/ArmorSummary.ndf';
    const unitsPath = path.join(workspace.modRootPath, units);
    const originalUnits = await Bun.file(unitsPath).text();
    const first = await runSync(workspace.builderPath, selected);
    expect(first.data?.files).toContainEqual(
      expect.objectContaining({ path: units, action: 'updated' }),
    );

    const patchPath = path.join(
      workspace.builderPath,
      'mods/sample-pack/config/patch/armor/ymb.patch.yaml',
    );
    await Bun.write(
      patchPath,
      (await Bun.file(patchPath).text()).replace('enabled: true', 'enabled: false'),
    );
    const dryRun = await runSync(workspace.builderPath, { ...selected, dryRun: true });
    expect(dryRun.data?.obsoleteFiles).toEqual([
      expect.objectContaining({ path: generated, action: 'delete' }),
      expect.objectContaining({
        path: units,
        action: 'restore',
        contributors: expect.arrayContaining([expect.objectContaining({ modId: 'sample_pack' })]),
      }),
    ]);
    expect(await Bun.file(unitsPath).text()).not.toBe(originalUnits);
    expect(await Bun.file(path.join(workspace.modRootPath, generated)).exists()).toBe(true);

    const context = await resolveBuilderContext(workspace.builderPath);
    const originals = path.join(context.stateRoot, 'originals');
    const orphan = `${'e'.repeat(64)}.ndf`;
    const blocked = `${'f'.repeat(64)}.ndf`;
    await Bun.write(path.join(originals, orphan), 'unused backup');
    await Bun.write(path.join(originals, 'notes.txt'), 'keep');
    await Bun.write(path.join(originals, blocked, 'keep.txt'), 'not a backup file');
    const second = await runSync(workspace.builderPath, selected);
    expect(second.data?.obsoleteFiles).toEqual(dryRun.data?.obsoleteFiles);
    expect(second.data?.files).toContainEqual(
      expect.objectContaining({
        path: 'CommonData/Text/sample_pack-generated-by-mod.ndf',
        action: 'current',
      }),
    );
    expect(second.data?.sweptBackups).toEqual([orphan]);
    expect(second.data?.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: units, severity: 'note' }),
        expect.objectContaining({ subject: generated, severity: 'note' }),
        expect.objectContaining({ subject: 'notes.txt', severity: 'note' }),
        expect.objectContaining({ subject: blocked, severity: 'warning' }),
      ]),
    );
    expect(second.data?.counts).toMatchObject({ obsolete: 2, sweptBackups: 1, warnings: 1 });
    expect(await Bun.file(unitsPath).text()).toBe(originalUnits);
    expect(await Bun.file(path.join(workspace.modRootPath, generated)).exists()).toBe(false);
  });

  test('follow-up commands preserve filters and validation choices', () => {
    const selected = createSelection({
      modFilters: ['Sample Pack', 'second'],
      patchFilters: ['feature.one'],
      scope: 'dev',
      requireAll: true,
      useCache: false,
    });
    expect(selectionCommand('sync', selected, ['--yes'])).toBe(
      'sync --mod "Sample Pack" --mod second --patch feature.one --scope dev --require-all --no-cache --yes',
    );
  });

  test('cleanup reports refused removals as failures and preserves their contents', async () => {
    const workspace = await createAbstractBuilderWorkspace(tempRoots);
    const outside = path.join(workspace.rootPath, 'preserve');
    const protectedFile = path.join(outside, 'sample.txt');
    const contents = 'Keep these bytes';
    await Bun.write(protectedFile, contents);
    const alias = path.join(workspace.builderPath, '.ymb-alias');
    await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const failure = await runCleanup(workspace.builderPath, createSelection(), false).catch(
      (error) => error,
    );
    expect(failure).toBeInstanceOf(YmbError);
    expect(buildJsonError('cleanup', failure)).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ category: 'IoError', path: alias })],
    });
    expect(await Bun.file(protectedFile).text()).toBe(contents);
  });

  test('CLI help, version and failures are a single JSON document with no terminal chatter', async () => {
    const workspace = await createAbstractBuilderWorkspace(tempRoots);
    for (const args of [
      ['--help', '--json'],
      ['build', '--help', '--json'],
      ['help', 'build', '--json'],
      ['--version', '--json'],
      ['--json', 'list', '--ymb-path', workspace.builderPath],
      ['init', '--json', '--ymb-path', workspace.builderPath],
      ['build', '--json', '--unknown-option'],
    ]) {
      const child = Bun.spawn([process.execPath, path.resolve('index.ts'), ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe('');
      expect(stdout.trim().split('\n')).toHaveLength(1);
      const result = JSON.parse(stdout);
      expect(result.schemaVersion).toBe(2);
      expect(result.ok).toBe(exitCode === 0);
      if (args.includes('--help') || args[0] === 'help') {
        expect(result.command).toBe('help');
        expect(result.data.name).toBe(args.includes('build') ? 'build' : 'ymb');
        expect(result.data.options).toContainEqual(
          expect.objectContaining({ flags: '-h, --help' }),
        );
      }
      if (args[0] === 'init') expect(result.ok).toBe(false);
      if (args[0] === '--json') expect(result.data.mods).toBeArray();
    }
  });

  test('JSON conflicts fail without opening a prompt, even in a terminal', async () => {
    const workspace = await createAbstractBuilderWorkspace(tempRoots);
    for (const [id, value] of [
      ['json_alpha', 11],
      ['json_bravo', 22],
    ] as const) {
      const configRoot = path.join(workspace.builderPath, 'mods', id, 'config');
      await Bun.write(
        path.join(configRoot, 'ymb.mod.yaml'),
        `version: 1\nid: ${id}\nname: ${id}\n`,
      );
      await Bun.write(
        path.join(configRoot, 'patch', 'armor', 'ymb.patch.yaml'),
        `version: 1
id: ${id}.armor
name: Armor
scope: prod
targets:
  - file: GameData/Generated/Gameplay/Units.ndf
    operations:
      - op: modify
        selector: { kind: field, by: path, value: Descriptor_Unit_T80U.FrontArmor }
        value: ${value}
`,
      );
    }
    const script = `
      import readline from 'node:readline/promises';
      import { runCli } from './src/cli.ts';
      Object.defineProperty(process.stdin, 'isTTY', { value: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: true });
      readline.createInterface = () => { throw new Error('Unexpected prompt'); };
      await runCli(['bun', 'ymb', 'build', '--json', '--ymb-path', ${JSON.stringify(workspace.builderPath)}, '--mod', 'json_alpha', '--mod', 'json_bravo']);
    `;
    const child = Bun.spawn([process.execPath, '--eval', script], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toBe('');
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      errors: [
        expect.objectContaining({
          category: 'CommandError',
          path: 'GameData/Generated/Gameplay/Units.ndf',
        }),
      ],
    });
  });

  test('an unexpected failure still produces a readable envelope', () => {
    const failure = (
      buildJsonError('sync', new Error('disk went away')).errors as Array<Record<string, unknown>>
    )[0];

    expect(failure?.category).toBe('UnexpectedError');
    expect(failure?.reason).toBe('disk went away');
    expect(failure?.suggestion).toBeTruthy();
  });

  test('init reports what it created', () => {
    const result = buildJsonInitResult({
      data: {
        id: 'sample',
        name: 'Sample',
        path: 'C:/mod/YMB/mods/sample',
        files: ['config/ymb.mod.yaml', 'README.md'],
      },
      modsRoot: 'C:/mod/YMB/mods',
      lines: ['config/ymb.mod.yaml', 'config/patch/ui/ymb.patch.yaml'],
    });

    expect(result.command).toBe('init');
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      id: 'sample',
      files: ['config/ymb.mod.yaml', 'README.md'],
    });
    expect(result).not.toHaveProperty('created');
    expect(result).not.toHaveProperty('modsRoot');
  });

  test('the flag is offered on every command YMB has', () => {
    // Read off the real command tree, so wiring a new command without `--json`
    // fails here no matter how the registration is written.
    const commandsByName = new Map(
      createCliProgram().commands.map((command) => [command.name(), command] as const),
    );

    expect(CLI_COMMAND_NAMES.length).toBeGreaterThan(0);
    expect([...commandsByName.keys()].sort()).toEqual([...CLI_COMMAND_NAMES].sort());
    for (const name of CLI_COMMAND_NAMES) {
      const options = commandsByName.get(name)?.options ?? [];
      expect(options.map((option) => option.long)).toContain('--json');
    }
  });
});
