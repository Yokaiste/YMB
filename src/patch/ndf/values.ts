import type { BuildScriptNdfScalar } from 'ymb/api';
import { advanceStringState, type StringDelimiter } from './chars.ts';
import { stripComments } from './comments.ts';
import { findCollectionEntries } from './scan.ts';

/**
 * The shape a script receives, so the parser cannot drift from what `ymb/api`
 * publishes. Restating the union here let the two disagree about a `kind` in
 * whichever direction the parser was not assigned to a script's return type.
 */
type NdfScalarValue = BuildScriptNdfScalar;

export function parseNdfScalar(valueText: string): NdfScalarValue {
  const raw = valueText.trim();
  const code = stripComments(raw).trim();

  if (/^(?:true|false)$/i.test(code)) {
    return { kind: 'bool', value: code.toLowerCase() === 'true', raw };
  }

  const quoted = extractQuotedString(code);
  if (quoted !== undefined) {
    return { kind: 'string', value: quoted, raw };
  }

  if (/^[+-]?\d+$/.test(code) && Number.isSafeInteger(Number(code))) {
    return { kind: 'int', value: Number(code), raw };
  }

  if (
    /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(code) &&
    /[.eE]/.test(code) &&
    Number.isFinite(Number(code))
  ) {
    return { kind: 'float', value: Number(code), raw };
  }

  if (/^[$~]\//.test(code) || /^GUID:\{/.test(code) || /^[A-Za-z_][A-Za-z0-9_./]*$/.test(code)) {
    return { kind: 'reference', value: code, raw };
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
  let inString: StringDelimiter | undefined = quote;
  for (let index = 1; index < raw.length; index += 1) {
    inString = advanceStringState(inString, raw, index);
    if (!inString) {
      return index === raw.length - 1 ? raw.slice(1, -1).replace(/\\(['"\\])/g, '$1') : undefined;
    }
  }
  return undefined;
}
