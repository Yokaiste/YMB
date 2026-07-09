import type { CooperativeYieldController } from '../async.ts';
import { ensure } from '../errors.ts';
import { isNdfPath, validateNdf, validateNdfCooperative } from '../patch/ndf.ts';
import { resolveTemplateValue } from '../templates.ts';
import type { BuildPlan, WrittenBuildFile } from '../types.ts';
import { isTextTemplateFile, stringifyTemplateContent } from './shared.ts';

export async function validateReplaceOutputs(
  plan: BuildPlan,
  yieldController?: CooperativeYieldController,
): Promise<void> {
  for (const replaceFile of plan.selectedReplaceFiles) {
    await yieldController?.maybeYield();
    await loadPreparedReplaceContent(replaceFile, yieldController);
  }
}

export async function materializeReplaceOutputs(
  plan: BuildPlan,
  yieldController?: CooperativeYieldController,
): Promise<WrittenBuildFile[]> {
  const writtenFiles: WrittenBuildFile[] = [];

  for (const replaceFile of plan.selectedReplaceFiles) {
    await yieldController?.maybeYield();
    const content = await loadPreparedReplaceContent(replaceFile, yieldController);
    writtenFiles.push({
      targetRelativePath: replaceFile.targetRelativePath,
      sourceType: 'replace',
      content,
      contributors: [{ modId: replaceFile.modId, modName: replaceFile.modName }],
    });
  }

  return writtenFiles;
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
