import type { BuildScriptTextTools } from 'ymb/api';
import type { BuilderProjectSettings } from '../builder-config.ts';
import { describeTextChanges, resolveTextMergeBudgets } from '../text-merge.ts';

/**
 * A script diffing its own output runs the same line diff the merge does, so it
 * gets the same configured ceiling rather than one of its own.
 */
export function createScriptTextTools(settings: BuilderProjectSettings): BuildScriptTextTools {
  const budgets = resolveTextMergeBudgets(settings);
  return Object.freeze({
    escapeRegExp: RegExp.escape,
    describeChanges(baseText: string, nextText: string) {
      const result = describeTextChanges(
        baseText,
        nextText,
        {
          id: 'script-api',
          label: 'script API',
        },
        budgets,
      );
      return result.ok
        ? {
            ok: true as const,
            edits: result.edits.map(({ start, end }) => ({ start, end })),
          }
        : { ok: false as const, reason: result.reason };
    },
  });
}
