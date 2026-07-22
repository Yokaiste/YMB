import { type CooperativeYieldController, mapConcurrent } from '../async.ts';
import { ensure } from '../errors.ts';
import { isNdfPath, validateNdf, validateNdfCooperative } from '../patch/ndf.ts';
import { resolveTemplateValue } from '../templates.ts';
import type { BuildPlan, WrittenBuildFile } from '../types.ts';
import { abbreviateProgressPath, reportProgress } from './progress.ts';
import { isTextTemplateFile, stringifyTemplateContent } from './shared.ts';

export async function validateReplaceOutputs(
  plan: BuildPlan,
  yieldController?: CooperativeYieldController,
): Promise<void> {
  let completed = 0;
  reportProgress('Validating replace templates', undefined, {
    current: 0,
    total: plan.selectedReplaceFiles.length,
  });
  await mapConcurrent(plan.selectedReplaceFiles, 8, async (replaceFile) => {
    await yieldController?.maybeYield();
    await loadPreparedReplaceContent(replaceFile, yieldController);
    completed += 1;
    reportProgress(
      'Validating replace templates',
      abbreviateProgressPath(replaceFile.targetRelativePath),
      { current: completed, total: plan.selectedReplaceFiles.length },
    );
  });
}

export async function materializeReplaceOutputs(
  plan: BuildPlan,
  yieldController?: CooperativeYieldController,
): Promise<WrittenBuildFile[]> {
  let completed = 0;
  reportProgress('Materializing replace outputs', undefined, {
    current: 0,
    total: plan.selectedReplaceFiles.length,
  });
  return mapConcurrent(plan.selectedReplaceFiles, 8, async (replaceFile) => {
    await yieldController?.maybeYield();
    const content = await loadPreparedReplaceContent(replaceFile, yieldController);
    completed += 1;
    reportProgress(
      'Materializing replace outputs',
      abbreviateProgressPath(replaceFile.targetRelativePath),
      { current: completed, total: plan.selectedReplaceFiles.length },
    );
    return {
      targetRelativePath: replaceFile.targetRelativePath,
      sourceType: 'replace',
      content,
      contributors: [{ modId: replaceFile.modId, modName: replaceFile.modName }],
    };
  });
}

async function loadPreparedReplaceContent(
  replaceFile: BuildPlan['selectedReplaceFiles'][number],
  yieldController?: CooperativeYieldController,
): Promise<string | Uint8Array> {
  const file = Bun.file(replaceFile.sourceAbsolutePath);
  ensure(await file.exists(), 'IoError', {
    absolutePath: replaceFile.sourceAbsolutePath,
    modId: replaceFile.modId,
    modName: replaceFile.modName,
    reason: `Replace file for \`${replaceFile.targetRelativePath}\` does not exist.`,
    suggestion: 'Restore the missing replace file or remove the broken config entry.',
  });
  const content = isTextTemplateFile(replaceFile.sourceAbsolutePath)
    ? stringifyTemplateContent(
        resolveTemplateValue(await file.text(), replaceFile.templateVariables),
      )
    : new Uint8Array(await file.arrayBuffer());
  if (typeof content === 'string' && isNdfPath(replaceFile.targetRelativePath)) {
    if (yieldController) {
      await validateNdfCooperative(content, replaceFile.targetRelativePath, yieldController);
    } else {
      validateNdf(content, replaceFile.targetRelativePath);
    }
  }
  return content;
}
