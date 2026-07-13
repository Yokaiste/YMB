import { findCollectionEntries } from './scan.ts';
import { advanceStringState, type StringDelimiter } from './shared.ts';

export type NdfScalarValue =
  | { kind: 'int'; value: number; raw: string }
  | { kind: 'float'; value: number; raw: string }
  | { kind: 'bool'; value: boolean; raw: string }
  | { kind: 'string'; value: string; raw: string }
  | { kind: 'reference'; value: string; raw: string }
  | { kind: 'raw'; value: string; raw: string };

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

export function findLineCommentIndex(
  text: string,
  fromIndex: number,
  endIndex = text.length,
): number {
  const limit = Math.min(endIndex, text.length);
  let inString: StringDelimiter | undefined;
  for (let index = fromIndex; index < limit; index += 1) {
    const char = text[index] ?? '';
    if (char === '\n') {
      return -1;
    }
    const previousInString = inString;
    inString = advanceStringState(inString, text, index);
    if (previousInString || inString) {
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      return index;
    }
  }
  return -1;
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
