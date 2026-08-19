import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createProgressSnapshot, getProgressModel } from '../src/cli/progress-model.ts';
import type { ProgressTimingStore, RecordedStage } from '../src/cli/progress-timings.ts';
import { createProgressDisplay, getCliTitleLines, runCli } from '../src/cli.ts';
import { runBuild, setCommandProgressReporter } from '../src/engine/commands.ts';
import { abbreviateDisplayPath } from '../src/path-utils.ts';
import { formatDetailLine } from '../src/report/detail.ts';
import {
  cleanupTempRoots,
  createAbstractBuilderWorkspace,
  createSelection,
} from './helpers/abstract-builder.ts';

const tempRoots: string[] = [];
const originalLog = console.log;
const originalError = console.error;
const originalExitCode = process.exitCode;
const originalStderrIsTTY = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');

beforeEach(() => {
  Object.defineProperty(process.stderr, 'isTTY', {
    configurable: true,
    value: false,
  });
});

afterEach(async () => {
  console.log = originalLog;
  console.error = originalError;
  process.exitCode = originalExitCode;
  if (originalStderrIsTTY) {
    Object.defineProperty(process.stderr, 'isTTY', originalStderrIsTTY);
  } else {
    Reflect.deleteProperty(process.stderr, 'isTTY');
  }
  await cleanupTempRoots(tempRoots);
});

async function createTempBuilder(): Promise<string> {
  return (await createAbstractBuilderWorkspace(tempRoots)).builderPath;
}

/** Stands in for the recorded timings of a previous run, or the lack of any. */
function createStubTimingStore(previous?: RecordedStage[]): ProgressTimingStore {
  return {
    previousRun: () => previous,
    useProjectRoot: () => undefined,
    useMeasuredVariant: () => undefined,
    save: () => undefined,
  };
}

/** `capture()` ends a frame; `tick()` fires the redraw timer without a real interval. */
function withFakeLiveTerminal(
  columns: number,
  body: (
    display: ReturnType<typeof createProgressDisplay>,
    tick: () => void,
    capture: () => void,
  ) => void,
  timingStore?: ProgressTimingStore,
): { frames: string[]; closing: string } {
  const originalTerm = process.env.TERM;
  const originalColumns = Object.getOwnPropertyDescriptor(process.stderr, 'columns');
  const originalWrite = process.stderr.write;
  const originalCursorTo = process.stderr.cursorTo;
  const originalClearLine = process.stderr.clearLine;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const writes: string[] = [];
  const frames: string[] = [];
  let intervalCallback: (() => void) | undefined;

  Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stderr, 'columns', { configurable: true, value: columns });
  process.env.TERM = 'xterm-256color';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  process.stderr.cursorTo = (() => true) as typeof process.stderr.cursorTo;
  process.stderr.clearLine = (() => true) as typeof process.stderr.clearLine;
  globalThis.setInterval = ((callback: Parameters<typeof setInterval>[0]) => {
    intervalCallback = callback as () => void;
    return { unref() {} } as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;

  try {
    const display = createProgressDisplay('sync', timingStore);
    writes.length = 0;
    body(
      display,
      () => intervalCallback?.(),
      () => {
        // Each redraw starts by moving the cursor back to the first row, so the
        // text after the last move is what the terminal ends up showing.
        frames.push(writes.join('').split('\u001b[3F').at(-1) ?? '');
        writes.length = 0;
      },
    );
    return { frames, closing: writes.join('') };
  } finally {
    if (originalTerm === undefined) {
      delete process.env.TERM;
    } else {
      process.env.TERM = originalTerm;
    }
    if (originalColumns) {
      Object.defineProperty(process.stderr, 'columns', originalColumns);
    }
    process.stderr.write = originalWrite;
    process.stderr.cursorTo = originalCursorTo;
    process.stderr.clearLine = originalClearLine;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
}

function expectCliTitle(logLines: string[]): number {
  const titleLines = getCliTitleLines();
  const capturedTitle = logLines.slice(0, titleLines.length);
  if (
    capturedTitle.length === titleLines.length &&
    capturedTitle.every((line, index) => line === titleLines[index])
  ) {
    return titleLines.length;
  }

  return 0;
}

describe('cli safety', () => {
  test('help output renders the CLI title for root and subcommand help', () => {
    const projectRoot = path.resolve('.');
    const titleLine = getCliTitleLines()[1] ?? '';

    const rootHelp = Bun.spawnSync({
      cmd: ['bun', 'run', './index.ts', '--help'],
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const buildHelp = Bun.spawnSync({
      cmd: ['bun', 'run', './index.ts', 'build', '--help'],
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const rootHelpOutput = Buffer.from(rootHelp.stdout).toString('utf8');
    const rootHelpTitle = Buffer.from(rootHelp.stderr).toString('utf8');
    const buildHelpOutput = Buffer.from(buildHelp.stdout).toString('utf8');
    const buildHelpTitle = Buffer.from(buildHelp.stderr).toString('utf8');

    expect(rootHelp.exitCode).toBe(0);
    expect(buildHelp.exitCode).toBe(0);
    expect(rootHelpTitle).toContain(titleLine);
    expect(buildHelpTitle).toContain(titleLine);
    expect(rootHelpOutput).toContain('Usage: ymb');
    expect(rootHelpOutput).toContain('New here? Do this:');
    expect(rootHelpOutput).toContain('  doctor');
    expect(rootHelpOutput).not.toContain('bun run ymb');
    expect(buildHelpOutput).toContain('Usage: ymb build');
    expect(buildHelpOutput).toContain('What it does:');
  });

  test('JSON mode keeps command-line parser failures machine-readable', () => {
    const projectRoot = path.resolve('.');
    const cases = [
      {
        command: 'find',
        args: ['find', '--limit', '0', '--json'],
        reason: '`--limit 0` is not a whole number above zero.',
      },
      {
        command: 'build',
        args: ['build', '--definitely-unknown', '--json'],
        reason: "unknown option '--definitely-unknown'",
      },
      {
        command: 'build',
        args: ['build', '--mod', '--json'],
        reason: '`--mod` needs a value, but received another option: `--json`.',
      },
    ];

    for (const testCase of cases) {
      const result = Bun.spawnSync({
        cmd: ['bun', 'run', './index.ts', ...testCase.args],
        cwd: projectRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stdout = Buffer.from(result.stdout).toString('utf8');
      const stderr = Buffer.from(result.stderr).toString('utf8');
      const payload = JSON.parse(stdout) as {
        command: string;
        ok: boolean;
        errors: Array<{ category: string; reason: string }>;
      };

      expect(result.exitCode).toBe(1);
      expect(stderr).toBe('');
      expect(payload.command).toBe(testCase.command);
      expect(payload.ok).toBeFalse();
      expect(payload.errors).toEqual([
        expect.objectContaining({ category: 'CommandError', reason: testCase.reason }),
      ]);
    }
  });

  test('human parser failures never leak a runtime stack trace', () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', './index.ts', 'find', '--limit', '0'],
      cwd: path.resolve('.'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = Buffer.from(result.stderr).toString('utf8');

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain('[x] Command stopped');
    expect(stderr).toContain('`--limit 0` is not a whole number above zero.');
    expect(stderr).not.toContain('at parsePositiveInteger');
    expect(stderr).not.toContain('Bun v');
  });

  test('sync requires --yes before touching the live mod root', async () => {
    const builderPath = await createTempBuilder();
    const errorLines: string[] = [];
    console.log = () => {};
    console.error = (...args: unknown[]) => {
      errorLines.push(args.map(String).join(' '));
    };
    process.exitCode = 0;

    await runCli(['bun', 'index.ts', 'sync', '--ymb-path', builderPath]);

    expect(process.exitCode).toBe(1);
    expect(errorLines.join('\n')).toContain('Command stopped');
    expect(errorLines.join('\n')).toContain(
      '  `sync` writes to the live mod root and needs explicit confirmation.',
    );
    expect(errorLines.join('\n')).toContain(
      '  Fix  Review the plan first, then re-run with `--yes`',
    );

    const liveFile = await Bun.file(
      path.join(path.dirname(builderPath), 'GameData', 'Generated', 'Gameplay', 'Units.ndf'),
    ).text();
    expect(liveFile).not.toContain('// YMB-START');
  });

  test('cleanup leaves nothing behind, not even the timings its own run would record', async () => {
    const builderPath = await createTempBuilder();
    console.log = () => {};
    console.error = () => {};
    process.exitCode = 0;

    // A build fills the work root and records how long it took...
    await runCli(['bun', 'index.ts', 'build', '--ymb-path', builderPath]);
    expect(
      await Bun.file(path.join(builderPath, '.ymb-build', 'progress-timings.json')).exists(),
    ).toBe(true);

    // ...and cleanup removes the folder, rather than reporting it removed and
    // then writing its own timings straight back into it.
    await runCli(['bun', 'index.ts', 'cleanup', '--ymb-path', builderPath]);

    expect(process.exitCode).toBe(0);
    expect(await readdir(builderPath)).not.toContain('.ymb-build');
  });

  test('cleanup --all requires --yes before removing recovery data', async () => {
    const builderPath = await createTempBuilder();
    const errorLines: string[] = [];
    console.log = () => {};
    console.error = (...args: unknown[]) => {
      errorLines.push(args.map(String).join(' '));
    };
    process.exitCode = 0;

    await runCli(['bun', 'index.ts', 'cleanup', '--ymb-path', builderPath, '--all']);

    expect(process.exitCode).toBe(1);
    expect(errorLines.join('\n')).toContain('Command stopped');
    expect(errorLines.join('\n')).toContain(
      '  `cleanup --all` removes recovery data and configured all-only temp artifacts.',
    );
  });

  test('sync runs with structured output after explicit confirmation', async () => {
    const builderPath = await createTempBuilder();
    const logLines: string[] = [];
    console.log = (...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
    };
    console.error = () => {};
    process.exitCode = 0;

    await runCli(['bun', 'index.ts', 'sync', '--ymb-path', builderPath, '--yes']);

    expect(process.exitCode).toBe(0);
    const contentOffset = expectCliTitle(logLines);
    expect(logLines[contentOffset]).toBe('[ok] Sync complete');
    expect(logLines.some((line) => line.includes('prod patches only'))).toBe(true);
    expect(logLines[contentOffset]).toContain('Sync complete');
    expect(logLines.some((line) => line.trimStart().startsWith('Live mod root '))).toBe(true);
    expect(logLines.some((line) => line.trimStart().startsWith('Applied '))).toBe(true);
    expect(logLines.some((line) => line.trimStart().startsWith('Took '))).toBe(true);
    expect(logLines.some((line) => line.trimStart().startsWith('Reused '))).toBe(true);
    // A file that went where it was asked to go is counted in the summary, not
    // listed line by line: the detail section is for what a reader has to act on.
    expect(logLines.some((line) => line.startsWith('Live file updates (0 of '))).toBe(true);
    expect(
      logLines.some((line) =>
        line.includes(formatDetailLine('patched', 'GameData/Generated/Gameplay/Units.ndf')),
      ),
    ).toBe(false);
    expect(logLines.some((line) => line.includes('Re-run with --verbose to see all'))).toBe(true);

    const liveFile = await Bun.file(
      path.join(path.dirname(builderPath), 'GameData', 'Generated', 'Gameplay', 'Units.ndf'),
    ).text();
    expect(liveFile).toContain('// YMB-START');
  });

  test('build supports --no-cache and reports cache bypass in the summary', async () => {
    const builderPath = await createTempBuilder();
    const logLines: string[] = [];
    console.log = (...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
    };
    console.error = () => {};
    process.exitCode = 0;

    await runCli([
      'bun',
      'index.ts',
      'build',
      '--ymb-path',
      builderPath,
      '--dry-run',
      '--no-cache',
    ]);

    expect(process.exitCode).toBe(0);
    const contentOffset = expectCliTitle(logLines);
    expect(logLines[contentOffset]).toBe('[ok] Build plan ready');
    expect(logLines.some((line) => line.includes('dry run, nothing written'))).toBe(true);
    expect(logLines.some((line) => line.includes('cache off'))).toBe(true);
    expect(logLines.some((line) => line.trimStart().startsWith('Preview '))).toBe(true);
    expect(logLines.some((line) => line.includes('cache bypassed'))).toBe(true);
  });

  test('progress display redraws immediately when the status message changes', () => {
    const originalTerm = process.env.TERM;
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
    const originalColumns = Object.getOwnPropertyDescriptor(process.stderr, 'columns');
    const originalWrite = process.stderr.write;
    const originalCursorTo = process.stderr.cursorTo;
    const originalClearLine = process.stderr.clearLine;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const writes: string[] = [];
    let intervalCallback: (() => void) | undefined;
    const fakeIntervalHandle = { unref() {} } as unknown as ReturnType<typeof setInterval>;

    Object.defineProperty(process.stderr, 'isTTY', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stderr, 'columns', {
      configurable: true,
      value: 240,
    });
    process.env.TERM = 'xterm-256color';
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    process.stderr.cursorTo = ((column: number) => {
      writes.push(`[cursorTo:${column}]`);
      return true;
    }) as typeof process.stderr.cursorTo;
    process.stderr.clearLine = ((dir: -1 | 0 | 1) => {
      writes.push(`[clearLine:${dir}]`);
      return true;
    }) as typeof process.stderr.clearLine;
    globalThis.setInterval = ((callback: Parameters<typeof setInterval>[0]) => {
      intervalCallback = callback as () => void;
      return fakeIntervalHandle;
    }) as typeof setInterval;
    globalThis.clearInterval = (() => {}) as typeof clearInterval;

    try {
      const display = createProgressDisplay('build');
      expect(display).toBeDefined();
      expect(writes.join('')).toContain('Scanning project');
      expect(writes.join('')).not.toContain('ETA ');
      expect(writes.join('')).toContain('Starting build');

      const writesBeforeUpdate = writes.length;
      display?.update({
        message: 'Running generation script tests',
        detail: '.../sample-pack/config/generate-mod-summary.test.ts',
        current: 1,
        total: 5,
      });
      expect(writes.join('')).toContain(
        'Generation script pipeline [tests] [1/5] .../sample-pack/config/generate-mod-summary.test.ts',
      );
      expect(writes.join('')).toContain('Generation script pipeline');

      display?.update({
        message: 'Running generation scripts',
        detail: '.../sample-pack/config/generate-mod-summary.ts',
        current: 2,
        total: 5,
      });

      expect(writes.length).toBeGreaterThan(writesBeforeUpdate);
      const renderedOutput = writes.join('');
      expect(renderedOutput).toContain('YMB build');
      expect(renderedOutput).toContain('Building output');
      expect(renderedOutput).toContain('[2/5]');
      expect(renderedOutput).toContain(
        'Generation script pipeline [run] [2/5] .../sample-pack/config/generate-mod-summary.ts',
      );
      expect(renderedOutput).toContain('Generation script pipeline');

      intervalCallback?.();
      expect(writes.join('')).toContain('Generation script pipeline');

      display?.stop('done');
      expect(writes.join('')).toContain('done in ');
    } finally {
      if (originalTerm === undefined) {
        delete process.env.TERM;
      } else {
        process.env.TERM = originalTerm;
      }
      if (originalIsTTY) {
        Object.defineProperty(process.stderr, 'isTTY', originalIsTTY);
      }
      if (originalColumns) {
        Object.defineProperty(process.stderr, 'columns', originalColumns);
      }
      process.stderr.write = originalWrite;
      process.stderr.cursorTo = originalCursorTo;
      process.stderr.clearLine = originalClearLine;
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  test('live progress animates and every row stays inside the terminal width', () => {
    const columns = 60;
    const { frames, closing } = withFakeLiveTerminal(columns, (display, tick, capture) => {
      display.update({
        message: 'Syncing live files',
        detail: 'GameData/Generated/Gameplay/Gfx/Infanterie/DepictionInfantry.ndf',
        current: 42,
        total: 89,
      });
      capture();
      tick();
      capture();
      display.stop('failed');
    });

    const rows = frames.map((frame) => frame.split('\n'));
    // A row that fills the width wraps, and the redraw counts rows to find the
    // top of the frame - one wrap corrupts every later frame.
    for (const row of rows.flat()) {
      expect(row.length).toBeLessThanOrEqual(columns - 1);
    }
    // The tail of a truncated row is the part worth reading.
    expect(rows[0]?.[2]).toContain('DepictionInfantry.ndf');
    expect(rows[0]?.[3]).toContain('next ');
    // Consecutive frames must differ even though the stage and counts did not.
    expect(rows[0]?.[2]).not.toBe(rows[1]?.[2]);
    expect(closing).toContain('stopped after ');
    // The error block printed underneath owns the one `[x]` a failure gets.
    expect(closing).not.toContain('[x]');
  });

  test('plain terminals get one line per finished phase instead of a block per event', () => {
    const originalWrite = process.stderr.write;
    const writes: string[] = [];

    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const display = createProgressDisplay('build');
      expect(writes.join('')).toBe('YMB build\n');

      // Many events inside one phase must stay silent; only the phase boundary
      // is worth a line on a terminal that cannot redraw.
      writes.length = 0;
      for (let index = 1; index <= 5; index += 1) {
        display?.update({
          message: 'Running generation scripts',
          detail: `.../generate-${index}.ts`,
          current: index,
          total: 5,
        });
      }
      expect(writes.join('')).toBe('');

      // Moving to the next phase closes the previous one with its position,
      // duration, and how much work it covered.
      display?.update({ message: 'Writing preview output files', current: 1, total: 3 });
      const phaseLine = writes.join('');
      expect(phaseLine).toContain('[2/3]');
      expect(phaseLine).toContain('Building output');
      expect(phaseLine).toContain('5 generation scripts');
      expect(phaseLine.trimEnd().split('\n')).toHaveLength(1);

      writes.length = 0;
      display?.stop('done');
      const closing = writes.join('');
      expect(closing).toContain('[3/3]');
      expect(closing).toContain('Writing preview');
      expect(closing).toContain('done in ');
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test('a run with nothing measured shows no eta, and a recorded one predicts', () => {
    const recorded = [
      { message: 'Preparing build plan', durationMs: 100, items: 0 },
      { message: 'Running generation scripts', durationMs: 9900, items: 5 },
    ];
    const uncalibrated = withFakeLiveTerminal(
      120,
      (display, _tick, capture) => {
        display.update({ message: 'Running generation scripts', current: 1, total: 5 });
        capture();
        display.stop('done');
      },
      createStubTimingStore(),
    );
    const calibrated = withFakeLiveTerminal(
      120,
      (display, _tick, capture) => {
        display.update({ message: 'Running generation scripts', current: 1, total: 5 });
        capture();
        display.stop('done');
      },
      createStubTimingStore(recorded),
    );

    // Nothing measured yet, so the header carries no estimate at all - not a
    // placeholder standing in for one - and only the closing line mentions it.
    const uncalibratedHeader = uncalibrated.frames[0]?.split('\n')[0] ?? '';
    // The header ends at the elapsed time: no estimate, and nothing standing in
    // for one.
    expect(uncalibratedHeader).toMatch(/^YMB sync {2}\[[=>.]+] +\d+% {2}[\d.]+m?s$/);
    expect(uncalibrated.closing).toContain('first run measured');
    // With a recording behind it the header commits to a remaining time, and
    // the note is gone because it is no longer a first run.
    expect(calibrated.frames[0]).toContain('eta ');
    expect(calibrated.closing).not.toContain('first run measured');
  });

  test('a failed run does not claim to have measured anything', () => {
    const { closing } = withFakeLiveTerminal(
      120,
      (display) => {
        display.update({ message: 'Running generation scripts', current: 1, total: 5 });
        display.stop('failed');
      },
      createStubTimingStore(),
    );

    expect(closing).toContain('stopped after ');
    expect(closing).not.toContain('first run measured');
  });

  test('a command that records nothing does not promise an eta next time', () => {
    // No store at all, which is how `cleanup` runs: it deletes the folder the
    // timings live in, so the note would promise an eta that never arrives.
    const { closing } = withFakeLiveTerminal(120, (display) => {
      display.update({ message: 'Removing YMB temp artifacts', current: 1, total: 5 });
      display.stop('done');
    });

    expect(closing).toContain('done in ');
    expect(closing).not.toContain('first run measured');
  });

  test('a failed run is not recorded as a measurement of the whole command', () => {
    const saves: RecordedStage[][] = [];
    const store: ProgressTimingStore = {
      previousRun: () => undefined,
      useProjectRoot: () => undefined,
      useMeasuredVariant: () => undefined,
      save: (stages) => {
        saves.push([...stages]);
      },
    };

    // A run that stopped partway measured a shorter command than the real one,
    // so keeping its stages would have the next run promise an eta it cannot meet.
    withFakeLiveTerminal(
      120,
      (display) => {
        display.update({ message: 'Running generation scripts', current: 1, total: 5 });
        display.stop('failed');
      },
      store,
    );
    expect(saves).toEqual([]);

    withFakeLiveTerminal(
      120,
      (display) => {
        display.update({ message: 'Running generation scripts', current: 5, total: 5 });
        display.stop('done');
      },
      store,
    );
    expect(saves.length).toBe(1);
  });

  test('plain terminals get elapsed time and an eta while a phase is still running', () => {
    const originalWrite = process.stderr.write;
    const originalNow = performance.now;
    const writes: string[] = [];
    let fakeNowMs = 0;

    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    performance.now = () => fakeNowMs;

    try {
      const display = createProgressDisplay(
        'build',
        createStubTimingStore([
          { message: 'Running generation scripts', durationMs: 40_000, items: 5 },
        ]),
      );
      display.update({ message: 'Running generation scripts', current: 1, total: 5 });
      writes.length = 0;

      // A terminal that cannot redraw only learns where the run is from this
      // line, so it has to carry the timings the live header would have shown.
      fakeNowMs = 20_000;
      display.update({ message: 'Running generation scripts', current: 2, total: 5 });
      const heartbeat = writes.join('');
      expect(heartbeat).toContain('still working on building output...');
      expect(heartbeat).toContain('20.00s elapsed');
      expect(heartbeat).toContain('eta ');
    } finally {
      process.stderr.write = originalWrite;
      performance.now = originalNow;
    }
  });

  test('a plain terminal with nothing measured reports elapsed time and no eta', () => {
    const originalWrite = process.stderr.write;
    const originalNow = performance.now;
    const writes: string[] = [];
    let fakeNowMs = 0;

    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    performance.now = () => fakeNowMs;

    try {
      const display = createProgressDisplay('build', createStubTimingStore());
      display.update({ message: 'Running generation scripts', current: 1, total: 5 });
      writes.length = 0;

      fakeNowMs = 20_000;
      display.update({ message: 'Running generation scripts', current: 2, total: 5 });
      const heartbeat = writes.join('');

      // Elapsed time is measured, so it is still worth saying. A remaining time
      // is not, so the line simply ends.
      expect(heartbeat).toContain('20.00s elapsed\n');
      expect(heartbeat).not.toContain('eta');
    } finally {
      process.stderr.write = originalWrite;
      performance.now = originalNow;
    }
  });

  test('sync progress remains monotonic while loading its manifest', () => {
    const model = getProgressModel('sync');
    const loading = createProgressSnapshot('sync', model, {
      message: 'Loading sync manifest',
    });
    const syncing = createProgressSnapshot('sync', model, {
      message: 'Syncing live files',
      current: 0,
      total: 5,
    });

    // Reading the manifest and checking tracked files both happen before the
    // build, so they belong to their own step rather than the write step.
    expect(loading.groupLabel).toBe('Checking game files');
    expect(syncing.groupLabel).toBe('Updating game files');
    expect(syncing.overallFraction).toBeGreaterThanOrEqual(loading.overallFraction);
  });

  test('checking a script output keeps the bar where the run already is', () => {
    const model = getProgressModel('build');
    const running = createProgressSnapshot('build', model, {
      message: 'Running generation scripts',
      current: 1,
      total: 2,
    });
    const checking = createProgressSnapshot('build', model, {
      message: 'Running generation output checks',
      current: 1,
      total: 2,
    });

    // An `after` test reports once the script has run. An unmapped message falls
    // back to the first group, which sent the bar back to step 1 of the build.
    expect(checking.groupLabel).toBe(running.groupLabel);
    expect(checking.overallFraction).toBeGreaterThanOrEqual(running.overallFraction);
  });

  test('abbreviates long progress paths', () => {
    expect(abbreviateDisplayPath('mods/sample-pack/config/generate-mod-summary.ts')).toBe(
      '.../sample-pack/config/generate-mod-summary.ts',
    );
    expect(abbreviateDisplayPath('GameData/Generated/Gameplay/Units.ndf')).toBe(
      '.../Generated/Gameplay/Units.ndf',
    );
    expect(abbreviateDisplayPath('CommonData/Text/output.ndf')).toBe('CommonData/Text/output.ndf');
  });

  test('build emits progress updates inside materialization phases', async () => {
    const builderPath = await createTempBuilder();
    const events: string[] = [];
    setCommandProgressReporter((event) => {
      events.push(
        `${event.message}|${event.current ?? ''}/${event.total ?? ''}|${event.detail ?? ''}`,
      );
    });

    try {
      await runBuild(builderPath, createSelection({ useCache: true, dryRun: true }));
    } finally {
      setCommandProgressReporter(undefined);
    }

    expect(events.some((event) => event.startsWith('Materializing patch outputs|1/'))).toBe(true);
    expect(events.some((event) => event.startsWith('Running generation scripts|1/'))).toBe(true);
    expect(events.some((event) => event.startsWith('Materializing replace outputs|/|'))).toBe(true);
  });

  test('script progress emits heartbeat updates while a script is running', async () => {
    const builderPath = await createTempBuilder();
    const events: string[] = [];
    const slowScriptPath = path.join(
      builderPath,
      'mods',
      'sample-pack',
      'config',
      'generate-mod-summary.ts',
    );
    await Bun.write(
      slowScriptPath,
      `export default function generateModSummary() {
  const waitUntil = Date.now() + 1200;
  while (Date.now() < waitUntil) {
    // block on purpose to prove the parent progress loop stays responsive
  }

  return {
    targetRelativePath: 'CommonData/Text/generated-by-mod.ndf',
    content: 'GeneratedModSummary is TGeneratedSummary\\n(\\n)\\n',
  };
}
`,
    );
    setCommandProgressReporter((event) => {
      events.push(`${event.message}|${event.detail ?? ''}`);
    });

    try {
      await runBuild(builderPath, createSelection({ useCache: true, dryRun: true }));
    } finally {
      setCommandProgressReporter(undefined);
    }

    expect(events.some((event) => event.includes('generate-mod-summary.ts (1s)'))).toBe(true);
    expect(
      events.some(
        (event) =>
          event.startsWith('Running generation scripts|') &&
          event.includes('.../sample-pack/config/generate-mod-summary.ts'),
      ),
    ).toBe(true);
  });

  test('script subprocess returns outputs reliably across repeated builds', async () => {
    const builderPath = await createTempBuilder();

    await expect(
      runBuild(builderPath, createSelection({ useCache: true, dryRun: true })),
    ).resolves.toBeDefined();

    await expect(
      runBuild(builderPath, createSelection({ useCache: true, dryRun: true })),
    ).resolves.toBeDefined();
  });

  test('init creates the recommended source mod scaffold', async () => {
    const builderPath = await createTempBuilder();
    const welcomeViewPath = path.join(
      builderPath,
      '..',
      'GameData',
      'UserInterface',
      'Use',
      'OutGame',
      'UISpecificOutGameWelcomeView.ndf',
    );
    const logLines: string[] = [];
    console.log = (...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
    };
    console.error = () => {};
    process.exitCode = 0;

    await mkdir(path.dirname(welcomeViewPath), { recursive: true });
    await Bun.write(
      welcomeViewPath,
      `UISpecificOutGameWelcomeDescriptor is TOutGameWelcomeDescriptor
(
    Components = []
)
`,
    );

    await runCli([
      'bun',
      'index.ts',
      'init',
      '--ymb-path',
      builderPath,
      '--id',
      'new_pack',
      '--name',
      'New Pack',
      '--description',
      'Example source mod',
    ]);

    expect(process.exitCode).toBe(0);
    const contentOffset = expectCliTitle(logLines);
    expect(logLines[contentOffset]).toBe('[ok] Starter source mod created');
    expect(logLines.some((line) => line.trimStart().startsWith('Took '))).toBe(true);
    expect(logLines.some((line) => line.trimStart().startsWith('Created '))).toBe(true);
    expect(logLines.some((line) => line.trimStart().startsWith('Source mods '))).toBe(true);
    expect(logLines.some((line) => line.trimStart().startsWith('Created'))).toBe(true);
    expect(logLines.some((line) => line.includes('Created source mod scaffold: New Pack'))).toBe(
      true,
    );

    const modConfig = await Bun.file(
      path.join(builderPath, 'mods', 'new_pack', 'config', 'ymb.mod.yaml'),
    ).text();
    expect(modConfig).toContain('id: new_pack');
    expect(modConfig).toContain('name: "New Pack"');
    expect(modConfig).toContain('dependsOn: []');
    expect(modConfig).toContain('priority: 0');
    expect(modConfig).toContain('allowWriteToModifiedFiles: false');
    expect(modConfig).toContain('welcomeTokenPrefix: "NEW_PACK"');
    expect(modConfig).toContain('welcomeTitleToken: "${welcomeTokenPrefix}_T"');
    expect(modConfig).toContain('welcomeInfoToken: "${welcomeTokenPrefix}_I"');
    expect(modConfig).toContain(
      'generatedInfoTarget: "GameData/Generated/Gameplay/${modId}/StarterInfo.ndf"',
    );
    expect(modConfig).toContain('- path: "generate-build-info.ts"');
    expect(modConfig).toContain('- "generate-build-info.test.ts"');

    const readme = await Bun.file(path.join(builderPath, 'mods', 'new_pack', 'README.md')).text();
    const demoScript = await Bun.file(
      path.join(builderPath, 'mods', 'new_pack', 'config', 'generate-build-info.ts'),
    ).text();
    const demoScriptTest = await Bun.file(
      path.join(builderPath, 'mods', 'new_pack', 'config', 'generate-build-info.test.ts'),
    ).text();
    const demoPatch = await Bun.file(
      path.join(
        builderPath,
        'mods',
        'new_pack',
        'config',
        'patch',
        'ui',
        'branding',
        'welcome-view',
        'ymb.patch.yaml',
      ),
    ).text();
    const localisation = await Bun.file(
      path.join(
        builderPath,
        'mods',
        'new_pack',
        'config',
        'replace',
        'GameData',
        'Localisation',
        '${modRootName}',
        'INTERFACE_OUTGAME.csv',
      ),
    ).text();

    expect(readme).toContain('generate-build-info.ts');
    expect(readme).toContain('generate-build-info.test.ts');
    expect(readme).toContain('ymb.mod.yaml');
    expect(readme).toContain('build --mod new_pack');
    expect(readme).toContain('StarterInfo.ndf');
    expect(demoScript).toContain('targetRelativePath');
    expect(demoScript).toContain('StarterBuildInfo_');
    expect(demoScriptTest).toContain("import generateBuildInfo from './generate-build-info.ts';");
    expect(demoScriptTest).toContain("status: 'passed'");
    expect(demoPatch).toContain(
      'GameData/UserInterface/Use/OutGame/UISpecificOutGameWelcomeView.ndf',
    );
    expect(demoPatch).toContain('TextToken = "${welcomeTitleToken}"');
    expect(localisation).toContain('"${welcomeTitleToken}";"${modName}"');
    expect(localisation).toContain(
      '"${welcomeInfoToken}";"${modDescription || \'Starter scaffold generated by YMB.\'}"',
    );

    await expect(
      runBuild(
        builderPath,
        createSelection({ modFilters: ['new_pack'], useCache: true, dryRun: true }),
      ),
    ).resolves.toBeDefined();
  });

  test('verbose mode prints the full detail list instead of compacting it', async () => {
    const builderPath = await createTempBuilder();
    const logLines: string[] = [];
    console.log = (...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
    };
    console.error = () => {};
    process.exitCode = 0;

    await runCli(['bun', 'index.ts', 'sync', '--ymb-path', builderPath, '--yes', '--verbose']);

    expect(process.exitCode).toBe(0);
    expect(logLines.some((line) => line.includes('all source mods, all patches'))).toBe(true);
    expect(logLines.some((line) => line.includes('rerun with --verbose for the full list.'))).toBe(
      false,
    );
  });

  test('the default detail list is what the run wants read, never a truncated one', async () => {
    const builderPath = await createTempBuilder();
    // An optional patch with nothing to apply: one line a reader has to see,
    // among a dozen that only say the run did as it was told.
    await Bun.write(
      path.join(builderPath, 'mods', 'sample-pack', 'config', 'patch', 'absent', 'ymb.patch.yaml'),
      `version: 1
id: sample.absent
name: Absent feature
scope: prod
optional: true
targets:
  - file: GameData/Generated/Gameplay/Missing.ndf
    operations:
      - op: remove
        selector: { kind: object, by: name, value: Descriptor_Unit_Gone }
`,
    );
    const logLines: string[] = [];
    console.log = (...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
    };
    console.error = () => {};
    process.exitCode = 0;

    await runCli(['bun', 'index.ts', 'validate', '--ymb-path', builderPath]);

    expect(process.exitCode).toBe(0);
    const contentOffset = expectCliTitle(logLines);
    expect(logLines[contentOffset]).toBe('[ok] Validation complete');

    const headingIndex = logLines.findIndex((line) => line.startsWith('Checks ('));
    expect(headingIndex).toBeGreaterThan(-1);
    const [shown, total] = (/\((\d+) of (\d+)\)/.exec(logLines[headingIndex] ?? '') ?? [])
      .slice(1)
      .map(Number);
    const listed = logLines.slice(headingIndex + 1).filter((line) => line.trim().length > 0);

    // Every line that survives the filter is shown, and the count says so.
    expect(total).toBeGreaterThan(shown ?? 0);
    expect(listed.slice(0, shown)).toEqual([
      `  ${formatDetailLine('skipped', 'sample.absent', 'no `GameData/Generated/Gameplay/Missing.ndf` in this install')}`,
    ]);
    expect(listed.at(-1)).toBe(`  Re-run with --verbose to see all ${total} lines.`);
    expect(listed.some((line) => line.trimStart().startsWith('ok  '))).toBe(false);
  });
});
