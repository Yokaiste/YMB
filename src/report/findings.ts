import type { UnmatchedSelectionFilter } from '../selection-filter.ts';
import { pluralize } from './text.ts';

/**
 * Something a command noticed that did not stop it: advice that is the same for
 * everything it applies to, and a subject that is not. Collected as data and grouped
 * on the way out, so no reporter prints the shared half once per subject. If a
 * reporter is about to write `<same words> -> <subject>` in a loop, it wants one.
 */
export interface ReportFinding {
  severity: 'warning' | 'note';
  /** Singular noun for the thing counted, such as `patch operation`. */
  label: string;
  /** What this one occurrence is about: a target path, a patch id. */
  subject: string;
  /** Where to open, when there is somewhere: `pack/config/.../ymb.patch.yaml:41`. */
  origin?: string | undefined;
  /** What was found. Often identical across a group, which the grouping exploits. */
  detail: string;
  /** The advice. Findings sharing one are a single thing to fix. */
  suggestion: string;
}

const SEVERITY_COLUMN_WIDTH = 7;
const MEMBER_INDENT = ' '.repeat(SEVERITY_COLUMN_WIDTH + 4);
const SUBGROUP_MEMBER_INDENT = ' '.repeat(SEVERITY_COLUMN_WIDTH + 6);

/** Many subjects, one thing found, one fix. */
export function toSharedFindings(
  shared: Omit<ReportFinding, 'subject'>,
  subjects: readonly string[],
): ReportFinding[] {
  return subjects.map((subject) => ({ ...shared, subject }));
}

/**
 * One block per distinct problem, with its subjects under it. Grouped first by the
 * shared fix, because that is the unit of work a reader acts on, then by what was
 * found -- one rule applied twice: never print what is common more than once.
 */
export function formatFindingGroups(findings: readonly ReportFinding[]): string[] {
  if (findings.length === 0) {
    return [];
  }

  const lines: string[] = [];
  for (const group of groupBy(findings, (finding) => [
    finding.severity,
    finding.label,
    finding.suggestion,
  ])) {
    const first = group[0];
    if (!first) continue;
    const byDetail = groupBy(group, (finding) => [finding.detail]);
    const heading = `${first.severity.padEnd(SEVERITY_COLUMN_WIDTH)}  ${group.length} ${pluralize(first.label, group.length)}:`;

    // Everything found the same thing, so it belongs beside the fix and the list
    // below is nothing but subjects.
    if (byDetail.length === 1) {
      lines.push(`${heading} ${first.detail} ${first.suggestion}`);
      lines.push(
        ...sortMembers(group).map((member) => `${MEMBER_INDENT}${describeMember(member)}`),
      );
      continue;
    }

    lines.push(`${heading} ${first.suggestion}`);
    for (const subgroup of byDetail.filter((entries) => entries.length > 1)) {
      const leader = subgroup[0];
      if (!leader) continue;
      lines.push(`${MEMBER_INDENT}${subgroup.length}x ${leader.detail}`);
      lines.push(
        ...sortMembers(subgroup).map(
          (member) => `${SUBGROUP_MEMBER_INDENT}${describeMember(member)}`,
        ),
      );
    }
    // A reason occurring once would spend a line introducing itself, so it rides with
    // its subject. Ordered together and last, in the order they appear on disk.
    const singles = byDetail.filter((entries) => entries.length === 1).flat();
    lines.push(
      ...sortMembers(singles).map(
        (member) => `${MEMBER_INDENT}${describeMember(member)}  ${member.detail}`,
      ),
    );
  }
  return lines;
}

/**
 * A live file YMB used to produce and no longer does. Whether the original went back
 * or the file was deleted is one target either way, so both share a heading.
 */
export function toObsoleteTargetFindings(
  restoredTargets: readonly string[],
  deletedTargets: readonly string[],
): ReportFinding[] {
  const shared = {
    severity: 'note',
    label: 'obsolete live file',
    suggestion: 'Nothing to do, unless a patch was meant to keep producing them.',
  } as const satisfies Omit<ReportFinding, 'subject' | 'detail'>;
  return [
    ...toSharedFindings(
      { ...shared, detail: 'YMB no longer produces this file, so its original was put back.' },
      restoredTargets,
    ),
    ...toSharedFindings(
      {
        ...shared,
        detail: 'YMB no longer produces this file and there was no original, so it was deleted.',
      },
      deletedTargets,
    ),
  ];
}

/** As many ids as help a reader recognise a typo, before `list` is the answer. */
const MAX_LISTED_IDS = 8;

/**
 * Not an error -- a command line reused across installs may name a mod one does not
 * carry -- but it must not read as success either, because narrowing to nothing
 * looks exactly like a correct run over a disabled mod.
 */
export function toUnmatchedFilterFinding(unmatched: UnmatchedSelectionFilter): ReportFinding {
  const subject = unmatched.option === '--mod' ? 'source mod' : 'patch';
  return {
    severity: 'warning',
    label: 'selection filter',
    subject: `${unmatched.option} ${unmatched.value}`,
    detail: `No ${subject} answers to \`${unmatched.value}\`, so this run was narrowed by a name nothing has.`,
    suggestion: `Check the spelling against ${describeAvailableIds(unmatched.availableIds)}`,
  };
}

/** Every command taking `--mod`/`--patch` must say this, or the one in use stays silent. */
export function formatUnmatchedFilterWarnings(
  unmatchedFilters: readonly UnmatchedSelectionFilter[],
): string[] {
  return formatFindingGroups(unmatchedFilters.map(toUnmatchedFilterFinding));
}

function describeAvailableIds(availableIds: readonly string[]): string {
  if (availableIds.length === 0) {
    return 'the project - YMB found nothing to select at all.';
  }
  if (availableIds.length > MAX_LISTED_IDS) {
    return `the ${availableIds.length} names \`list\` prints, or drop the filter.`;
  }
  return `what YMB found: ${availableIds.map((id) => `\`${id}\``).join(', ')}.`;
}

/**
 * Largest group first, then by key, so one run reads like the next. The key is JSON:
 * it cannot run two part lists together, and needs no forbidden separator character.
 */
function groupBy(
  findings: readonly ReportFinding[],
  toKeyParts: (finding: ReportFinding) => string[],
): ReportFinding[][] {
  const groups = new Map<string, ReportFinding[]>();
  for (const finding of findings) {
    const key = JSON.stringify(toKeyParts(finding));
    const group = groups.get(key) ?? [];
    group.push(finding);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
    .map(([, group]) => group);
}

/** Numeric collation, so `ymb.patch.yaml:9` sorts before `:12`. */
const MEMBER_ORDER_OPTIONS: Intl.CollatorOptions = { numeric: true };

function sortMembers(findings: readonly ReportFinding[]): ReportFinding[] {
  return [...findings].sort(
    (left, right) =>
      left.subject.localeCompare(right.subject, undefined, MEMBER_ORDER_OPTIONS) ||
      (left.origin ?? '').localeCompare(right.origin ?? '', undefined, MEMBER_ORDER_OPTIONS),
  );
}

function describeMember(finding: ReportFinding): string {
  return finding.origin ? `${finding.subject}  ${finding.origin}` : finding.subject;
}
