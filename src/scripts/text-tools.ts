import type { BuildScriptTextTools } from '../api.ts';
import { describeTextChanges } from '../text-merge.ts';
import { escapeRegExp } from '../text-utils.ts';

export function createScriptTextTools(): BuildScriptTextTools {
  return Object.freeze({
    escapeRegExp,
    describeChanges(baseText: string, nextText: string) {
      const result = describeTextChanges(baseText, nextText, {
        id: 'script-api',
        label: 'script API',
      });
      return result.ok
        ? {
            ok: true as const,
            edits: result.edits.map(({ start, end }) => ({ start, end })),
          }
        : { ok: false as const, reason: result.reason };
    },
  });
}
