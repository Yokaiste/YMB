import { Command, CommanderError, Option } from 'commander';
import packageDefinition from '../package.json' with { type: 'json' };
import {
  buildJsonError,
  buildJsonInitResult,
  buildJsonResult,
  printJson,
} from './cli/json-output.ts';
import { createProgressDisplay } from './cli/progress-display.ts';
import {
  commandRecordsProgressTimings,
  createProgressTimingStore,
} from './cli/progress-timings.ts';
import {
  buildCommandHelpText,
  buildRootHelpText,
  CLI_COMMAND_NAMES,
  type CliCommandName,
  describeScope,
  getCommandGuide,
} from './cli-guide.ts';
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
  setCommandProjectRootReporter,
  setCommandRunVariantReporter,
} from './engine/commands.ts';
import { runFind } from './engine/find.ts';
import { formatErrorGroupLines, formatErrorLines, YmbError, YmbErrorGroup } from './errors.ts';
import type { InitCommandOptions, InitResult } from './init.ts';
import { runInit } from './init.ts';
import { isRoutineDetailLine } from './report/detail.ts';
import { countFact, type Fact, formatFactLines, timingFact } from './report/facts.ts';
import type { CommandOutputLines } from './report/output.ts';
import { capitalize } from './report/text.ts';
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
  json: boolean;
  resetChanged: boolean;
  requireAll: boolean;
}

interface CleanupOptions extends CommonOptions {
  all: boolean;
}

interface FindCommandOptions {
  name?: string | undefined;
  type?: string | undefined;
  field?: string | undefined;
  file: string[];
  limit: number;
}

/** Every command except `init`, which reports its own result shape. */
type ReportedCommandName = Exclude<CliCommandName, 'init'>;

interface CommandSpec {
  name: Exclude<ReportedCommandName, 'cleanup' | 'find'>;
  description: string;
  handler: (
    builderPath: string | undefined,
    selection: SelectionInput,
  ) => Promise<CommandOutputLines>;
  requiresYes?: boolean;
}

export async function runCli(argv: string[]): Promise<void> {
  const asJson = argv.includes('--json');
  const commandName = resolveCommandName(argv);
  try {
    await createCliProgram(asJson).parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) {
      return;
    }
    if (error instanceof CommanderError && !asJson) {
      // Commander already printed its concise error and command help.
      process.exitCode = error.exitCode;
      return;
    }

    renderError(toCommandError(error, commandName), asJson, commandName);
    process.exitCode = 1;
  }
}

/**
 * Builds the whole command tree without running it, so the shape of the CLI - every
 * command and the flags it offers - is inspectable instead of only observable by
 * invoking each command for real.
 */
export function createCliProgram(suppressParseErrors = false): Command {
  // Set this before adding subcommands so they inherit the override too.
  // Otherwise a subcommand parse failure calls process.exit before `runCli`
  // can turn it into a structured YMB result.
  const program = new Command().exitOverride();
  let hasRenderedCliTitle = false;
  const renderCliTitleOnce = () => {
    if (hasRenderedCliTitle) {
      return;
    }

    hasRenderedCliTitle = true;
    renderCliTitle();
  };

  /**
   * The tail every reported command shares: the two output flags, the banner
   * suppressed under `--json`, and the progress/error reporting wrapper.
   */
  const finishReportedCommand = <TOptions extends CommonOptions>(
    command: Command,
    name: ReportedCommandName,
    confirm: (options: TOptions, selection: SelectionInput) => void,
    run: (options: TOptions, selection: SelectionInput) => Promise<CommandOutputLines>,
  ): void => {
    command.option('--verbose', 'Show every result line instead of the first few');
    addJsonOption(command);
    command.action(async (options: TOptions) => {
      if (!options.json) {
        renderCliTitleOnce();
      }
      await runReportedCommand(
        name,
        options,
        (selection) => confirm(options, selection),
        (selection) => run(options, selection),
      );
    });
  };

  program
    .name('ymb')
    .version(packageDefinition.version)
    .description('Build WARNO mods from source, preview the result, then install it safely.')
    .configureOutput({
      writeOut: (output) => {
        renderCliTitleOnce();
        process.stdout.write(output);
      },
      writeErr: (output) => {
        if (suppressParseErrors) {
          return;
        }
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
      addRequireAllOption(command);
    }
    if (spec.name === 'build' || spec.name === 'sync' || spec.name === 'recover') {
      addDryRunOption(command);
    }
    if (spec.name === 'sync' || spec.name === 'recover') {
      addResetChangedOption(command);
    }
    if (spec.requiresYes) {
      addConfirmationOption(command);
    }
    finishReportedCommand<CommonOptions>(
      command,
      spec.name,
      (_options, selection) => ensureCommandConfirmation(spec, selection),
      (options, selection) => spec.handler(options.ymbPath, selection),
    );
  }

  const cleanupCommand = program
    .command('cleanup')
    .description(getCommandGuide('cleanup').description)
    .addHelpText('after', buildCommandHelpText('cleanup'));
  addSelectionOptions(cleanupCommand);
  addDryRunOption(cleanupCommand);
  addConfirmationOption(cleanupCommand);
  cleanupCommand.option(
    '--all',
    'Also delete the data needed to undo a sync. Only use this when you are done with the mod',
  );
  finishReportedCommand<CleanupOptions>(
    cleanupCommand,
    'cleanup',
    (options, selection) => ensureCleanupConfirmation(selection, options.all ?? false),
    (options, selection) => runCleanup(options.ymbPath, selection, options.all ?? false),
  );

  const findCommand = program
    .command('find')
    .description(getCommandGuide('find').description)
    .addHelpText('after', buildCommandHelpText('find'));
  addSelectionOptions(findCommand);
  findCommand
    .option(
      '--name <text>',
      'Match block names containing this text',
      createOptionValueParser('--name'),
    )
    .option(
      '--type <text>',
      'Match block types containing this text',
      createOptionValueParser('--type'),
    )
    .option(
      '--field <Name=Value>',
      'Match blocks whose field contains this value',
      createOptionValueParser('--field'),
    )
    .option(
      '--file <path>',
      'Search this game file instead of the ones your patches target. Repeat for several',
      createRepeatableCollector('--file'),
      [],
    )
    .addOption(
      new Option('--limit <count>', 'Stop listing after this many matches')
        .default(50)
        .argParser(parsePositiveInteger),
    );
  finishReportedCommand<CommonOptions & FindCommandOptions>(
    findCommand,
    'find',
    () => undefined,
    (options, selection) =>
      runFind(options.ymbPath, selection, {
        files: options.file ?? [],
        name: options.name,
        type: options.type,
        field: options.field,
        limit: options.limit,
      }),
  );

  const initCommand = program
    .command('init')
    .description(getCommandGuide('init').description)
    .addHelpText('after', buildCommandHelpText('init'))
    .option(
      '--ymb-path <path>',
      'Use a YMB folder other than the current one',
      createOptionValueParser('--ymb-path'),
    )
    .option('--id <id>', 'Short permanent id, for example my_pack', createOptionValueParser('--id'))
    .option('--name <name>', 'Readable name shown to players', createOptionValueParser('--name'))
    .option(
      '--description <text>',
      'One line describing the mod',
      createOptionValueParser('--description'),
    );
  addJsonOption(initCommand);
  initCommand.action(async (options: InitCommandOptions & { ymbPath?: string; json?: boolean }) => {
    const startedAt = performance.now();
    if (!options.json) {
      renderCliTitleOnce();
    }
    try {
      const created = await runInit(options.ymbPath, options);
      if (options.json) {
        printJson(buildJsonInitResult(created));
        return;
      }
      for (const line of formatInitOutput(created, performance.now() - startedAt)) {
        console.log(line);
      }
    } catch (error) {
      renderError(error, options.json ?? false, 'init');
      process.exitCode = 1;
    }
  });

  return program;
}

function resolveCommandName(argv: string[]): string {
  const commandArguments = argv.slice(2);
  return (
    commandArguments.find((argument) => CLI_COMMAND_NAMES.includes(argument as CliCommandName)) ??
    commandArguments.find((argument) => !argument.startsWith('-')) ??
    'ymb'
  );
}

function toCommandError(error: unknown, commandName: string): unknown {
  if (!(error instanceof CommanderError)) {
    return error;
  }

  return new YmbError('CommandError', {
    absolutePath: commandName,
    reason: error.message.replace(/^error:\s*/i, ''),
    suggestion: `Run \`${commandName} --help\`, correct the command, and try again.`,
  });
}

async function runReportedCommand(
  commandName: ReportedCommandName,
  options: CommonOptions,
  confirm: (selection: SelectionInput) => void,
  run: (selection: SelectionInput) => Promise<CommandOutputLines>,
): Promise<void> {
  const asJson = options.json ?? false;
  let progressDisplay: ReturnType<typeof createProgressDisplay> | undefined;
  try {
    const selection = toSelection(options);
    confirm(selection);
    // A live progress animation is noise to a machine caller, and its redraws
    // would interleave with whatever is reading the stream.
    if (!asJson) {
      const timingStore = commandRecordsProgressTimings(commandName)
        ? createProgressTimingStore(describeProgressProfile(commandName, selection))
        : undefined;
      progressDisplay = createProgressDisplay(commandName, timingStore);
      if (timingStore) {
        setCommandProjectRootReporter((buildRoot: string) => {
          timingStore.useProjectRoot(buildRoot);
        });
        setCommandRunVariantReporter((variant) => {
          timingStore.useMeasuredVariant(variant);
        });
      }
      setCommandProgressReporter((event) => {
        progressDisplay?.update(event);
      });
    }
    const lines = await run(selection);
    progressDisplay?.stop('done');
    if (asJson) {
      printJson(buildJsonResult(commandName, selection, lines));
      return;
    }
    for (const line of formatCommandOutput(commandName, selection, lines)) {
      console.log(line);
    }
  } catch (error) {
    progressDisplay?.stop('failed');
    renderError(error, asJson, commandName);
    process.exitCode = 1;
  } finally {
    setCommandProgressReporter(undefined);
    setCommandProjectRootReporter(undefined);
    setCommandRunVariantReporter(undefined);
  }
}

/**
 * Runs only predict each other when they do comparable work. A different
 * command, selection, or cache mode is a different amount of work, so each
 * keeps its own recorded timings rather than averaging them together.
 */
function describeProgressProfile(commandName: string, selection: SelectionInput): string {
  return [
    commandName,
    selection.scope,
    [...selection.modFilters].sort().join('+'),
    [...selection.patchFilters].sort().join('+'),
    selection.useCache === false ? 'nocache' : 'cache',
    // A run that keeps its optional features does more work than one that may
    // drop them, so the two are measured apart.
    selection.requireAll ? 'all' : 'optional',
  ].join('|');
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
  // Decoration always goes to stderr so piping a command's result stays clean.
  for (const line of getCliTitleLines()) {
    process.stderr.write(`${line}\n`);
  }
}

function addSelectionOptions(command: Command): void {
  command
    .option(
      '--ymb-path <path>',
      'Use a YMB folder other than the current one',
      createOptionValueParser('--ymb-path'),
    )
    .addOption(
      new Option('--scope <scope>', 'Include dev patches as well as normal ones')
        .choices(['prod', 'dev'])
        .default('prod'),
    )
    .option(
      '--mod <id-or-name>',
      'Only work on this mod. Repeat for several',
      createRepeatableCollector('--mod'),
      [],
    )
    .option(
      '--patch <id>',
      'Only apply this patch. Repeat for several',
      createRepeatableCollector('--patch'),
      [],
    );
}

function addCacheOption(command: Command): void {
  command.option(
    '--no-cache',
    'Redo all work instead of reusing cached results. Slower, use when results look stale',
  );
}

function addDryRunOption(command: Command): void {
  command.option('--dry-run', 'Show what would happen without writing preview or game files');
}

function addConfirmationOption(command: Command): void {
  command.option('--yes', 'Confirm you want this to change files');
}

function addRequireAllOption(command: Command): void {
  command.option(
    '--require-all',
    'Hold optional patches to the same standard as the rest, so missing game data stops the run',
  );
}

function addResetChangedOption(command: Command): void {
  command.option(
    '--reset-changed',
    'Put the saved original back over any tracked game file that changed outside YMB, then continue',
  );
}

function addJsonOption(command: Command): void {
  command.option('--json', 'Print one JSON result instead of readable text');
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
    resetChanged: options.resetChanged ?? false,
    requireAll: options.requireAll ?? false,
  };
}

function createRepeatableCollector(optionName: string) {
  return (value: string, previous: string[]): string[] => [
    ...previous,
    parseOptionValue(value, optionName),
  ];
}

function createOptionValueParser(optionName: string) {
  return (value: string): string => parseOptionValue(value, optionName);
}

function parseOptionValue(value: string, optionName: string): string {
  if (!value.startsWith('-')) {
    return value;
  }

  throw new YmbError('CommandError', {
    absolutePath: optionName,
    reason: `\`${optionName}\` needs a value, but received another option: \`${value}\`.`,
    suggestion: `Put the value directly after \`${optionName}\`, then add \`${value}\` separately.`,
  });
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new YmbError('CommandError', {
      absolutePath: 'find',
      reason: `\`--limit ${value}\` is not a whole number above zero.`,
      suggestion: 'Use a count like `--limit 200`.',
    });
  }
  return parsed;
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

/**
 * Result layout: headline, the numbers that matter, where to look, what to do
 * next, then optional detail. Labels share one padded column so the answer to
 * "did it work and what now" is readable at a glance.
 */
function formatCommandOutput(
  commandName: ReportedCommandName,
  selection: SelectionInput,
  lines: CommandOutputLines,
): string[] {
  const facts: Fact[] = [
    ...(lines.summary ?? []),
    { label: 'selection', value: describeSelection(commandName, selection) },
    ...(lines.locations ?? []).map((location) => ({
      label: location.label,
      value: location.path,
    })),
  ];

  const outputLines = [
    `[ok] ${describeCommandResultTitle(commandName, selection)}`,
    '',
    ...formatFactLines(facts, { indent: '  ', capitalizeLabels: true }),
  ];

  const nextSteps = lines.nextSteps ?? [];
  if (nextSteps.length > 0) {
    outputLines.push('', 'Next');
    outputLines.push(...nextSteps.map((nextStep) => `  ${nextStep}`));
  }

  const details = selectDetailLines(commandName, selection, lines);
  const heading = capitalize(lines.detailHeading ?? 'details');
  if (details.shownAll) {
    outputLines.push('', `${heading} (${lines.length})`);
    outputLines.push(...details.lines.map((line) => `  ${line}`));
    return outputLines;
  }

  // Only the lines worth reading, all of them, and one line saying where the
  // rest went.
  outputLines.push('', `${heading} (${details.lines.length} of ${lines.length})`);
  outputLines.push(...details.lines.map((line) => `  ${line}`));
  outputLines.push(
    `  ${details.lines.length === 0 ? 'Nothing unusual. ' : ''}Re-run with --verbose to see all ${lines.length} lines.`,
  );

  return outputLines;
}

/** One line covering scope, filters, and whether caches were in play. */
function describeSelection(commandName: ReportedCommandName, selection: SelectionInput): string {
  const parts = [formatFiltersLine(selection), describeScope(selection.scope)];
  if (selection.dryRun) {
    parts.push('dry run, nothing written');
  }
  if (shouldShowCacheLine(commandName) && selection.useCache === false) {
    parts.push('cache off');
  }
  if (selection.requireAll) {
    parts.push('optional patches required');
  }
  return parts.join(', ');
}

/** Laid out with the shared renderer so its column cannot drift from every command's. */
function formatInitOutput(created: InitResult, durationMs: number): string[] {
  return [
    '[ok] Starter source mod created',
    '',
    ...formatFactLines(
      [
        countFact('created', [['item', created.lines.length]]),
        timingFact(durationMs, []),
        { label: 'source mods', value: created.modsRoot },
      ],
      { indent: '  ', capitalizeLabels: true },
    ),
    '',
    'Next',
    '  Run `validate --mod <id>` to check the new source mod.',
    '  Run `build --mod <id>` to see what it produces.',
    '',
    `Created (${created.lines.length})`,
    ...created.lines.map((line) => `  ${line}`),
  ];
}

function formatFiltersLine(selection: SelectionInput): string {
  const modFilters =
    selection.modFilters.length > 0 ? selection.modFilters.join(', ') : 'all source mods';
  const patchFilters =
    selection.patchFilters.length > 0 ? selection.patchFilters.join(', ') : 'all patches';
  return `${modFilters}, ${patchFilters}`;
}

/**
 * Every line that is not routine -- a skip, a warning, a file kept back -- since the
 * summary already counts the rest. Never truncated.
 */
function selectDetailLines(
  commandName: ReportedCommandName,
  selection: SelectionInput,
  lines: string[],
): { lines: string[]; shownAll: boolean } {
  if (lines.length === 0) {
    return { lines: ['No details.'], shownAll: true };
  }

  if (selection.verbose || shouldShowAllDetails(commandName, selection)) {
    return { lines, shownAll: true };
  }

  const notableLines = lines.filter((line) => !isRoutineDetailLine(line));
  return notableLines.length === lines.length
    ? { lines, shownAll: true }
    : { lines: notableLines, shownAll: false };
}

/**
 * For `list`, `explain`, `doctor`, and `find`, the detail lines are the answer
 * to the question asked rather than a record of work done. A dry run is the same
 * thing in another form: the plan is the whole point of running it.
 */
function shouldShowAllDetails(
  commandName: ReportedCommandName,
  selection: SelectionInput,
): boolean {
  return (
    commandName === 'list' ||
    commandName === 'explain' ||
    commandName === 'doctor' ||
    commandName === 'find' ||
    selection.dryRun
  );
}

function shouldShowCacheLine(commandName: ReportedCommandName): boolean {
  return commandName === 'validate' || commandName === 'build' || commandName === 'sync';
}

function describeCommandResultTitle(
  commandName: ReportedCommandName,
  selection: SelectionInput,
): string {
  switch (commandName) {
    case 'validate':
      return 'Validation complete';
    case 'find':
      return 'Search complete';
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

function renderError(error: unknown, asJson: boolean, commandName: string): void {
  if (asJson) {
    // A failure is still a result, so it lands on stdout in the same envelope.
    // The exit code is what says it failed.
    printJson(buildJsonError(commandName, error));
    return;
  }

  const lines = describeFailureLines(error);
  // The progress display closes with its own timing line directly above, so the
  // error block gets a blank line to sit against instead of butting up on it.
  for (const line of ['', ...lines]) {
    console.error(line);
  }
}

function describeFailureLines(error: unknown): string[] {
  if (error instanceof YmbErrorGroup) {
    return formatErrorGroupLines(error.errors, error.omittedCount);
  }
  if (error instanceof YmbError) {
    return formatErrorLines(error.category, error.context);
  }
  return [
    'Unexpected error',
    `- problem: ${error instanceof Error ? error.message : String(error)}`,
    '- next: Re-run the command and keep the terminal output if this needs investigation.',
  ];
}
