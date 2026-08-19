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
      [
        notice.absolutePath,
        notice.modId,
        notice.patchId,
        notice.operationIndex,
        notice.reason,
      ].join('|'),
      notice,
    );
  }
  return [...byKey.values()];
}

/** Reads notices back out of a cache entry, ignoring anything that is not one. */
export function readCachedPatchNotices(
  extra: Record<string, unknown> | undefined,
): PatchNotice[] | undefined {
  const cached = extra?.notices;
  return Array.isArray(cached) ? (cached as PatchNotice[]) : undefined;
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
  };
}
