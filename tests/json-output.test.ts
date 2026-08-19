import { describe, expect, test } from 'bun:test';
import packageDefinition from '../package.json' with { type: 'json' };
import { buildJsonError, buildJsonInitResult, buildJsonResult } from '../src/cli/json-output.ts';
import { createCliProgram } from '../src/cli.ts';
import { CLI_COMMAND_NAMES } from '../src/cli-guide.ts';
import { YmbError, YmbErrorGroup } from '../src/errors.ts';
import { toCommandOutput } from '../src/report/output.ts';
import type { SelectionInput } from '../src/types.ts';

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
  });

  test('summary lines become named fields instead of prose', () => {
    const result = buildJsonResult('build', selection, sampleLines());

    expect(result.summary).toEqual({ wrote: '2 files, 1 warning', took: '1.20s' });
  });

  test('details are complete, because truncation is a reading aid for people', () => {
    const lines = toCommandOutput(
      Array.from({ length: 50 }, (_value, index) => `detail ${index}`),
      { summary: [], detailHeading: 'preview files' },
    );

    // The human layout stops at six lines without `--verbose`. A machine caller
    // asked for the result, not a preview of it.
    expect((buildJsonResult('build', selection, lines).details as string[]).length).toBe(50);
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

  test('locations and next steps survive as structured data', () => {
    const result = buildJsonResult('build', selection, sampleLines());

    expect(result.locations).toEqual([{ label: 'preview', path: 'C:/mod/YMB/.ymb-build/output' }]);
    expect(result.nextSteps).toEqual(['Run `sync --yes` only after the preview looks correct.']);
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

  test('several failures all reach the caller, and the count includes any dropped', () => {
    const group = new YmbErrorGroup(
      [
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
      ],
      7,
    );

    const result = buildJsonError('validate', group);

    expect((result.errors as unknown[]).length).toBe(2);
    expect(result.errorCount).toBe(9);
    expect((result.errors as Array<Record<string, unknown>>)[1]?.path).toBe(
      'C:/mod/GameData/B.ndf',
    );
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
      modsRoot: 'C:/mod/YMB/mods',
      lines: ['config/ymb.mod.yaml', 'config/patch/ui/ymb.patch.yaml'],
    });

    expect(result.command).toBe('init');
    expect(result.ok).toBe(true);
    expect(result.modsRoot).toBe('C:/mod/YMB/mods');
    expect(result.created).toHaveLength(2);
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
