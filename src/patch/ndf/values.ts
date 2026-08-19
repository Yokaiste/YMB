import type { BuildScriptNdfScalar } from 'ymb/api';
import { findCollectionEntries } from './scan.ts';

/**
 * The shape a script receives, so the parser cannot drift from what `ymb/api`
 * publishes. Restating the union here let the two disagree about a `kind` in
 * whichever direction the parser was not assigned to a script's return type.
 */
type NdfScalarValue = BuildScriptNdfScalar;

export function parseNdfScalar(valueText: string): NdfScalarValue {
  const raw = valueText.trim();

  if (raw === 'True' || raw === 'False') {
    return { kind: 'bool', value: raw === 'True', raw };
  }

  const quoted = extractQuotedString(raw);
  if (quoted !== undefined) {
    return { kind: 'string', value: quoted, raw };
  }

  if (/^[+-]?\d+$/.test(raw)) {
    return { kind: 'int', value: Number(raw), raw };
  }

  if (/^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(raw) && /[.eE]/.test(raw)) {
    return { kind: 'float', value: Number(raw), raw };
  }

  if (/^[$~]\//.test(raw) || /^GUID:\{/.test(raw) || /^[A-Za-z_][A-Za-z0-9_./]*$/.test(raw)) {
    return { kind: 'reference', value: raw, raw };
  }

  return { kind: 'raw', value: raw, raw };
}

export function parseNdfList(collectionText: string): NdfScalarValue[] {
  return findCollectionEntries(collectionText).map((entry) => parseNdfScalar(entry.text));
}

function extractQuotedString(raw: string): string | undefined {
  if (raw.length < 2) {
    return undefined;
  }
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'") || raw[raw.length - 1] !== quote) {
    return undefined;
  }
  const inner = raw.slice(1, -1);
  return inner.includes(quote) ? undefined : inner;
}
