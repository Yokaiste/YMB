import type { CooperativeYieldController } from '../async.ts';
import { BUILDER_CONFIG } from '../builder-config.ts';
import { hashContent, hashText } from '../hash.ts';
import {
  decorateTextWithExactMarkersCooperative,
  supportsMarkerComments,
  wrapWithMarker,
} from '../markers.ts';
import { isNdfPath } from '../patch/ndf/validate.ts';
import { pathExists, resolveModTargetPath } from '../path-utils.ts';
import type { ReportFinding } from '../report/findings.ts';
import { resolveExactMarkerBudgets } from '../text-merge.ts';
import { readTrackedTextCooperative } from '../tracked-targets.ts';
import type { BuilderContext, WrittenBuildFile } from '../types.ts';
import { validateNdfPersistentlyMemoized } from './validation-memo.ts';

/**
 * YMB writes into files the game also ships, so every output says who wrote it and
 * what from. Some cannot carry that, and this is the single place that decides
 * which, so a preview and a sync always agree.
 */
interface PreparedMarkedOutput {
  content: string | Uint8Array;
  markerId: string;
  markerHash: string;
  warning?:
    | 'unsupported_comment_syntax'
    | 'binary_output'
    | 'exact_byte_copy'
    | 'exact_change_budget_exceeded';
}

export function resolveUnmarkableOutputWarning(
  writtenFile: WrittenBuildFile,
): PreparedMarkedOutput['warning'] | undefined {
  if (typeof writtenFile.content !== 'string') {
    return writtenFile.preservesSourceBytes ? 'exact_byte_copy' : 'binary_output';
  }
  if (!supportsMarkerComments(writtenFile.targetRelativePath)) {
    return 'unsupported_comment_syntax';
  }
  return undefined;
}

function createUnmarkedOutput(
  writtenFile: WrittenBuildFile,
  warning: NonNullable<PreparedMarkedOutput['warning']>,
): PreparedMarkedOutput {
  const markerHash = hashContent(writtenFile.content);
  return {
    content: writtenFile.content,
    markerId: hashText(`${writtenFile.targetRelativePath}:${markerHash}`),
    markerHash,
    warning,
  };
}

export async function prepareMarkedOutput(
  context: BuilderContext,
  writtenFile: WrittenBuildFile,
  builderId: string,
  yieldController: CooperativeYieldController,
): Promise<PreparedMarkedOutput> {
  // One decision, shared with the dry-run path, so a preview and a sync can never
  // disagree about which outputs can carry markers.
  const unmarkableReason = resolveUnmarkableOutputWarning(writtenFile);
  if (unmarkableReason !== undefined || typeof writtenFile.content !== 'string') {
    return createUnmarkedOutput(writtenFile, unmarkableReason ?? 'binary_output');
  }

  const content = writtenFile.content;
  const exactMarkedContent =
    writtenFile.sourceType === 'patch'
      ? { content, warning: undefined }
      : await decorateTextWithExactMarkersCooperative(
          await loadMarkerBaseText(context, writtenFile.targetRelativePath, yieldController),
          content,
          writtenFile.targetRelativePath,
          builderId,
          writtenFile.contributors,
          yieldController,
          resolveExactMarkerBudgets(context.builderConfig.settings),
        );
  const markerHash = hashContent(exactMarkedContent.content);
  const markerId = hashText(`${writtenFile.targetRelativePath}:${markerHash}`);
  if (writtenFile.sourceType !== 'patch' && isNdfPath(writtenFile.targetRelativePath)) {
    await validateNdfPersistentlyMemoized(
      exactMarkedContent.content,
      writtenFile.targetRelativePath,
      context.buildCacheRoot,
      yieldController,
    );
  }

  return {
    content: wrapWithMarker(
      exactMarkedContent.content,
      {
        markerId,
        markerHash,
        builderId,
        contributors: writtenFile.contributors,
      },
      writtenFile.targetRelativePath,
    ),
    markerId,
    markerHash,
    ...(exactMarkedContent.warning ? { warning: exactMarkedContent.warning } : {}),
  };
}

async function loadMarkerBaseText(
  context: BuilderContext,
  targetRelativePath: string,
  yieldController: CooperativeYieldController,
): Promise<string> {
  const targetAbsolutePath = resolveModTargetPath(context.modRoot, targetRelativePath);
  return (await pathExists(targetAbsolutePath))
    ? await readTrackedTextCooperative(context, targetAbsolutePath, yieldController)
    : '';
}

/**
 * These three can never carry in-file markers. That is a property of the file, so it
 * is a note rather than a warning -- an asset pack used to print one per image.
 * Listed positively, so a future reason stays a real warning until someone decides.
 */
function isInherentlyUnmarkable(reason: NonNullable<PreparedMarkedOutput['warning']>): boolean {
  return (
    reason === 'binary_output' ||
    reason === 'exact_byte_copy' ||
    reason === 'unsupported_comment_syntax'
  );
}

/**
 * Notes stay out of the detail list unless `--verbose` asks. The finding is
 * collected rather than printed: every target hitting one reason shares its whole
 * explanation.
 */
export function recordUnmarkedTarget(args: {
  targetKind: 'preview' | 'sync';
  targetRelativePath: string;
  reason: NonNullable<PreparedMarkedOutput['warning']>;
  stateRootPath: string;
  verbose: boolean;
  findings: ReportFinding[];
}): { warningCount: number; unmarkableCount: number } {
  const inherent = isInherentlyUnmarkable(args.reason);
  if (!inherent || args.verbose) {
    args.findings.push(
      createUnmarkedTargetFinding(
        args.targetKind,
        args.targetRelativePath,
        args.reason,
        args.stateRootPath,
        inherent ? 'note' : 'warning',
      ),
    );
  }
  return inherent
    ? { warningCount: 0, unmarkableCount: 1 }
    : { warningCount: 1, unmarkableCount: 0 };
}

function createUnmarkedTargetFinding(
  targetKind: 'preview' | 'sync',
  targetRelativePath: string,
  reason: PreparedMarkedOutput['warning'],
  stateRootPath: string,
  severity: 'note' | 'warning',
): ReportFinding {
  const detail =
    reason === 'binary_output'
      ? `Binary output; ${BUILDER_CONFIG.name} cannot embed in-file comment markers.`
      : reason === 'exact_byte_copy'
        ? 'Exact byte copy; in-file ownership markers would change the source bytes.'
        : reason === 'exact_change_budget_exceeded'
          ? `Exact inline markers were skipped because this target exceeded ${BUILDER_CONFIG.name}'s protected diff budget.`
          : `This file type does not support ${BUILDER_CONFIG.name} comment markers.`;
  const suggestion =
    reason === 'exact_change_budget_exceeded'
      ? 'Whole-file markers were kept for this target; raise the `marker` limits under `settings` to get the inline ones back.'
      : targetKind === 'sync'
        ? `Recovery will rely on backups in \`${stateRootPath}\` for this file.`
        : 'Preview output will not show in-file ownership markers for this file.';
  return {
    severity,
    label: `marker ${targetKind} target`,
    subject: targetRelativePath,
    detail,
    suggestion,
  };
}
