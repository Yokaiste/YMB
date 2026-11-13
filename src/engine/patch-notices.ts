import { describeOperationLocation } from '../errors.ts';
import { toDisplayPath } from '../path-utils.ts';
import type { ReportFinding } from '../report/findings.ts';
import type { PatchNotice } from '../types.ts';

/**
 * One target's contributions can be applied twice in a run -- a per-mod preview then
 * the merged sequence -- and a cached result carries the notices of the run that
 * produced it, so everything gathering notices dedupes them.
 */
export function dedupePatchNotices(notices: readonly PatchNotice[]): PatchNotice[] {
  const byKey = new Map<string, PatchNotice>();
  for (const notice of notices) {
    byKey.set(
      JSON.stringify([
        notice.absolutePath,
        notice.modId,
        notice.patchId,
        notice.operationIndex,
        notice.reason,
        notice.suggestion,
        notice.target,
      ]),
      notice,
    );
  }
  return [...byKey.values()];
}

/** Invalid metadata makes the whole cached patch a miss so its notices can be recomputed. */
export function readCachedPatchNotices(
  extra: Record<string, unknown> | undefined,
): PatchNotice[] | undefined {
  const cached = extra?.notices;
  if (cached === undefined) return [];
  return Array.isArray(cached) && cached.every(isPatchNotice) ? cached : undefined;
}

function isPatchNotice(value: unknown): value is PatchNotice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const notice = value as Record<string, unknown>;
  return (
    ['absolutePath', 'modId', 'modName', 'patchId', 'reason', 'suggestion'].every(
      (key) => typeof notice[key] === 'string',
    ) &&
    typeof notice.operationIndex === 'number' &&
    Number.isSafeInteger(notice.operationIndex) &&
    notice.operationIndex >= 0 &&
    ['patchConfigPath', 'target'].every(
      (key) => notice[key] === undefined || typeof notice[key] === 'string',
    ) &&
    (notice.operationLine === undefined ||
      (typeof notice.operationLine === 'number' &&
        Number.isSafeInteger(notice.operationLine) &&
        notice.operationLine > 0))
  );
}

/**
 * The fix is what a group has in common; the patch, line, and finding are each
 * notice's own. There is no second per-notice format: a notice is a finding.
 */
export function toPatchReportFinding(notice: PatchNotice, baseDirectory?: string): ReportFinding {
  return {
    severity: 'warning',
    label: 'patch operation',
    subject: notice.patchId,
    origin: describeOperationLocation({
      operationIndex: notice.operationIndex,
      patchConfigPath:
        notice.patchConfigPath === undefined
          ? undefined
          : toDisplayPath(notice.patchConfigPath, baseDirectory),
      operationLine: notice.operationLine,
    }),
    detail: notice.reason,
    suggestion: notice.suggestion,
    target: notice.target,
    targetFile: toDisplayPath(notice.absolutePath).replace(/^.*?((?:GameData|CommonData)\/)/, '$1'),
  };
}
