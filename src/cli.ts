import { Command, Option } from 'commander';
import packageDefinition from '../package.json' with { type: 'json' };
import { BUILDER_CONFIG } from './builder-config.ts';
import { createProgressDisplay } from './cli/progress-display.ts';
import {
  buildCommandHelpText,
  buildRootHelpText,
  type CliCommandName,
  describeScope,
  getCommandGuide,
} from './cli-guide.ts';
import { type CommandOutputLines, formatDurationMs } from './engine/command-output.ts';
import {
  runBuild,
  runCleanup,
  runDoctor,
  runExplain,
  runList,
  runRecover,
  runSync,
  runValidate,
  setCommandProgressReporter,
} from './engine.ts';
import { formatErrorLines, YmbError } from './errors.ts';
import type { InitCommandOptions } from './init.ts';
import { runInit } from './init.ts';
import type { Scope, SelectionInput } from './types.ts';

export { createProgressDisplay };

interface CommonOptions {
  ymbPath?: string;
  scope: Scope;
  mod: string[];
  patch: string[];
  cache: boolean;
  dryRun: boolean;
  verbose: boolean;
  yes: boolean;
}

interface CleanupOptions extends CommonOptions {
  all: boolean;
}

interface CommandSpec {
  name: Exclude<CliCommandName, 'cleanup' | 'init'>;
  description: string;
  handler: (
    builderPath: string | undefined,
    selection: SelectionInput,
  ) => Promise<string[] & { summary?: string[] | undefined }>;
  requiresYes?: boolean;
}

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  let hasRenderedCliTitle = false;
  const renderCliTitleOnce = () => {
    if (hasRenderedCliTitle) {
      return;
    }

    hasRenderedCliTitle = true;
    renderCliTitle();
  };

  program
    .name('ymb')
    .version(packageDefinition.version)
    .description('Preview, publish, recover, and inspect WARNO mods built from YMB source mods.')
    .configureOutput({
      writeOut: (output) => {
        renderCliTitleOnce();
        process.stdout.write(output);
      },
      writeErr: (output) => {
        renderCliTitleOnce();
        process.stderr.write(output);
      },
    })
    .addHelpText('after', buildRootHelpText())
    .showHelpAfterError();

  const commandSpecs = [
    {
      name: 'validate',
      description: getCommandGuide('validate').description,
      handler: runValidate,
    },
    { name: 'list', description: getCommandGuide('list').description, handler: runList },
    {
      name: 'explain',
      description: getCommandGuide('explain').description,
      handler: runExplain,
    },
    {
      name: 'build',
      description: getCommandGuide('build').description,
      handler: runBuild,
    },
    {
      name: 'sync',
      description: getCommandGuide('sync').description,
      handler: runSync,
      requiresYes: true,
    },
    {
      name: 'recover',
      description: getCommandGuide('recover').description,
      handler: runRecover,
      requiresYes: true,
    },
    {
      name: 'doctor',
      description: getCommandGuide('doctor').description,
      handler: runDoctor,
    },
  ] satisfies CommandSpec[];

  for (const spec of commandSpecs) {
    const command = program
      .command(spec.name)
      .description(spec.description)
      .addHelpText('after', buildCommandHelpText(spec.name));
    addSelectionOptions(command);
    if (spec.name === 'validate' || spec.name === 'build' || spec.name === 'sync') {
      addCacheOption(command);
    }
    if (spec.name === 'build' || spec.name === 'sync' || spec.name === 'recover') {
      addDryRunOption(command);
    }
    if (spec.requiresYes) {
      addConfirmationOption(command);
    }
    command.option('--verbose', 'Print more diagnostic information');
    command.action(async (options: CommonOptions) => {
      let progressDisplay: ReturnType<typeof createProgressDisplay> | undefined;
      renderCliTitleOnce();
      try {
        const selection = toSelection(options);
        ensureCommandConfirmation(spec, selection);
        progressDisplay = createProgressDisplay(spec.name);
        setCommandProgressReporter((event) => {
          progressDisplay?.update(event);
        });
        const lines = await spec.handler(options.ymbPath, selection);
        progressDisplay?.stop('done');
        for (const line of formatCommandOutput(spec.name, selection, lines)) {
          console.log(line);
        }
      } catch (error) {
        progressDisplay?.stop('failed');
        renderError(error);
        process.exitCode = 1;
      } finally {
        setCommandProgressReporter(undefined);
      }
    });
  }

  const cleanupCommand = program
    .command('cleanup')
    .description(getCommandGuide('cleanup').description)
    .addHelpText('after', buildCommandHelpText('cleanup'));
  addSelectionOptions(cleanupCommand);
  addDryRunOption(cleanupCommand);
  addConfirmationOption(cleanupCommand);
  cleanupCommand.option('--verbose', 'Print more diagnostic information');
  cleanupCommand.option(
    '--all',
    `Remove all ${BUILDER_CONFIG.name} temp artifacts, including \`${BUILDER_CONFIG.stateDirectoryName}\` recovery data and configured all-only temp files`,
  );
  cleanupCommand.action(async (options: CleanupOptions) => {
    let progressDisplay: ReturnType<typeof createProgressDisplay> | undefined;
    renderCliTitleOnce();
    try {
      const selection = toSelection(options);
      ensureCleanupConfirmation(selection, options.all ?? false);
      progressDisplay = createProgressDisplay('cleanup');
      setCommandProgressReporter((event) => {
        progressDisplay?.update(event);
      });
      const lines = await runCleanup(options.ymbPath, selection, options.all ?? false);
      progressDisplay?.stop('done');
      for (const line of formatCommandOutput('cleanup', selection, lines)) {
        console.log(line);
      }
    } catch (error) {
      progressDisplay?.stop('failed');
      renderError(error);
      process.exitCode = 1;
    } finally {
      setCommandProgressReporter(undefined);
    }
  });

  program
    .command('init')
    .description(getCommandGuide('init').description)
    .addHelpText('after', buildCommandHelpText('init'))
    .option('--ymb-path <path>', `Path to the ${BUILDER_CONFIG.name} builder directory`)
    .option('--id <id>', 'Stable source mod id')
    .option('--name <name>', 'Display name')
    .option('--description <text>', 'Optional description')
    .action(async (options: InitCommandOptions & { ymbPath?: string }) => {
      const startedAt = performance.now();
      renderCliTitleOnce();
      try {
        const lines = await runInit(options.ymbPath, options);
        const outputLines = formatInitOutput(lines, performance.now() - startedAt);
        for (const line of outputLines) {
          console.log(line);
        }
      } catch (error) {
        renderError(error);
        process.exitCode = 1;
      }
    });

  await program.parseAsync(argv);
}

export function getCliTitleLines(): string[] {
  return [
    '',
    'Y   Y   M   M   BBBB',
    ' Y Y    MM MM   B   B',
    '  Y     M M M   BBBB',
    '  Y     M   M   B   B',
    '  Y     M   M   BBBB',
    '',
  ];
}

function renderCliTitle(): void {
  if (process.stderr.isTTY) {
    for (const line of getCliTitleLines()) {
      process.stderr.write(`${line}\n`);
    }
    return;
  }

  for (const line of getCliTitleLines()) {
    console.log(line);
  }
}

function addSelectionOptions(command: Command): void {
  command
    .option('--ymb-path <path>', `Path to the ${BUILDER_CONFIG.name} builder directory`)
    .addOption(
      new Option('--scope <scope>', 'Patch scope to include')
        .choices(['prod', 'dev'])
        .default('prod'),
    )
    .option(
      '--mod <id-or-name>',
      'Exact mod id or exact mod name to include',
      collectRepeatable,
      [],
    )
    .option('--patch <id>', 'Exact patch id to include', collectRepeatable, []);
}

function addCacheOption(command: Command): void {
  command.option('--no-cache', 'Bypass patch and script-test caches');
}

function addDryRunOption(command: Command): void {
  command.option(
    '--dry-run',
    'Skip normal preview/live/recovery writes (trusted scripts and caches may still write)',
  );
}

function addConfirmationOption(command: Command): void {
  command.option('--yes', 'Confirm live-file or destructive state changes');
}

function toSelection(options: CommonOptions): SelectionInput {
  return {
    scope: options.scope,
    modFilters: options.mod ?? [],
    patchFilters: options.patch ?? [],
    useCache: options.cache ?? true,
    dryRun: options.dryRun ?? false,
    verbose: options.verbose ?? false,
    yes: options.yes ?? false,
  };
}

function collectRepeatable(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function ensureCommandConfirmation(spec: CommandSpec, selection: SelectionInput): void {
  if (!spec.requiresYes || selection.dryRun || selection.yes) {
    return;
  }

  throw new YmbError('CommandError', {
    absolutePath: spec.name,
    reason: `\`${spec.name}\` writes to the live mod root and needs explicit confirmation.`,
    suggestion:
      'Review the plan first, then re-run with `--yes`, or use `--dry-run` to inspect it without writing.',
  });
}

function ensureCleanupConfirmation(selection: SelectionInput, includeRecovery: boolean): void {
  if (!includeRecovery || selection.dryRun || selection.yes) {
    return;
  }

  throw new YmbError('CommandError', {
    absolutePath: 'cleanup',
    reason: `\`cleanup --all\` removes recovery data and configured all-only temp artifacts.`,
    suggestion:
      'Review the cleanup plan first, then re-run with `--yes`, or omit `--all` to keep recovery data.',
  });
}

function formatCommandOutput(
  commandName: Exclude<CliCommandName, 'init'>,
  selection: SelectionInput,
  lines: CommandOutputLines,
): string[] {
  const outputLines = [describeCommandResultTitle(commandName, selection)];
  outputLines.push(`- scope: ${describeScope(selection.scope)}`);
  outputLines.push(`- mode: ${describeCommandExecutionMode(commandName, selection)}`);
  if (shouldShowCacheLine(commandName)) {
    outputLines.push(`- patch cache: ${selection.useCache === false ? 'off' : 'on'}`);
  }
  const filtersLine = formatFiltersLine(selection);
  outputLines.push(`- selection: ${filtersLine}`);
  const summaryLines = lines.summary ?? [];
  outputLines.push(...summaryLines.map((line) => `- ${line}`));
  const metadata = lines.meta;
  for (const location of metadata?.locations ?? []) {
    outputLines.push(`- look here: ${location.label} -> ${location.path}`);
  }
  for (const nextStep of metadata?.nextSteps ?? []) {
    outputLines.push(`- next: ${nextStep}`);
  }

  const detailLines = formatDetailLines(commandName, selection, lines);
  if (detailLines.length > 0) {
    outputLines.push(`${metadata?.detailHeading ?? defaultDetailHeading(commandName)}:`);
    outputLines.push(...detailLines.map((line) => `- ${line}`));
  }

  return outputLines;
}

function describeCommandExecutionMode(
  commandName: Exclude<CliCommandName, 'init'>,
  selection: SelectionInput,
): string {
  if (selection.dryRun) {
    return 'dry run';
  }
  if (commandName === 'build') {
    return 'preview write';
  }
  if (commandName === 'sync') {
    return 'live write';
  }
  if (commandName === 'recover') {
    return 'recovery write';
  }
  return 'inspection';
}

function formatInitOutput(lines: string[], durationMs: number): string[] {
  return [
    'Starter source mod created',
    `- timing: total ${formatDurationMs(durationMs)}`,
    `- created: ${lines.length} item`,
    `- look here: source mods -> ${BUILDER_CONFIG.rootDirectoryName}/${BUILDER_CONFIG.modsDirectoryName}`,
    '- next: run `validate --mod <id>` on the new source mod',
    '- next: run `build --mod <id>` to inspect the preview',
    'created files:',
    ...lines.map((line) => `- ${line}`),
  ];
}

function formatFiltersLine(selection: SelectionInput): string {
  const modFilters =
    selection.modFilters.length > 0 ? selection.modFilters.join(', ') : 'all source mods';
  const patchFilters =
    selection.patchFilters.length > 0 ? selection.patchFilters.join(', ') : 'all patches';
  return `${modFilters} | ${patchFilters}`;
}

function formatDetailLines(
  commandName: Exclude<CliCommandName, 'init'>,
  selection: SelectionInput,
  lines: string[],
): string[] {
  if (lines.length === 0) {
    return ['No details.'];
  }

  if (selection.verbose || shouldShowAllDetails(commandName, lines.length)) {
    return lines;
  }

  const visibleLines = lines.slice(0, 6);
  return [
    ...visibleLines,
    `... ${lines.length - visibleLines.length} more. Re-run with --verbose to see everything.`,
  ];
}

function shouldShowAllDetails(
  commandName: Exclude<CliCommandName, 'init'>,
  lineCount: number,
): boolean {
  return (
    commandName === 'list' ||
    commandName === 'explain' ||
    commandName === 'doctor' ||
    lineCount <= 4
  );
}

function shouldShowCacheLine(commandName: Exclude<CliCommandName, 'init'>): boolean {
  return commandName === 'validate' || commandName === 'build' || commandName === 'sync';
}

function describeCommandResultTitle(
  commandName: Exclude<CliCommandName, 'init'>,
  selection: SelectionInput,
): string {
  switch (commandName) {
    case 'validate':
      return 'Validation complete';
    case 'list':
      return 'Source mod list ready';
    case 'explain':
      return 'Selection explanation ready';
    case 'build':
      return selection.dryRun ? 'Build plan ready' : 'Preview ready';
    case 'sync':
      return selection.dryRun ? 'Sync plan ready' : 'Sync complete';
    case 'recover':
      return selection.dryRun ? 'Recovery plan ready' : 'Recovery complete';
    case 'doctor':
      return 'Builder context ready';
    case 'cleanup':
      return selection.dryRun ? 'Cleanup plan ready' : 'Cleanup complete';
  }
}

function defaultDetailHeading(commandName: Exclude<CliCommandName, 'init'>): string {
  switch (commandName) {
    case 'build':
    case 'sync':
    case 'recover':
    case 'cleanup':
      return 'changes';
    case 'doctor':
      return 'paths';
    case 'list':
      return 'discovered items';
    case 'explain':
      return 'selection reasons';
    case 'validate':
      return 'checks';
  }
}

function renderError(error: unknown): void {
  if (error instanceof YmbError) {
    for (const line of formatErrorLines(error.category, error.context)) {
      console.error(line);
    }
    return;
  }

  if (error instanceof Error) {
    console.error('Unexpected error');
    console.error(`- problem: ${error.message}`);
    console.error(
      '- next: Re-run the command and keep the terminal output if this needs investigation.',
    );
    return;
  }

  console.error('Unexpected error');
  console.error(`- problem: ${String(error)}`);
  console.error(
    '- next: Re-run the command and keep the terminal output if this needs investigation.',
  );
}
