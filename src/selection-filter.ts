const CASE_INSENSITIVE_COMPARE_OPTIONS = { sensitivity: 'accent' } as const;

export function matchesSelectionFilter(
  filter: string,
  identifier: string,
  displayName?: string,
): boolean {
  return (
    filter.localeCompare(identifier, undefined, CASE_INSENSITIVE_COMPARE_OPTIONS) === 0 ||
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
