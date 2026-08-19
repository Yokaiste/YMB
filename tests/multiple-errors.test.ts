import { afterEach, describe, expect, test } from 'bun:test';
import { runCli } from '../src/cli.ts';
import { runValidate } from '../src/engine/commands.ts';
import {
  createErrorCollector,
  formatErrorGroupLines,
  YmbError,
  YmbErrorGroup,
} from '../src/errors.ts';
import {
  cleanupTempRoots,
  createAbstractBuilderWorkspace,
  createSelection,
  writeModFixture,
} from './helpers/abstract-builder.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  await cleanupTempRoots(tempRoots);
});

function ioError(name: string): YmbError {
  return new YmbError('IoError', {
    absolutePath: `C:/mod/GameData/${name}.ndf`,
    reason: `Target file \`GameData/${name}.ndf\` does not exist.`,
    suggestion: 'Fix the target path or add the missing input file before building.',
  });
}

function missingTargetPatch(patchId: string, file: string): string {
  return `version: 1
id: ${patchId}
name: ${patchId}
scope: prod
targets:
  - file: ${file}
    operations:
      - op: modify
        selector:
          kind: field
          by: path
          value: Descriptor_Unit_T72.Availability
        value: 9
`;
}

describe('collecting failures instead of stopping at the first', () => {
  test('keeps every failure and raises them together', () => {
    const failures = createErrorCollector();

    failures.record(ioError('A'));
    failures.record(ioError('B'));

    expect(failures.count()).toBe(2);
    let thrown: unknown;
    try {
      failures.throwIfFailed();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(YmbErrorGroup);
    expect((thrown as YmbErrorGroup).errors.map((error) => error.context.absolutePath)).toEqual([
      'C:/mod/GameData/A.ndf',
      'C:/mod/GameData/B.ndf',
    ]);
  });

  test('a lone failure is raised as itself, not wrapped in a group of one', () => {
    const failures = createErrorCollector();
    const only = ioError('A');
    failures.record(only);

    expect(() => failures.throwIfFailed()).toThrow(only);
  });

  test('nothing collected raises nothing', () => {
    const failures = createErrorCollector();

    expect(failures.count()).toBe(0);
    expect(() => failures.throwIfFailed()).not.toThrow();
  });

  test('the same failure found twice is reported once', () => {
    const failures = createErrorCollector();

    // Two phases of one command can reach the same broken file.
    failures.record(ioError('A'));
    failures.record(ioError('A'));

    expect(failures.count()).toBe(1);
  });

  test('a nested group is flattened rather than nested', () => {
    const failures = createErrorCollector();

    failures.record(new YmbErrorGroup([ioError('A'), ioError('B')], 3));
    failures.record(ioError('C'));

    expect(failures.count()).toBe(6);
  });

  test('a failure that is not a YMB result is a bug, so it propagates untouched', async () => {
    const failures = createErrorCollector();
    const bug = new TypeError('cannot read property of undefined');

    expect(
      failures.collect(() => {
        throw bug;
      }),
    ).rejects.toThrow(bug);
    expect(failures.count()).toBe(0);
  });

  test('past the report limit the run keeps counting but stops printing', () => {
    const failures = createErrorCollector();
    for (let index = 0; index < 40; index += 1) {
      failures.record(ioError(`file-${index}`));
    }

    let thrown: unknown;
    try {
      failures.throwIfFailed();
    } catch (error) {
      thrown = error;
    }
    const group = thrown as YmbErrorGroup;

    expect(failures.count()).toBe(40);
    expect(group.errors.length).toBe(25);
    expect(group.omittedCount).toBe(15);
    expect(group.message).toContain('40 problems found');
    expect(group.message).toContain('15 more not shown');
  });

  test('collect returns the task result when nothing goes wrong', async () => {
    const failures = createErrorCollector();

    expect(await failures.collect(async () => 'value')).toBe('value');
    expect(
      await failures.collect(async () => {
        throw ioError('A');
      }),
    ).toBeUndefined();
  });
});

describe('reading a report of several failures', () => {
  test('each one keeps the reason, fix, and owners a single failure would have shown', () => {
    const lines = formatErrorGroupLines([
      new YmbError('IoError', {
        absolutePath: 'C:/mod/GameData/A.ndf',
        modId: 'addon',
        modName: 'Addon',
        patchId: 'addon.first',
        reason: 'Target file `GameData/A.ndf` does not exist.',
        suggestion: 'Fix the target path.',
      }),
      new YmbError('SelectorError', {
        absolutePath: 'C:/mod/GameData/B.ndf',
        patchId: 'addon.second',
        operationIndex: 2,
        reason: 'Anchor block `Missing` was not found.',
        suggestion: 'Use an existing top-level block name.',
        details: ['first note'],
      }),
    ]);
    const report = lines.join('\n');

    expect(lines[0]).toBe('[x] 2 problems found');
    expect(report).toContain('1 of 2  File is missing or unreadable');
    expect(report).toContain('2 of 2  Nothing matched this selector');
    expect(report).toContain('Target file `GameData/A.ndf` does not exist.');
    expect(report).toContain('Anchor block `Missing` was not found.');
    // Each block pads its own labels, so a short one is not stretched by a long
    // label another failure happened to need.
    expect(report).toContain('    Fix    Fix the target path.\n    File   C:/mod/GameData/A.ndf');
    expect(report).toContain('    Mod    addon (Addon)');
    expect(report).toContain('    Patch  addon.first');
    expect(report).toContain('    Fix         Use an existing top-level block name.');
    // No line was recorded for this fixture, so the ordinal is all there is.
    expect(report).toContain('    Written at  operation #3');
    expect(report).toContain('    Note        first note');
    // Nothing trails the last block; the CLI adds its own spacing.
    expect(lines.at(-1)).not.toBe('');
  });

  /** Finding operation 159 means counting YAML entries by hand, so a known line replaces the count. */
  test('names the patch file and line when the operation carries one', () => {
    const report = formatErrorGroupLines([
      new YmbError('SelectorError', {
        absolutePath: 'C:/mod/GameData/B.ndf',
        modId: 'addon',
        patchId: 'addon.second',
        operationIndex: 158,
        patchConfigPath: 'C:/mod/config/patch/second/ymb.patch.yaml',
        operationLine: 1345,
        reason: 'Anchor block `Missing` was not found.',
        suggestion: 'Use an existing top-level block name.',
      }),
    ]).join('\n');

    expect(report).toContain('Written at  C:/mod/config/patch/second/ymb.patch.yaml:1345');
    expect(report).not.toContain('#159');
  });
});

describe('a command that finds several problems', () => {
  test('validate names every broken target instead of only the first', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);
    await writeModFixture(builderPath, 'addon', {
      'config/ymb.mod.yaml': 'version: 1\nid: addon\nname: Addon\n',
      'config/patch/first/ymb.patch.yaml': missingTargetPatch(
        'addon.first',
        'GameData/Generated/Gameplay/GoneA.ndf',
      ),
      'config/patch/second/ymb.patch.yaml': missingTargetPatch(
        'addon.second',
        'GameData/Generated/Gameplay/GoneB.ndf',
      ),
    });

    const failure = await runValidate(
      builderPath,
      createSelection({ modFilters: ['addon'] }),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(YmbErrorGroup);
    const group = failure as YmbErrorGroup;
    // Once each: the target check and materialization both reach these files.
    expect(group.errors.length).toBe(2);
    expect(group.message).toContain('GoneA.ndf');
    expect(group.message).toContain('GoneB.ndf');
    expect(group.errors.map((error) => error.context.patchId).sort()).toEqual([
      'addon.first',
      'addon.second',
    ]);
  });

  /** Notices carried the config path while `ensure` deep in the NDF walk wrote its owner fields by hand and left it off. */
  test('a failing operation names its patch file and line, exactly as a notice does', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);
    await writeModFixture(builderPath, 'addon', {
      'config/ymb.mod.yaml': 'version: 1\nid: addon\nname: Addon\n',
      'config/patch/broken/ymb.patch.yaml': `version: 1
id: addon.broken
name: Broken
scope: prod
targets:
  - file: GameData/Generated/Gameplay/Units.ndf
    operations:
      - op: modify
        selector:
          kind: object
          by: name
          value: Descriptor_Unit_Missing
        changes:
          FrontArmor: 9
`,
    });

    const failure = (await runValidate(
      builderPath,
      createSelection({ modFilters: ['addon'] }),
    ).catch((error: unknown) => error)) as YmbError;

    expect(failure).toBeInstanceOf(YmbError);
    expect(failure.context.patchConfigPath).toBe('addon/config/patch/broken/ymb.patch.yaml');
    expect(failure.context.operationLine).toBe(8);
    expect(failure.message).toContain('Written at  addon/config/patch/broken/ymb.patch.yaml:8');
    expect(failure.message).not.toContain('operation #');
  });

  test('discovery reports every broken config file, not just the first one it opens', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);
    await writeModFixture(builderPath, 'addon', {
      'config/ymb.mod.yaml': 'version: 1\nid: addon\nname: Addon\n',
      'config/patch/first/ymb.patch.yaml': 'version: 1\nid: addon.first\nname: First\n',
      'config/patch/second/ymb.patch.yaml': 'version: 1\nid: addon.second\nscope: prod\n',
    });

    const failure = await runValidate(
      builderPath,
      createSelection({ modFilters: ['addon'] }),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(YmbErrorGroup);
    const group = failure as YmbErrorGroup;
    expect(group.errors.length).toBe(2);
    expect(group.errors.every((error) => error.category === 'ConfigError')).toBe(true);
  });

  test('file operations report one cause per patch, not the consequences inside it', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);
    await writeModFixture(builderPath, 'addon', {
      'config/ymb.mod.yaml': 'version: 1\nid: addon\nname: Addon\n',
      // The `remove` only had something to find because the `copy` above it was
      // meant to create it, so reporting it too would name a consequence.
      'config/patch/first/ymb.patch.yaml': `version: 1
id: addon.first
name: First
scope: prod
files:
  - op: copy
    source:
      root: patch
      path: nowhere.txt
    destination: CommonData/Text/addon-copied.txt
  - op: remove
    target: CommonData/Text/addon-copied.txt
`,
      'config/patch/second/ymb.patch.yaml': `version: 1
id: addon.second
name: Second
scope: prod
files:
  - op: copy
    source:
      root: patch
      path: also-nowhere.txt
    destination: CommonData/Text/addon-second.txt
`,
    });

    const failure = await runValidate(
      builderPath,
      createSelection({ modFilters: ['addon'] }),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(YmbErrorGroup);
    const group = failure as YmbErrorGroup;
    expect(group.errors.map((error) => error.context.patchId)).toEqual([
      'addon.first',
      'addon.second',
    ]);
    expect(group.errors.every((error) => error.context.reason.includes('does not exist'))).toBe(
      true,
    );
  });

  test('the CLI prints all of them, and --json hands all of them to a caller', async () => {
    const { builderPath } = await createAbstractBuilderWorkspace(tempRoots);
    await writeModFixture(builderPath, 'addon', {
      'config/ymb.mod.yaml': 'version: 1\nid: addon\nname: Addon\n',
      'config/patch/first/ymb.patch.yaml': missingTargetPatch(
        'addon.first',
        'GameData/Generated/Gameplay/GoneA.ndf',
      ),
      'config/patch/second/ymb.patch.yaml': missingTargetPatch(
        'addon.second',
        'GameData/Generated/Gameplay/GoneB.ndf',
      ),
    });
    const originalLog = console.log;
    const originalError = console.error;
    const originalExitCode = process.exitCode;
    const errorLines: string[] = [];
    const logLines: string[] = [];
    const originalWrite = process.stdout.write;
    const stdout: string[] = [];

    console.log = (...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
    };
    console.error = (...args: unknown[]) => {
      errorLines.push(args.map(String).join(' '));
    };
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      process.exitCode = 0;
      await runCli(['bun', 'index.ts', 'validate', '--ymb-path', builderPath, '--mod', 'addon']);
      const report = errorLines.join('\n');
      expect(process.exitCode).toBe(1);
      expect(report).toContain('[x] 2 problems found');
      expect(report).toContain('1 of 2');
      expect(report).toContain('2 of 2');
      expect(report).toContain('GoneA.ndf');
      expect(report).toContain('GoneB.ndf');

      stdout.length = 0;
      process.exitCode = 0;
      await runCli([
        'bun',
        'index.ts',
        'validate',
        '--ymb-path',
        builderPath,
        '--mod',
        'addon',
        '--json',
      ]);
      const payload = JSON.parse(stdout.join('')) as {
        ok: boolean;
        errorCount: number;
        errors: Array<{ reason: string }>;
      };
      expect(payload.ok).toBe(false);
      expect(payload.errorCount).toBe(2);
      expect(payload.errors.map((error) => error.reason).join('\n')).toContain('GoneB.ndf');
    } finally {
      console.log = originalLog;
      console.error = originalError;
      process.stdout.write = originalWrite;
      process.exitCode = originalExitCode;
    }
  });
});
