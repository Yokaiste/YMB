const CASE_INSENSITIVE_COMPARE_OPTIONS = { sensitivity: 'accent' } as const;

/** Config identifiers are ASCII-only and command-line matching ignores their case. */
function toSelectionIdentityKey(identifier: string): string {
  return identifier.toLowerCase();
}

/** Claim a case-insensitive config identity and return the first owner on collision. */
export function claimSelectionIdentity(
  owners: Map<string, string>,
  identifier: string,
  owner: string,
): string | undefined {
  const key = toSelectionIdentityKey(identifier);
  const existing = owners.get(key);
  if (existing === undefined) owners.set(key, owner);
  return existing;
}

function matchesSelectionFilter(filter: string, identifier: string, displayName?: string): boolean {
  return (
    toSelectionIdentityKey(filter) === toSelectionIdentityKey(identifier) ||
    (displayName !== undefined &&
      filter.localeCompare(displayName, undefined, CASE_INSENSITIVE_COMPARE_OPTIONS) === 0)
  );
}

export function matchesAnySelectionFilter(
  filters: string[],
  identifier: string,
  displayName?: string,
): boolean {
  return (
    filters.length === 0 ||
    filters.some((filter) => matchesSelectionFilter(filter, identifier, displayName))
  );
}

/** A `--mod` or `--patch` value, and the names it could have been. */
export interface UnmatchedSelectionFilter {
  option: '--mod' | '--patch';
  value: string;
  availableIds: string[];
}

interface SelectableIdentity {
  id: string;
  name: string;
}

/**
 * Filtering is exact, so a near-miss narrows the run to nothing and every command
 * then reports success -- which reads exactly like a genuinely disabled mod. A mod
 * that exists but is switched off still counts as found.
 */
export function collectUnmatchedSelectionFilters(
  option: UnmatchedSelectionFilter['option'],
  filters: readonly string[],
  candidates: readonly SelectableIdentity[],
): UnmatchedSelectionFilter[] {
  const availableIds = [...new Set(candidates.map((candidate) => candidate.id))].sort((a, b) =>
    a.localeCompare(b),
  );
  return filters
    .filter(
      (filter) =>
        !candidates.some((candidate) =>
          matchesSelectionFilter(filter, candidate.id, candidate.name),
        ),
    )
    .map((value) => ({ option, value, availableIds }));
}
