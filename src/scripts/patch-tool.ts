import type { BuildScriptTools } from 'ymb/api';
import { createCooperativeYieldController } from '../async.ts';
import { patchSchema } from '../config/schemas.ts';
import { resolveVariablesInTarget } from '../engine/shared.ts';
import { ensure } from '../errors.ts';
import { applyPatchTargetCooperative } from '../patch/ndf/core.ts';
import { assertGameRelativePath, resolveModTargetPath } from '../path-utils.ts';
import { createTemplateVariables } from '../templates.ts';
import type { ScriptApplication, ScriptRuntimePlan } from '../types.ts';

export function createScriptPatchTool(
  plan: ScriptRuntimePlan,
  script: ScriptApplication,
): BuildScriptTools['patch'] {
  return async (text, target) => {
    const parsed = patchSchema.safeParse({
      version: 1,
      id: script.patch?.config.id ?? script.mod.config.id,
      name: script.patch?.config.name ?? script.mod.config.name,
      scope: plan.selection.scope,
      targets: [target],
    });
    ensure(parsed.success, 'SchemaError', {
      absolutePath: script.absolutePath,
      modId: script.mod.config.id,
      reason: 'The script supplied invalid NDF patch operations.',
      suggestion: 'Use the same target and operation shapes as a ymb.patch.yaml file.',
      details: parsed.error?.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
    const application = {
      mod: script.mod,
      patch: script.patch ?? {
        config: parsed.data,
        absolutePath: script.mod.configDirectoryPath,
        relativePathInMod: 'config',
        configFilePath: script.absolutePath,
      },
    };
    const authoredTarget = parsed.data.targets[0];
    ensure(authoredTarget, 'SchemaError', {
      absolutePath: script.absolutePath,
      reason: 'The script patch has no target.',
      suggestion: 'Supply a target with NDF operations.',
    });
    const resolved = resolveVariablesInTarget(
      authoredTarget,
      createTemplateVariables(plan.context, script.mod, script.patch),
      application,
    );
    const file = assertGameRelativePath(resolved.file, plan.context.modRoot);
    return applyPatchTargetCooperative(
      text,
      resolved,
      application,
      resolveModTargetPath(plan.context.modRoot, file),
      createCooperativeYieldController(),
    );
  };
}
