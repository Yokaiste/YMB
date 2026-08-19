import { createCooperativeYieldController } from '../async.ts';
import { ensure } from '../errors.ts';
import { findNestedFieldRange, findTemplateBlocks, findTopLevelBlocks } from '../patch/ndf/scan.ts';
import type { TopLevelBlock } from '../patch/ndf/shared.ts';
import { isNdfPath } from '../patch/ndf/validate.ts';
import {
  assertGameRelativePath,
  pathExists,
  resolveModTargetPath,
  toPathKey,
} from '../path-utils.ts';
import { countFact, timingFact } from '../report/facts.ts';
import { formatUnmatchedFilterWarnings } from '../report/findings.ts';
import { type CommandOutputLines, toCommandOutput } from '../report/output.ts';
import { formatRecordLine } from '../report/text.ts';
import { readTrackedText } from '../tracked-targets.ts';
import type { BuilderContext, SelectionInput } from '../types.ts';
import { preparePlan } from './plan.ts';
import { reportProgress, trackProgress } from './progress.ts';

interface FindQuery {
  files: string[];
  name?: string | undefined;
  type?: string | undefined;
  field?: string | undefined;
  limit: number;
}

interface FieldFilter {
  name: string;
  value: string;
}

/**
 * Answers what is actually in a file without opening a 27 MB NDF in an editor.
 * Read-only: never writes, never touches preview or recovery state.
 */
export async function runFind(
  builderPath: string | undefined,
  selection: SelectionInput,
  query: FindQuery,
): Promise<CommandOutputLines> {
  const startedAt = performance.now();
  const yieldController = createCooperativeYieldController();
  reportProgress('Preparing search');
  const plan = await preparePlan(builderPath, selection);
  const fieldFilter = parseFieldFilter(query.field);

  ensure(query.name || query.type || fieldFilter, 'CommandError', {
    absolutePath: 'find',
    reason: '`find` needs something to look for.',
    suggestion:
      'Add `--name <text>`, `--type <text>`, or `--field <Name=Value>`. Repeat `--file` to search files your patches do not already target.',
  });

  const searchFiles = await resolveSearchFiles(plan.context, query, plan.targetFiles);
  ensure(searchFiles.length > 0, 'CommandError', {
    absolutePath: 'find',
    reason: 'There are no NDF files to search.',
    suggestion:
      'Name a file with `--file GameData/...`, or select a mod whose patches already target one.',
  });

  const logs: string[] = [];
  let matchCount = 0;
  let searchedFiles = 0;
  let truncated = false;

  const progress = trackProgress('Searching game files', searchFiles.length);
  for (const relativePath of searchFiles) {
    await yieldController.maybeYield();
    progress.step(relativePath);

    const absolutePath = resolveModTargetPath(plan.context.modRoot, relativePath);
    if (!(await pathExists(absolutePath))) continue;
    searchedFiles += 1;
    const text = await readTrackedText(plan.context, absolutePath);

    for (const block of listSearchableBlocks(text)) {
      await yieldController.maybeYield();
      if (!matchesQuery(block, query, fieldFilter)) continue;
      matchCount += 1;
      if (logs.length >= query.limit) {
        truncated = true;
        continue;
      }
      logs.push(formatMatch(block, relativePath));
    }
  }

  return toCommandOutput([...formatUnmatchedFilterWarnings(plan.unmatchedFilters), ...logs], {
    summary: [
      countFact('found', [
        ['match', matchCount],
        ['searched file', searchedFiles],
      ]),
      timingFact(performance.now() - startedAt, []),
    ],
    detailHeading: 'matches',
    nextSteps: describeNextSteps(matchCount, truncated, query.limit),
  });
}

function describeNextSteps(matchCount: number, truncated: boolean, limit: number): string[] {
  if (matchCount === 0) {
    return [
      'Try a shorter `--name` or `--type`. Matching is case-insensitive and partial.',
      'Add `--file GameData/...` if the block lives in a file no patch targets yet.',
    ];
  }
  const steps = [
    'Copy a name into `selector: { kind: object, by: name, value: <name> }`.',
    'Unnamed blocks use `@type:<TypeName>` in a field or collection path.',
  ];
  if (truncated) {
    steps.unshift(
      `Only the first ${limit} matches are listed. Narrow the search or raise --limit.`,
    );
  }
  return steps;
}

/**
 * Everything a selector can name, in file order. Templates sit outside the
 * positional index `@<index>` counts, but a patch can still name one.
 */
function listSearchableBlocks(text: string): TopLevelBlock[] {
  return [...findTopLevelBlocks(text), ...findTemplateBlocks(text)].sort(
    (left, right) => left.start - right.start,
  );
}

/** One line per block: what to call it, what it is, and where it lives. */
function formatMatch(block: TopLevelBlock, relativePath: string): string {
  return formatRecordLine([block.name ?? `@type:${block.typeName}`, block.typeName, relativePath]);
}

function matchesQuery(
  block: TopLevelBlock,
  query: FindQuery,
  fieldFilter: FieldFilter | undefined,
): boolean {
  if (query.name && !containsIgnoringCase(block.name ?? '', query.name)) return false;
  if (query.type && !containsIgnoringCase(block.typeName, query.type)) return false;
  if (!fieldFilter) return true;

  const range = findNestedFieldRange(block.text, fieldFilter.name);
  if (!range) return false;
  return containsIgnoringCase(
    block.text.slice(range.valueStart, range.valueEnd),
    fieldFilter.value,
  );
}

function containsIgnoringCase(subject: string, needle: string): boolean {
  return subject.toLowerCase().includes(needle.toLowerCase());
}

/** With no `--file`, searches what the selection already targets. */
async function resolveSearchFiles(
  context: BuilderContext,
  query: FindQuery,
  plannedTargets: string[],
): Promise<string[]> {
  const candidates =
    query.files.length > 0
      ? query.files.map((file) => assertGameRelativePath(file, context.modRoot))
      : plannedTargets;
  const filesByKey = new Map<string, string>();
  for (const file of candidates.filter((candidate) => isNdfPath(candidate))) {
    const key = toPathKey(file);
    if (!filesByKey.has(key)) {
      filesByKey.set(key, file);
    }
  }
  const files = [...filesByKey.values()].sort((left, right) => left.localeCompare(right));
  if (query.files.length > 0) {
    for (const file of files) {
      const absolutePath = resolveModTargetPath(context.modRoot, file);
      ensure(await pathExists(absolutePath), 'IoError', {
        absolutePath,
        reason: `Search file \`${file}\` does not exist.`,
        suggestion: 'Check the --file path against this WARNO install and try again.',
      });
    }
  }
  return files;
}

function parseFieldFilter(field: string | undefined): FieldFilter | undefined {
  if (!field) return undefined;
  const separator = field.indexOf('=');
  ensure(separator > 0 && separator < field.length - 1, 'CommandError', {
    absolutePath: 'find',
    reason: `\`--field ${field}\` is not in \`Name=Value\` form.`,
    suggestion: 'Write it as `--field Nationalite=USSR`.',
  });
  return { name: field.slice(0, separator), value: field.slice(separator + 1) };
}
