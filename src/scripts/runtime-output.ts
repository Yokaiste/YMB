import { ensure } from '../errors.ts';
import { normalizeRelativePath } from '../path-utils.ts';
import type { GeneratedScriptFile, ScriptApplication } from '../types.ts';

export function normalizeScriptOutput(
  script: ScriptApplication,
  output: GeneratedScriptFile,
  outputIndex: number,
): GeneratedScriptFile {
  ensure(output && typeof output === 'object', 'ScriptError', {
    absolutePath: script.absolutePath,
    modId: script.mod.config.id,
    modName: script.mod.config.name,
    patchId: script.patch?.config.id,
    reason: `Script output #${outputIndex + 1} is not an object.`,
    suggestion: 'Return objects shaped like `{ targetRelativePath, content }`.',
  });

  ensure(
    typeof output.targetRelativePath === 'string' && output.targetRelativePath.length > 0,
    'ScriptError',
    {
      absolutePath: script.absolutePath,
      modId: script.mod.config.id,
      modName: script.mod.config.name,
      patchId: script.patch?.config.id,
      reason: `Script output #${outputIndex + 1} is missing a valid \`targetRelativePath\`.`,
      suggestion: 'Return a non-empty game-relative target path.',
    },
  );

  ensure(
    typeof output.content === 'string' || output.content instanceof Uint8Array,
    'ScriptError',
    {
      absolutePath: script.absolutePath,
      modId: script.mod.config.id,
      modName: script.mod.config.name,
      patchId: script.patch?.config.id,
      reason: `Script output #${outputIndex + 1} has unsupported content.`,
      suggestion: 'Return either a string or a Uint8Array as the output content.',
    },
  );

  return {
    targetRelativePath: normalizeRelativePath(output.targetRelativePath),
    content: output.content,
  };
}
