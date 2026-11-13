import type { GeneratedScriptFile } from 'ymb/api';
import { ensure } from '../errors.ts';
import { normalizeRelativePath } from '../path-utils.ts';
import type { ErrorContext, ScriptApplication } from '../types.ts';

export function normalizeScriptOutput(
  script: ScriptApplication,
  output: GeneratedScriptFile,
  outputIndex: number,
): GeneratedScriptFile {
  ensure(
    output && typeof output === 'object',
    'ScriptError',
    createScriptOutputErrorContext(
      script,
      outputIndex,
      'is not an object.',
      'Return objects shaped like `{ targetRelativePath, content }`.',
    ),
  );

  ensure(
    typeof output.targetRelativePath === 'string' && output.targetRelativePath.length > 0,
    'ScriptError',
    createScriptOutputErrorContext(
      script,
      outputIndex,
      'is missing a valid `targetRelativePath`.',
      'Return a non-empty game-relative target path.',
    ),
  );

  ensure(
    typeof output.content === 'string' || output.content instanceof Uint8Array,
    'ScriptError',
    createScriptOutputErrorContext(
      script,
      outputIndex,
      'has unsupported content.',
      'Return either a string or a Uint8Array as the output content.',
    ),
  );

  ensure(
    output.generatedBlockOwnerPaths === undefined ||
      (Array.isArray(output.generatedBlockOwnerPaths) &&
        output.generatedBlockOwnerPaths.every(
          (ownerPath) => typeof ownerPath === 'string' && ownerPath.length > 0,
        )),
    'ScriptError',
    createScriptOutputErrorContext(
      script,
      outputIndex,
      'has invalid generated-block owner paths.',
      'Use non-empty builder-relative script paths for delegated generated blocks.',
    ),
  );

  return {
    targetRelativePath: normalizeRelativePath(output.targetRelativePath),
    content: output.content,
    ...(output.generatedBlockOwnerPaths
      ? {
          generatedBlockOwnerPaths: output.generatedBlockOwnerPaths.map(normalizeRelativePath),
        }
      : {}),
  };
}

function createScriptOutputErrorContext(
  script: ScriptApplication,
  outputIndex: number,
  reason: string,
  suggestion: string,
): ErrorContext {
  return {
    absolutePath: script.absolutePath,
    modId: script.mod.config.id,
    modName: script.mod.config.name,
    patchId: script.patch?.config.id,
    reason: `Script output #${outputIndex + 1} ${reason}`,
    suggestion,
  };
}
