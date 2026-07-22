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

export function formatErrorLines(category: ErrorCategory, context: ErrorContext): string[] {
  const lines = [describeErrorTitle(category), `- problem: ${context.reason}`];
  lines.push(`- path: ${context.absolutePath}`);
  if (context.modId) {
    lines.push(`- mod id: ${context.modId}`);
  }
  if (context.modName) {
    lines.push(`- mod name: ${context.modName}`);
  }
  if (context.patchId) {
    lines.push(`- patch id: ${context.patchId}`);
  }
  if (context.operationIndex !== undefined) {
    lines.push(`- operation: ${context.operationIndex}`);
  }
  lines.push(`- next: ${context.suggestion}`);
  for (const detail of context.details ?? []) {
    lines.push(`- detail: ${detail}`);
  }
  return lines;
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

function describeErrorTitle(category: ErrorCategory): string {
  switch (category) {
    case 'CommandError':
      return 'Command blocked';
    case 'LayoutError':
      return 'Layout error';
    case 'ConfigError':
      return 'Config error';
    case 'SchemaError':
      return 'Schema error';
    case 'ParserError':
      return 'Parser error';
    case 'SelectorError':
      return 'Selector error';
    case 'ConflictError':
      return 'Conflict error';
    case 'ScriptError':
      return 'Script error';
    case 'RecoveryError':
      return 'Recovery error';
    case 'IoError':
      return 'File error';
  }
}
