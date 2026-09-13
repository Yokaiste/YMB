import { formatFactLines } from './report/facts.ts';
import type { ErrorCategory, ErrorContext } from './types.ts';

export class YmbError extends Error {
  readonly category: ErrorCategory;
  readonly context: ErrorContext;

  constructor(category: ErrorCategory, context: ErrorContext) {
    super(formatErrorMessage(category, context));
    this.name = 'YmbError';
    this.category = category;
    this.context = context;
  }
}

/**
 * Most of these failures are independent -- five targets naming files that moved are
 * five edits, not a chain -- so phases that can safely keep going collect as they go.
 */
export class YmbErrorGroup extends Error {
  readonly errors: readonly YmbError[];
  /** Found but not printed, because the report reached its limit. */
  readonly omittedCount: number;

  constructor(errors: readonly YmbError[], omittedCount = 0) {
    super(formatErrorGroupLines(errors, omittedCount).join('\n'));
    this.name = 'YmbErrorGroup';
    this.errors = errors;
    this.omittedCount = omittedCount;
  }
}

interface ErrorCollector {
  /**
   * Runs `task`, keeping a YMB failure and returning `undefined` instead of
   * stopping the run. Anything that is not a YMB failure is a bug rather than a
   * result, so it propagates untouched.
   */
  collect<T>(task: () => Promise<T>): Promise<T | undefined>;
  /** Records a failure that was caught elsewhere. Groups are flattened into this one. */
  record(error: unknown): void;
  /** How many distinct failures have been found, including any past the print limit. */
  count(): number;
  /** Raises what was collected: the failure itself when there is one, a group when there are more. */
  throwIfFailed(): void;
}

export function createErrorCollector(): ErrorCollector {
  const errors: YmbError[] = [];
  // Two phases of one command can reach the same broken file, and the reader
  // does not need to be told twice.
  const seen = new Set<string>();
  let omittedCount = 0;

  const push = (error: YmbError) => {
    const key = JSON.stringify([error.category, error.context]);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    errors.push(error);
  };

  const collector: ErrorCollector = {
    async collect<T>(task: () => Promise<T>): Promise<T | undefined> {
      try {
        return await task();
      } catch (error) {
        collector.record(error);
        return undefined;
      }
    },
    record(error: unknown): void {
      if (error instanceof YmbErrorGroup) {
        for (const nested of error.errors) push(nested);
        omittedCount += error.omittedCount;
        return;
      }
      if (error instanceof YmbError) {
        push(error);
        return;
      }
      throw error;
    },
    count(): number {
      return errors.length + omittedCount;
    },
    throwIfFailed(): void {
      const only = errors[0];
      if (!only) return;
      if (errors.length === 1 && omittedCount === 0) throw only;
      throw new YmbErrorGroup(errors, omittedCount);
    },
  };
  return collector;
}

/**
 * Every YMB failure reads the same way: what went wrong, how to fix it, and
 * where it happened. Labels are padded into one column so the eye can skip
 * straight to `Fix`.
 */
export function formatErrorLines(category: ErrorCategory, context: ErrorContext): string[] {
  return [
    `[x] ${describeErrorTitle(category)}`,
    '',
    `  ${context.reason}`,
    '',
    ...formatErrorFacts(context, '  '),
  ];
}

/** Shared failures state their reason and fix once, retaining every affected location. */
export function formatErrorGroupLines(errors: readonly YmbError[], omittedCount = 0): string[] {
  const total = errors.length + omittedCount;
  const lines = [`[x] ${total} ${total === 1 ? 'problem' : 'problems'} found`, ''];
  const groups = [
    ...Map.groupBy(errors, (error) =>
      JSON.stringify([error.category, error.context.reason, error.context.suggestion]),
    ).values(),
  ];
  for (const [index, group] of groups.entries()) {
    const error = group[0];
    if (!error) continue;
    lines.push(
      `  ${index + 1} of ${groups.length}  ${describeErrorTitle(error.category)}${group.length > 1 ? ` (${group.length} entries)` : ''}`,
      '',
      `    ${error.context.reason}`,
      '',
      ...(group.length === 1
        ? formatErrorFacts(error.context, '    ')
        : formatFactLines([{ label: 'Fix', value: error.context.suggestion }], { indent: '    ' })),
    );
    if (group.length > 1) {
      const locations = Map.groupBy(group, (entry) => JSON.stringify(entry.context));
      for (const entries of locations.values()) {
        const entry = entries[0];
        if (!entry) continue;
        lines.push('', ...formatErrorFacts(entry.context, '    ', false));
        if (entries.length > 1) lines.push(`    Repeated ${entries.length} times.`);
      }
    }
    lines.push('');
  }
  if (omittedCount > 0) {
    lines.push(`  ${omittedCount} more not shown. Fix these first and run again.`);
  } else {
    lines.pop();
  }
  return lines;
}

function formatErrorFacts(context: ErrorContext, indent: string, includeFix = true): string[] {
  const facts = includeFix ? [{ label: 'Fix', value: context.suggestion }] : [];
  // Some failures happen before any file is involved and carry a command name or
  // a `<placeholder>` here. Showing that as a file would just mislead.
  if (looksLikeFilePath(context.absolutePath)) {
    const position = context.line === undefined ? '' : `:${context.line}:${context.column ?? 1}`;
    facts.push({ label: 'File', value: `${context.absolutePath}${position}` });
  }
  if (context.modId || context.modName) {
    facts.push({ label: 'Mod', value: describeOwner(context.modId, context.modName) });
  }
  if (context.sourcePath) facts.push({ label: 'Source', value: context.sourcePath });
  if (context.patchId) {
    facts.push({ label: 'Patch', value: context.patchId });
  }
  if (context.operationIndex !== undefined) {
    facts.push({ label: 'Written at', value: describeOperationLocation(context) });
  }
  for (const detail of context.details ?? []) {
    facts.push({ label: 'Note', value: detail });
  }

  return formatFactLines(facts, { indent });
}

/**
 * Everything that can say where a patch operation was written. `patchConfigPath`
 * is printed as given, so a caller that wants it shortened against a root passes
 * it already shortened.
 */
interface OperationLocation {
  operationIndex?: number | undefined;
  /** Patch config file the operation was written in, when one is known. */
  patchConfigPath?: string | undefined;
  /** 1-based line of that operation inside `patchConfigPath`. */
  operationLine?: number | undefined;
}

/**
 * Where the operation is written, not where it sits in a list: finding operation 159
 * means counting YAML entries by hand, and a patch targeting one file twice makes
 * even that ambiguous. The ordinal is the fallback when no line is known. Errors and
 * notices both point at operations, and used to do it differently.
 */
export function describeOperationLocation(location: OperationLocation): string {
  if (location.operationIndex === undefined) {
    return '';
  }
  if (location.patchConfigPath && location.operationLine) {
    return `${location.patchConfigPath}:${location.operationLine}`;
  }
  return `operation #${location.operationIndex + 1}`;
}

function looksLikeFilePath(value: string): boolean {
  return /[\\/]/.test(value) || /\.[A-Za-z0-9]+$/.test(value);
}

function describeOwner(modId: string | undefined, modName: string | undefined): string {
  if (modId && modName && modId !== modName) {
    return `${modId} (${modName})`;
  }
  return modId ?? modName ?? '';
}

export function formatErrorMessage(category: ErrorCategory, context: ErrorContext): string {
  return formatErrorLines(category, context).join('\n');
}

export function ensure(
  condition: unknown,
  category: ErrorCategory,
  context: ErrorContext,
): asserts condition {
  if (!condition) {
    throw new YmbError(category, context);
  }
}

/** Plain-language titles. A modder should recognise the area without knowing YMB internals. */
function describeErrorTitle(category: ErrorCategory): string {
  switch (category) {
    case 'CommandError':
      return 'Command stopped';
    case 'LayoutError':
      return 'Wrong path';
    case 'ConfigError':
      return 'Problem in a config file';
    case 'SchemaError':
      return 'Config value is not allowed here';
    case 'ParserError':
      return 'Broken NDF';
    case 'SelectorError':
      return 'Nothing matched this selector';
    case 'ConflictError':
      return 'Two mods want the same thing';
    case 'ScriptError':
      return 'A generation script failed';
    case 'RecoveryError':
      return 'Recovery data is not safe to use';
    case 'IoError':
      return 'File is missing or unreadable';
  }
}
