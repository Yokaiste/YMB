import type { Command } from 'commander';
import packageDefinition from '../../package.json' with { type: 'json' };
import { YmbError, YmbErrorGroup } from '../errors.ts';
import type { InitResult } from '../init.ts';
import type { CommandOutputLines } from '../report/output.ts';
import type { ErrorCategory, ErrorContext, SelectionInput } from '../types.ts';

/**
 * One JSON document on stdout and nothing else: no banner, no progress, no
 * truncation hint. Every command emits the same envelope, so a caller can read `ok`
 * and `errors` without knowing which ran.
 */
interface JsonEnvelope {
  schemaVersion: 2;
  ymb: string;
  command: string;
  ok: boolean;
}

interface JsonSelection {
  scope: SelectionInput['scope'];
  mods: string[];
  patches: string[];
  dryRun: boolean;
  useCache: boolean;
  requireAll: boolean;
}

export function buildJsonResult(
  command: string,
  selection: SelectionInput,
  lines: CommandOutputLines,
): JsonEnvelope & Record<string, unknown> {
  return {
    ...createEnvelope(command, true),
    selection: describeSelection(selection),
    data: lines.data ?? {},
  };
}

export function buildJsonInitResult(created: InitResult): JsonEnvelope & Record<string, unknown> {
  return {
    ...createEnvelope('init', true),
    data: created.data ?? {},
  };
}

/** Always a list, so `errors[0]` reads the same for one failure or twelve. */
export function buildJsonError(
  command: string,
  error: unknown,
): JsonEnvelope & Record<string, unknown> {
  const errors =
    error instanceof YmbErrorGroup
      ? error.errors.map((item) => describeYmbError(item.category, item.context))
      : error instanceof YmbError
        ? [describeYmbError(error.category, error.context)]
        : [
            {
              category: 'UnexpectedError',
              reason: error instanceof Error ? error.message : String(error),
              suggestion:
                'Save the command and this result. Report the failure in the YSM Community Discord troubleshooting forum: https://discord.gg/33Sqn6dTjf.',
            },
          ];
  return {
    ...createEnvelope(command, false),
    errors,
    omittedErrorCount: 0,
    errorCount: errors.length,
  };
}

export function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function createEnvelope(command: string, ok: boolean): JsonEnvelope {
  return { schemaVersion: 2, ymb: packageDefinition.version, command, ok };
}

function describeSelection(selection: SelectionInput): JsonSelection {
  return {
    scope: selection.scope,
    mods: [...selection.modFilters],
    patches: [...selection.patchFilters],
    dryRun: selection.dryRun,
    useCache: selection.useCache !== false,
    requireAll: selection.requireAll === true,
  };
}

function describeYmbError(category: ErrorCategory, context: ErrorContext): Record<string, unknown> {
  return {
    category,
    reason: context.reason,
    suggestion: context.suggestion,
    path: context.absolutePath,
    code: context.code,
    line: context.line,
    column: context.column,
    offset: context.offset,
    sourcePath: context.sourcePath,
    patchConfigPath: context.patchConfigPath,
    operationLine: context.operationLine,
    ...(context.modId === undefined ? {} : { modId: context.modId }),
    ...(context.modName === undefined ? {} : { modName: context.modName }),
    ...(context.patchId === undefined ? {} : { patchId: context.patchId }),
    ...(context.operationIndex === undefined
      ? {}
      : { operationIndex: context.operationIndex, operationNumber: context.operationIndex + 1 }),
    ...(context.details === undefined ? {} : { details: context.details }),
  };
}

export function buildJsonHelp(
  program: Command,
  commandName: string,
  versionOnly = false,
): JsonEnvelope & Record<string, unknown> {
  if (versionOnly) return { ...createEnvelope('version', true) };
  const command = program.commands.find((entry) => entry.name() === commandName) ?? program;
  return {
    ...createEnvelope('help', true),
    data: {
      name: command.name(),
      description: command.description(),
      options: command
        .createHelp()
        .visibleOptions(command)
        .map((option) => ({
          flags: option.flags,
          description: option.description,
          requiredValue: option.required,
          optionalValue: option.optional,
          default: option.defaultValue,
          choices: option.argChoices,
        })),
      commands: command.commands.map((entry) => ({
        name: entry.name(),
        description: entry.description(),
      })),
    },
  };
}
