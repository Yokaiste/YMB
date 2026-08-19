import { capitalize, formatDurationMs, pluralize } from './text.ts';

/**
 * A named value, the unit every headline block is made of. Facts stay a label and a
 * value until they are printed, so no separator has to be agreed on three times and
 * a value may contain one.
 */
export interface Fact {
  label: string;
  value: string;
}

/** Drops facts with nothing to say, so a clean run does not print empty labels. */
export function collectFacts(facts: ReadonlyArray<Fact | undefined>): Fact[] {
  return facts.filter((entry): entry is Fact => entry !== undefined && entry.value.length > 0);
}

/** Labels padded into one column. Every label-beside-value line comes through here. */
export function formatFactLines(
  facts: readonly Fact[],
  options?: { indent?: string; capitalizeLabels?: boolean },
): string[] {
  const indent = options?.indent ?? '';
  const labels = facts.map((entry) =>
    options?.capitalizeLabels ? capitalize(entry.label) : entry.label,
  );
  const labelWidth = Math.max(0, ...labels.map((label) => label.length));
  return facts.map(
    (entry, index) => `${indent}${(labels[index] ?? '').padEnd(labelWidth)}  ${entry.value}`,
  );
}

/**
 * Pluralized, comma separated, empty buckets dropped. The automatic plural only
 * suits a label whose last word is its noun; pass one explicitly for anything else.
 */
export function countFact(
  label: string,
  counts: ReadonlyArray<readonly [itemLabel: string, count: number, pluralLabel?: string]>,
): Fact {
  const parts = counts
    .filter(([, count]) => count > 0)
    .map(([itemLabel, count, pluralLabel]) =>
      count === 1 || !pluralLabel
        ? `${count} ${pluralize(itemLabel, count)}`
        : `${count} ${pluralLabel}`,
    );
  return { label, value: parts.length > 0 ? parts.join(', ') : 'nothing' };
}

export function timingFact(
  totalDurationMs: number,
  stages: ReadonlyArray<readonly [label: string, durationMs: number]>,
): Fact {
  const breakdown = stages
    .map(([label, durationMs]) => `${label} ${formatDurationMs(durationMs)}`)
    .join(', ');
  return {
    label: 'took',
    value: `${formatDurationMs(totalDurationMs)}${breakdown ? ` (${breakdown})` : ''}`,
  };
}
