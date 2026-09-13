/**
 * The one vocabulary for "this happened to that file". Statuses are declared once,
 * with the one thing a call site cannot work out: whether reading the line tells
 * anyone anything. Column width falls out of the longest status, and the routine
 * check reads the same table the lines were written from.
 */

/** `true` when the line only says the run did what it was asked; the summary counts those. */
export const DETAIL_STATUSES = {
  ok: true,
  'test ok': true,
  /** A test result answered from cache rather than executed again. */
  'test ok*': true,
  patched: true,
  replaced: true,
  'file op': true,
  generated: true,
  current: true,
  deleted: true,
  restored: true,
  reset: true,
  removed: true,
  gone: true,
  'to remove': true,
  swept: true,
  skipped: false,
  kept: false,
  failed: false,
} as const satisfies Record<string, boolean>;

export type DetailStatus = keyof typeof DETAIL_STATUSES;

/** Two spaces of gutter past the longest status, so no subject touches its column. */
const STATUS_COLUMN_WIDTH =
  Math.max(...Object.keys(DETAIL_STATUSES).map((status) => status.length)) + 2;

/**
 * `status  subject (note)`, aligned into one column. The note carries what a status
 * cannot -- why this one patch was skipped -- never what the status already says. A
 * note that would read the same beside every subject is a `ReportFinding`.
 */
export function formatDetailLine(status: DetailStatus, subject: string, note?: string): string {
  return `${status.padEnd(STATUS_COLUMN_WIDTH)}${subject}${note ? ` (${note})` : ''}`;
}

/** Matched against the same padded column, so an unclassified status cannot look routine. */
export function isRoutineDetailLine(line: string): boolean {
  return Object.entries(DETAIL_STATUSES).some(
    ([status, routine]) => routine && line.startsWith(status.padEnd(STATUS_COLUMN_WIDTH)),
  );
}
