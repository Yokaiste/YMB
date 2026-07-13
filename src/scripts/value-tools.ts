import type { BuildScriptValueTools } from '../types.ts';
import { ScriptToolError } from './tool-error.ts';

export function createScriptValueTools(): BuildScriptValueTools {
  return Object.freeze({
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
        details: [`Received: ${String(value)}`],
      });
    },
  });
}
