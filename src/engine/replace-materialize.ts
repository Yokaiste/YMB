import { type CooperativeYieldController, mapConcurrent } from '../async.ts';
import { createErrorCollector, ensure } from '../errors.ts';
import { loadManifest } from '../markers.ts';
import { isNdfPath, validateNdf, validateNdfCooperative } from '../patch/ndf/validate.ts';
import { resolveModTargetPath, toPathKey } from '../path-utils.ts';
import { resolveTemplateValue } from '../templates.ts';
import type { BuildPlan, SyncManifestEntry, WrittenBuildFile } from '../types.ts';
import { trackProgress } from './progress.ts';
import { isTextTemplateFile, loadOriginalBackupBytes, stringifyTemplateContent } from './shared.ts';

export async function validateReplaceOutputs(
  plan: BuildPlan,
  yieldController?: CooperativeYieldController,
): Promise<void> {
  const manifestByTarget = await loadManifestEntryMap(plan);
  // Replace files are independent of each other, so one broken template is no
  // reason to stop checking the rest.
  const failures = createErrorCollector();
  const progress = trackProgress('Validating replace templates', plan.selectedReplaceFiles.length);
  await mapConcurrent(plan.selectedReplaceFiles, 8, async (replaceFile) => {
    await yieldController?.maybeYield();
    await failures.collect(async () => {
      await loadPreparedReplaceContent(plan, replaceFile, manifestByTarget, yieldController);
      progress.step(replaceFile.targetRelativePath);
    });
  });
  failures.throwIfFailed();
}

export async function materializeReplaceOutputs(
  plan: BuildPlan,
  yieldController?: CooperativeYieldController,
): Promise<WrittenBuildFile[]> {
  const manifestByTarget = await loadManifestEntryMap(plan);
  const failures = createErrorCollector();
  const progress = trackProgress('Materializing replace outputs', plan.selectedReplaceFiles.length);
  const results = await mapConcurrent(plan.selectedReplaceFiles, 8, async (replaceFile) =>
    failures.collect(async (): Promise<WrittenBuildFile> => {
      await yieldController?.maybeYield();
      const content = await loadPreparedReplaceContent(
        plan,
        replaceFile,
        manifestByTarget,
        yieldController,
      );
      progress.step(replaceFile.targetRelativePath);
      return {
        targetRelativePath: replaceFile.targetRelativePath,
        sourceType: replaceFile.sourceType,
        content,
        contributors: [
          {
            modId: replaceFile.modId,
            modName: replaceFile.modName,
            patchId: replaceFile.patchId,
          },
        ],
        preservesSourceBytes: replaceFile.contentMode === 'exact',
      };
    }),
  );
  // Nothing may be written from a list with holes in it.
  failures.throwIfFailed();
  return results.filter((file): file is WrittenBuildFile => file !== undefined);
}

async function loadPreparedReplaceContent(
  plan: BuildPlan,
  replaceFile: BuildPlan['selectedReplaceFiles'][number],
  manifestByTarget: ReadonlyMap<string, SyncManifestEntry>,
  yieldController?: CooperativeYieldController,
): Promise<string | Uint8Array> {
  const file = Bun.file(replaceFile.sourceAbsolutePath);
  const sourceManifestEntry = replaceFile.sourceGameRelativePath
    ? manifestByTarget.get(toPathKey(replaceFile.sourceGameRelativePath))
    : undefined;
  if (!sourceManifestEntry?.backupFileName) {
    ensure(await file.exists(), 'IoError', {
      absolutePath: replaceFile.sourceAbsolutePath,
      modId: replaceFile.modId,
      modName: replaceFile.modName,
      patchId: replaceFile.patchId,
      reason: `Source file for \`${replaceFile.targetRelativePath}\` does not exist.`,
      suggestion: 'Restore the missing source file or remove the broken config entry.',
    });
  }
  const sourceBytes = replaceFile.sourceGameRelativePath
    ? await loadOriginalBackupBytes(
        plan.context,
        resolveModTargetPath(plan.context.modRoot, replaceFile.sourceGameRelativePath),
        sourceManifestEntry?.backupFileName,
        sourceManifestEntry?.originalContentHash,
      )
    : new Uint8Array(await file.arrayBuffer());
  const sourceTypePath = replaceFile.sourceGameRelativePath ?? replaceFile.sourceAbsolutePath;
  const targetIsNdf = isNdfPath(replaceFile.targetRelativePath);
  const sourceText =
    isTextTemplateFile(sourceTypePath) || targetIsNdf
      ? Buffer.from(sourceBytes).toString('utf8')
      : undefined;
  const content =
    replaceFile.contentMode === 'template' && sourceText !== undefined
      ? stringifyTemplateContent(resolveTemplateValue(sourceText, replaceFile.templateVariables))
      : sourceBytes;
  if (targetIsNdf) {
    const ndfContent = typeof content === 'string' ? content : (sourceText ?? '');
    if (yieldController) {
      await validateNdfCooperative(ndfContent, replaceFile.targetRelativePath, yieldController);
    } else {
      validateNdf(ndfContent, replaceFile.targetRelativePath);
    }
  }
  return content;
}

async function loadManifestEntryMap(plan: BuildPlan): Promise<Map<string, SyncManifestEntry>> {
  const manifest = await loadManifest(plan.context.stateRoot);
  return new Map(
    manifest.entries.map((entry) => [toPathKey(entry.targetRelativePath), entry] as const),
  );
}
