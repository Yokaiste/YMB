import type {
  BuildScriptAssertionOptions,
  BuildScriptAssertionTools,
  BuildScriptSelfCheck,
} from '../types.ts';
import { ScriptToolError } from './tool-error.ts';

export function createScriptAssertionTools(): BuildScriptAssertionTools {
  const ok: BuildScriptAssertionTools['ok'] = (
    condition: unknown,
    options: BuildScriptAssertionOptions,
  ): asserts condition => {
    if (!condition) {
      throw new ScriptToolError(options);
    }
  };

  return Object.freeze({
    ok,
    textPresent(content: string, options: BuildScriptAssertionOptions): void {
      ok(content.trim().length > 0, options);
    },
    textIncludes(
      content: string,
      expectedFragment: string,
      options: BuildScriptAssertionOptions,
    ): void {
      ok(content.includes(expectedFragment), {
        ...options,
        details: [...(options.details ?? []), `Expected fragment: ${expectedFragment}`],
      });
    },
    textMatches(content: string, pattern: RegExp, options: BuildScriptAssertionOptions): void {
      pattern.lastIndex = 0;
      ok(pattern.test(content), {
        ...options,
        details: [...(options.details ?? []), `Expected pattern: ${pattern}`],
      });
    },
    async all(checks: BuildScriptSelfCheck[]): Promise<void> {
      const failures: Array<{ name: string; options: BuildScriptAssertionOptions }> = [];
      for (const check of checks) {
        try {
          await check.run();
        } catch (error) {
          if (error instanceof ScriptToolError) {
            failures.push({ name: check.name, options: error.options });
            continue;
          }
          failures.push({
            name: check.name,
            options: {
              reason: `Script self-check \`${check.name}\` failed.`,
              suggestion:
                check.suggestion ??
                'Update the script assumptions to match the current inputs and configuration.',
              details: [error instanceof Error ? (error.stack ?? error.message) : String(error)],
            },
          });
        }
      }
      if (failures.length === 0) {
        return;
      }
      if (failures.length === 1) {
        const failure = failures[0];
        if (failure) {
          throw new ScriptToolError(failure.options);
        }
      }
      throw new ScriptToolError({
        reason: `${failures.length} script self-checks failed.`,
        suggestion: 'Fix every reported check before building or syncing the mod.',
        details: failures.flatMap(({ name, options }) => [
          `${name}: ${options.reason}`,
          `Suggestion: ${options.suggestion}`,
          ...(options.details ?? []).map((detail) => `  ${detail}`),
        ]),
      });
    },
  });
}
