import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createProgressSnapshot, getProgressModel } from '../src/cli/progress-model.ts';
import { createProgressDisplay, getCliTitleLines, runCli } from '../src/cli.ts';
import { abbreviateProgressPath, reportProgress } from '../src/engine/progress.ts';
import { runBuild, setCommandProgressReporter } from '../src/engine.ts';
import { cleanupTempRoots, createAbstractBuilderWorkspace } from './helpers/abstract-builder.ts';

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
    const buildHelpOutput = Buffer.from(buildHelp.stdout).toString('utf8');

    expect(rootHelp.exitCode).toBe(0);
    expect(buildHelp.exitCode).toBe(0);
    expect(rootHelpOutput).toContain(titleLine);
    expect(buildHelpOutput).toContain(titleLine);
    expect(rootHelpOutput).toContain('Usage: ymb');
    expect(rootHelpOutput).toContain('Recommended Flow:');
    expect(rootHelpOutput).toContain('  doctor');
    expect(rootHelpOutput).not.toContain('bun run ymb');
    expect(buildHelpOutput).toContain('Usage: ymb build');
    expect(buildHelpOutput).toContain('What It Does:');
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
    expect(errorLines.join('\n')).toContain('Command blocked');
    expect(errorLines.join('\n')).toContain(
      '- problem: `sync` writes to the live mod root and needs explicit confirmation.',
    );
    expect(errorLines.join('\n')).toContain(
      '- next: Review the plan first, then re-run with `--yes`',
    );

    const liveFile = await Bun.file(
      path.join(path.dirname(builderPath), 'GameData', 'Generated', 'Gameplay', 'Units.ndf'),
    ).text();
    expect(liveFile).not.toContain('// YMB-START');
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
    expect(errorLines.join('\n')).toContain('Command blocked');
    expect(errorLines.join('\n')).toContain(
      '- problem: `cleanup --all` removes recovery data and configured all-only temp artifacts.',
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
    expect(logLines[contentOffset]).toBe('Sync complete');
    expect(logLines).toContain('- scope: prod only');
    expect(logLines).toContain('- mode: live write');
    expect(logLines.some((line) => line.startsWith('- look here: live mod root -> '))).toBe(true);
    expect(logLines.some((line) => line.startsWith('- sync: '))).toBe(true);
    expect(logLines.some((line) => line.startsWith('- timing: '))).toBe(true);
    expect(logLines.some((line) => line.startsWith('- patch cache: '))).toBe(true);
    expect(logLines).toContain('live file updates:');
    expect(
      logLines.some((line) => line.includes('- patch -> GameData/Generated/Gameplay/Units.ndf')),
    ).toBe(true);

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
    expect(logLines[contentOffset]).toBe('Build plan ready');
    expect(logLines).toContain('- mode: dry run');
    expect(logLines).toContain('- patch cache: off');
    expect(logLines.some((line) => line.startsWith('- look here: preview -> '))).toBe(true);
    expect(logLines.some((line) => line.includes('- patch cache: bypassed'))).toBe(true);
  });

  test('progress display redraws immediately when the status message changes', () => {
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
      expect(writes.join('')).toContain('NOW  World Scan :: Starting build');
      expect(writes.join('')).not.toContain('ETA ');
      expect(writes.join('')).toContain('NEXT Resolving builder context');

      const writesBeforeUpdate = writes.length;
      display?.update({
        message: 'Running generation script tests',
        detail: '.../sample-pack/config/generate-mod-summary.test.ts',
        current: 1,
        total: 5,
      });
      expect(writes.join('')).toContain(
        'NOW  Mod Fabrication :: Generation script pipeline [tests] [1/5] .../sample-pack/config/generate-mod-summary.test.ts',
      );
      expect(writes.join('')).toContain('NEXT Materializing replace outputs');

      display?.update({
        message: 'Running generation scripts',
        detail: '.../sample-pack/config/generate-mod-summary.ts',
        current: 2,
        total: 5,
      });

      expect(writes.length).toBeGreaterThan(writesBeforeUpdate);
      const renderedOutput = writes.join('');
      expect(renderedOutput).toContain('BUILD');
      expect(renderedOutput).toContain('Mod Fabrication');
      expect(renderedOutput).toContain('[2/5]');
      expect(renderedOutput).toContain(
        'NOW  Mod Fabrication :: Generation script pipeline [run] [2/5] .../sample-pack/config/generate-mod-summary.ts',
      );
      expect(renderedOutput).toContain('NEXT Materializing replace outputs');

      intervalCallback?.();
      expect(writes.join('')).toContain('NEXT Materializing replace outputs');

      display?.stop('done');
      expect(writes.join('')).toContain('[ok] build | finished in ');
    } finally {
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

  test('progress reporter keeps detail updates for the same phase', () => {
    const events: string[] = [];
    setCommandProgressReporter((event) => {
      events.push(`${event.message}|${event.detail ?? ''}`);
    });

    try {
      reportProgress('Materializing patch outputs', '1/3');
      reportProgress('Materializing patch outputs', '2/3');
      reportProgress('Materializing patch outputs', '2/3');
    } finally {
      setCommandProgressReporter(undefined);
    }

    expect(events).toEqual(['Materializing patch outputs|1/3', 'Materializing patch outputs|2/3']);
  });

  test('progress reporter keeps count updates for the same phase', () => {
    const events: string[] = [];
    setCommandProgressReporter((event) => {
      events.push(`${event.message}|${event.current ?? ''}/${event.total ?? ''}`);
    });

    try {
      reportProgress('Syncing live files', 'Units.ndf', { current: 1, total: 3 });
      reportProgress('Syncing live files', 'Units.ndf', { current: 2, total: 3 });
      reportProgress('Syncing live files', 'Units.ndf', { current: 2, total: 3 });
    } finally {
      setCommandProgressReporter(undefined);
    }

    expect(events).toEqual(['Syncing live files|1/3', 'Syncing live files|2/3']);
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

    expect(loading.groupLabel).toBe('Live Sync');
    expect(syncing.overallFraction).toBeGreaterThanOrEqual(loading.overallFraction);
  });

  test('abbreviates long progress paths', () => {
    expect(abbreviateProgressPath('mods/sample-pack/config/generate-mod-summary.ts')).toBe(
      '.../sample-pack/config/generate-mod-summary.ts',
    );
    expect(abbreviateProgressPath('GameData/Generated/Gameplay/Units.ndf')).toBe(
      '.../Generated/Gameplay/Units.ndf',
    );
    expect(abbreviateProgressPath('CommonData/Text/output.ndf')).toBe('CommonData/Text/output.ndf');
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
      await runBuild(builderPath, {
        scope: 'prod',
        modFilters: [],
        patchFilters: [],
        useCache: true,
        dryRun: true,
        verbose: false,
        yes: false,
      });
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
      await runBuild(builderPath, {
        scope: 'prod',
        modFilters: [],
        patchFilters: [],
        useCache: true,
        dryRun: true,
        verbose: false,
        yes: false,
      });
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
      runBuild(builderPath, {
        scope: 'prod',
        modFilters: [],
        patchFilters: [],
        useCache: true,
        dryRun: true,
        verbose: false,
        yes: false,
      }),
    ).resolves.toBeDefined();

    await expect(
      runBuild(builderPath, {
        scope: 'prod',
        modFilters: [],
        patchFilters: [],
        useCache: true,
        dryRun: true,
        verbose: false,
        yes: false,
      }),
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
    expect(logLines[contentOffset]).toBe('Starter source mod created');
    expect(logLines.some((line) => line.startsWith('- timing: total '))).toBe(true);
    expect(logLines.some((line) => line.startsWith('- created: '))).toBe(true);
    expect(logLines.some((line) => line.startsWith('- look here: source mods -> '))).toBe(true);
    expect(logLines).toContain('created files:');
    expect(logLines.some((line) => line.includes('- Created source mod scaffold: New Pack'))).toBe(
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
      runBuild(builderPath, {
        scope: 'prod',
        modFilters: ['new_pack'],
        patchFilters: [],
        useCache: true,
        dryRun: true,
        verbose: false,
        yes: false,
      }),
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
    expect(logLines).toContain('- selection: all source mods | all patches');
    expect(logLines.some((line) => line.includes('rerun with --verbose for the full list.'))).toBe(
      false,
    );
  });

  test('default validate output compacts long detail lists', async () => {
    const builderPath = await createTempBuilder();
    const logLines: string[] = [];
    console.log = (...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
    };
    console.error = () => {};
    process.exitCode = 0;

    await runCli(['bun', 'index.ts', 'validate', '--ymb-path', builderPath]);

    expect(process.exitCode).toBe(0);
    const contentOffset = expectCliTitle(logLines);
    expect(logLines[contentOffset]).toBe('Validation complete');
    expect(logLines).toContain('checks:');
    expect(logLines.some((line) => line.includes('Re-run with --verbose to see everything.'))).toBe(
      true,
    );
  });
});
