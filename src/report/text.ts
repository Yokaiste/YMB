/**
 * The smallest pieces every YMB line is built from. Nothing here decides layout; it
 * exists so a plural, a duration, or a separator is spelled one way program-wide.
 */

export function pluralize(noun: string, count: number): string {
  if (count === 1) {
    return noun;
  }
  return /(s|x|z|ch|sh)$/.test(noun) ? `${noun}es` : `${noun}s`;
}

export function capitalize(value: string): string {
  return value.length > 0 ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
}

export function formatDurationMs(durationMs: number): string {
  if (durationMs >= 1000) {
    return `${(durationMs / 1000).toFixed(2)}s`;
  }

  return `${Math.round(durationMs)}ms`;
}

/** The one separator between a name and what it resolves to. */
const INFO_SEPARATOR = ' -> ';

/** The one separator between the parts of a single record. */
const RECORD_SEPARATOR = ' | ';

/**
 * `name -> value`, for a line that answers a question rather than recording work.
 * Several subjects sharing one name are findings -- see `findings.ts`.
 */
export function formatInfoLine(name: string, value: string): string {
  return `${name}${INFO_SEPARATOR}${value}`;
}

/** One record as its fields in order: `mod | my_pack | My Pack | on`. */
export function formatRecordLine(fields: ReadonlyArray<string | number>): string {
  return fields.map((field) => String(field)).join(RECORD_SEPARATOR);
}
