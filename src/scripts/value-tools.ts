import { type BuildScriptValueTools, ScriptToolError } from 'ymb/api';

export function createScriptValueTools(): BuildScriptValueTools {
  return Object.freeze({
    record(value: unknown, label: string): Record<string, unknown> {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
      throw expectedValue(label, 'an object', value);
    },
    string(value: unknown, label: string): string {
      if (typeof value === 'string') {
        return value;
      }
      throw expectedValue(label, 'a string', value);
    },
    optionalString(value: unknown, label: string): string | undefined {
      if (value === undefined) {
        return undefined;
      }
      if (typeof value === 'string') {
        return value;
      }
      throw expectedValue(label, 'a string or undefined', value);
    },
    boolean(value: unknown, label: string): boolean {
      if (typeof value === 'boolean') {
        return value;
      }
      throw expectedValue(label, 'a boolean', value);
    },
    stringArray(value: unknown, label: string): string[] {
      if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
        return [...value];
      }
      throw expectedValue(label, 'an array of strings', value);
    },
    oneOf<const Values extends readonly string[]>(
      value: unknown,
      label: string,
      allowedValues: Values,
    ): Values[number] {
      if (typeof value === 'string' && allowedValues.includes(value)) {
        return value as Values[number];
      }
      throw new ScriptToolError({
        reason: `Expected \`${label}\` to be one of the supported values.`,
        suggestion: `Set \`${label}\` to one of: ${allowedValues.map((entry) => `\`${entry}\``).join(', ')}.`,
        details: [`Received: ${describeValue(value)}`],
      });
    },
    positiveInteger(value: unknown, label: string): number {
      const parsed =
        typeof value === 'number'
          ? value
          : typeof value === 'string'
            ? Number(value.trim())
            : Number.NaN;
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        return parsed;
      }
      throw new ScriptToolError({
        reason: `Expected \`${label}\` to be a positive safe integer.`,
        suggestion: `Set \`${label}\` to an integer between 1 and ${Number.MAX_SAFE_INTEGER}.`,
        details: [`Received: ${describeValue(value)}`],
      });
    },
  });
}

function expectedValue(label: string, expected: string, value: unknown): ScriptToolError {
  return new ScriptToolError({
    reason: `Expected \`${label}\` to be ${expected}.`,
    suggestion: `Set \`${label}\` to ${expected}.`,
    details: [`Received: ${describeValue(value)}`],
  });
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
